import type {
  AssistantMessageEvent,
  CompactionEvent,
  EventLoc,
  FileChangeEvent,
  ReasoningEvent,
  SyntheticMessageEvent,
  SystemEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TurnBoundaryEvent,
  UserMessageEvent,
} from '../schema.js';
import { newParserMeta, type ParseCtx, type ParserStateBase, type TraceAdapter } from '../adapter.js';
import {
  classifyTool,
  oneLine,
  parseTimestampMs,
  toolSummary,
  truncate,
} from '../util.js';

interface PendingCall {
  eventId: string;
  toolName: string;
  timestampMs?: number;
}

export interface CodexState extends ParserStateBase {
  requestIndex: number;
  currentTurnId?: string;
  currentModel?: string;
  pendingCalls: Map<string, PendingCall>;
  firstUserTitle?: string;
  /** True once a v1+ turn_context line has been seen (v0 rollouts have none). */
  sawTurnContext: boolean;
}

/**
 * Codex CLI rollout adapter — handles three on-disk generations:
 *  - v0 (2025-09, bare lines: no `payload` wrapper, no turn_context)
 *  - v1 (2025-10+ cli 0.45: {timestamp, ordinal, type, payload}, function_call)
 *  - v2 (0.148+: custom_tool_call "exec", turn_context.turn_id)
 * See docs/trace-format-research.md §2.
 */
export class CodexAdapter implements TraceAdapter<CodexState> {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  detect(headLines: unknown[]): boolean {
    for (const line of headLines) {
      if (!line || typeof line !== 'object') continue;
      const o = line as Record<string, any>;
      // v1/v2: wrapped lines.
      if (
        typeof o.type === 'string' &&
        o.payload &&
        typeof o.payload === 'object' &&
        (o.type === 'session_meta' || o.type === 'response_item' || o.type === 'turn_context' || o.type === 'event_msg')
      ) {
        return true;
      }
      // v0: bare lines.
      if (o.record_type === 'state') return true;
      if (o.type === 'message' && (o.role === 'user' || o.role === 'assistant') && Array.isArray(o.content) && o.payload === undefined) {
        return true;
      }
      if (typeof o.id === 'string' && typeof o.timestamp === 'string' && 'instructions' in o && o.type === undefined) {
        return true; // bare session header
      }
    }
    return false;
  }

  createState(): CodexState {
    return { seq: 0, meta: newParserMeta(), requestIndex: -1, pendingCalls: new Map(), sawTurnContext: false };
  }

  parseLine(line: unknown, loc: EventLoc, state: CodexState, ctx: ParseCtx): TraceEvent[] {
    if (!line || typeof line !== 'object') return [];
    const o = line as Record<string, any>;
    const provider = 'codex' as const;
    // v0 rollouts have no payload wrapper — the line itself is the item.
    const wrapped = o.payload !== undefined && typeof o.payload === 'object';
    const p = (wrapped ? o.payload : o) as Record<string, any>;
    const lineType = typeof o.type === 'string' ? o.type : wrapped ? undefined : inferV0Type(o);
    const timestamp = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    const timestampMs = parseTimestampMs(timestamp);
    const base = {
      timestamp,
      timestampMs,
      agentId: 'main',
      source: { provider, rawType: String(lineType ?? 'unknown') },
      loc,
    };
    const mkEvent = (over: Record<string, unknown>): TraceEvent =>
      ({ ...base, id: `e${state.seq}`, seq: state.seq++, ...over } as TraceEvent);

    if (timestamp && (!state.meta.startedAt || timestamp < state.meta.startedAt)) state.meta.startedAt = timestamp;
    if (timestamp && (!state.meta.endedAt || timestamp > state.meta.endedAt)) state.meta.endedAt = timestamp;

    const events: TraceEvent[] = [];

    switch (lineType) {
      case 'session_meta': {
        if (typeof p.id === 'string') state.meta.sessionId = p.id;
        if (typeof p.cwd === 'string') state.meta.cwd = p.cwd;
        if (typeof p.originator === 'string') state.meta.notes.push(`originator: ${p.originator}`);
        if (p.git && typeof p.git === 'object') {
          if (typeof p.git.branch === 'string') state.meta.gitBranch = p.git.branch;
          if (typeof p.git.repository_url === 'string') state.meta.gitRepo = p.git.repository_url;
        }
        break;
      }

      case 'turn_context': {
        state.sawTurnContext = true;
        state.requestIndex += 1;
        state.currentTurnId = typeof p.turn_id === 'string' ? p.turn_id : `req-${state.requestIndex + 1}`;
        if (typeof p.model === 'string') {
          state.currentModel = p.model;
          state.meta.models.add(p.model);
        }
        if (typeof p.collaboration_mode === 'string' && p.collaboration_mode && p.collaboration_mode !== 'none') {
          const note = `collaboration_mode: ${p.collaboration_mode}`;
          if (!state.meta.notes.includes(note)) state.meta.notes.push(note);
        }
        state.meta.usage.modelRequests = state.requestIndex + 1;
        events.push(
          mkEvent({
            kind: 'turn_boundary',
            requestIndex: state.requestIndex,
            model: state.currentModel,
            turnId: state.currentTurnId,
            source: { provider, rawType: 'turn_context' },
          }) as TurnBoundaryEvent,
        );
        break;
      }

      case 'response_item': {
        events.push(...this.parseResponseItem(p, mkEvent, state, ctx, base));
        break;
      }

      case 'event_msg': {
        events.push(...this.parseEventMsg(p, mkEvent, state, ctx, base));
        break;
      }

      case 'compacted': {
        events.push(
          mkEvent({
            kind: 'compaction',
            text: typeof p.message === 'string' && p.message ? oneLine(p.message, 200) : 'Context compacted',
            source: { provider, rawType: 'compacted' },
          }) as CompactionEvent,
        );
        break;
      }

      case 'world_state': {
        events.push(
          mkEvent({
            kind: 'system',
            subtype: 'world_state',
            level: 'info',
            source: { provider, rawType: 'world_state' },
          }) as SystemEvent,
        );
        break;
      }

      case 'state': {
        // v0 bookkeeping line.
        state.meta.skippedTypes['state'] = (state.meta.skippedTypes['state'] ?? 0) + 1;
        break;
      }

      default: {
        // v0 flat items: message / function_call / reasoning / …
        if (!wrapped && isV0Item(p)) {
          events.push(...this.parseResponseItem(p, mkEvent, state, ctx, base));
        } else {
          events.push(
            mkEvent({
              kind: 'unknown',
              rawType: String(lineType ?? 'untyped'),
              note: 'Unrecognized Codex line type',
            }) as TraceEvent,
          );
        }
      }
    }

    return events;
  }

  finalize(state: CodexState): TraceEvent[] {
    if (state.meta.badLines > 0) state.meta.warnings.push(`${state.meta.badLines} unparseable line(s)`);
    if (!state.meta.title && state.firstUserTitle) state.meta.title = state.firstUserTitle;
    if (!state.meta.project && state.meta.cwd) {
      state.meta.project = state.meta.cwd.split('/').filter(Boolean).pop() ?? state.meta.cwd;
    }
    return [];
  }

  private requestCtx(state: CodexState): { requestIndex?: number; turnId?: string; model?: string } {
    if (state.requestIndex < 0) return {};
    return {
      requestIndex: state.requestIndex,
      turnId: state.currentTurnId,
      model: state.currentModel,
    };
  }

  private parseResponseItem(
    p: Record<string, any>,
    mkEvent: (over: Record<string, unknown>) => TraceEvent,
    state: CodexState,
    ctx: ParseCtx,
    base: Record<string, unknown>,
  ): TraceEvent[] {
    const provider = 'codex' as const;
    const events: TraceEvent[] = [];
    const req = this.requestCtx(state);
    const rawType = 'response_item';

    switch (p?.type) {
      case 'message': {
        const text = joinContentText(p.content);
        const t = truncate(text, ctx.textLimit);
        if (p.role === 'user') {
          const trimmed = text.trimStart();
          const injected = trimmed.startsWith('<') || trimmed.startsWith('# Files mentioned');
          if (injected && !trimmed.startsWith('# Files mentioned')) {
            events.push(
              mkEvent({
                ...base,
                kind: 'synthetic_message',
                text: t.text,
                truncated: t.truncated,
                syntheticKind: 'injected',
                source: { provider, rawType, rawSubtype: 'message:user' },
              }) as SyntheticMessageEvent,
            );
          } else {
            // v0 rollouts have no turn_context — each real user message starts a request.
            if (!state.sawTurnContext) {
              state.requestIndex += 1;
              state.currentTurnId = `req-${state.requestIndex + 1}`;
              state.meta.usage.modelRequests = state.requestIndex + 1;
              events.push(
                mkEvent({
                  ...base,
                  kind: 'turn_boundary',
                  requestIndex: state.requestIndex,
                  turnId: state.currentTurnId,
                  derived: true,
                  source: { provider, rawType: 'response_item', rawSubtype: 'derived:turn_boundary' },
                }) as TurnBoundaryEvent,
              );
            }
            if (!state.firstUserTitle && text.trim() && !trimmed.startsWith('# Files mentioned')) {
              state.firstUserTitle = oneLine(text, 120);
            }
            events.push(
              mkEvent({
                ...base,
                kind: 'user_message',
                text: t.text,
                truncated: t.truncated,
                source: { provider, rawType, rawSubtype: 'message:user' },
                ...this.requestCtx(state),
              }) as UserMessageEvent,
            );
          }
        } else if (p.role === 'assistant') {
          if (text.trim()) {
            events.push(
              mkEvent({
                ...base,
                kind: 'assistant_message',
                text: t.text,
                truncated: t.truncated,
                messageId: typeof p.id === 'string' ? p.id : undefined,
                source: { provider, rawType, rawSubtype: 'message:assistant' },
                ...req,
              }) as AssistantMessageEvent,
            );
          }
        } else {
          events.push(
            mkEvent({
              ...base,
              kind: 'unknown',
              rawType: `message:${String(p.role)}`,
              note: 'Unrecognized message role',
              source: { provider, rawType, rawSubtype: `message:${String(p.role)}` },
            }) as TraceEvent,
          );
        }
        break;
      }

      case 'reasoning': {
        const summary = Array.isArray(p.summary)
          ? p.summary.map((s: any) => (typeof s?.text === 'string' ? s.text : '')).join('\n')
          : '';
        const text = summary || (typeof p.content === 'string' ? p.content : '');
        if (text.trim()) {
          const t = truncate(text, ctx.textLimit);
          events.push(
            mkEvent({
              ...base,
              kind: 'reasoning',
              text: t.text,
              truncated: t.truncated,
              source: { provider, rawType, rawSubtype: 'reasoning' },
              ...req,
            }) as ReasoningEvent,
          );
        }
        break;
      }

      case 'function_call': {
        const toolName = String(p.name ?? 'unknown');
        const { category, mcpServer } = classifyTool(toolName);
        let input: unknown = p.arguments;
        if (typeof p.arguments === 'string') {
          try {
            input = JSON.parse(p.arguments);
          } catch {
            input = p.arguments;
          }
        }
        const callId = String(p.call_id ?? `missing-${state.seq}`);
        state.pendingCalls.set(callId, {
          eventId: `e${state.seq}`,
          toolName,
          timestampMs: base.timestampMs as number | undefined,
        });
        events.push(
          mkEvent({
            ...base,
            kind: 'tool_call',
            callId,
            toolName,
            toolCategory: category,
            mcpServer,
            input,
            summary: toolSummary(toolName, input),
            source: { provider, rawType, rawSubtype: 'function_call' },
            ...req,
          }) as ToolCallEvent,
        );
        break;
      }

      case 'custom_tool_call': {
        const toolName = String(p.name ?? 'unknown');
        const { category, mcpServer } = classifyTool(toolName);
        const rawInput = typeof p.input === 'string' ? p.input : p.input;
        const summary =
          typeof rawInput === 'string' ? extractExecCommand(rawInput) : toolSummary(toolName, rawInput);
        const callId = String(p.call_id ?? `missing-${state.seq}`);
        state.pendingCalls.set(callId, {
          eventId: `e${state.seq}`,
          toolName,
          timestampMs: base.timestampMs as number | undefined,
        });
        events.push(
          mkEvent({
            ...base,
            kind: 'tool_call',
            callId,
            toolName,
            toolCategory: category,
            mcpServer,
            input: typeof rawInput === 'string' ? truncate(rawInput, ctx.outputLimit).text : rawInput,
            summary,
            truncated: typeof rawInput === 'string' && rawInput.length > ctx.outputLimit || undefined,
            source: { provider, rawType, rawSubtype: 'custom_tool_call' },
            ...req,
          }) as ToolCallEvent,
        );
        break;
      }

      case 'local_shell_call': {
        const toolName = 'shell';
        const cmd = Array.isArray(p.action?.command) ? p.action.command.join(' ') : String(p.action?.command ?? '');
        const callId = String(p.call_id ?? `missing-${state.seq}`);
        state.pendingCalls.set(callId, {
          eventId: `e${state.seq}`,
          toolName,
          timestampMs: base.timestampMs as number | undefined,
        });
        events.push(
          mkEvent({
            ...base,
            kind: 'tool_call',
            callId,
            toolName,
            toolCategory: 'bash',
            input: p.action ?? undefined,
            summary: cmd,
            source: { provider, rawType, rawSubtype: 'local_shell_call' },
            ...req,
          }) as ToolCallEvent,
        );
        break;
      }

      case 'web_search_call': {
        const toolName = 'web_search';
        const callId = String(p.call_id ?? `missing-${state.seq}`);
        state.pendingCalls.set(callId, {
          eventId: `e${state.seq}`,
          toolName,
          timestampMs: base.timestampMs as number | undefined,
        });
        events.push(
          mkEvent({
            ...base,
            kind: 'tool_call',
            callId,
            toolName,
            toolCategory: 'web',
            input: p.action ?? undefined,
            summary: typeof p.action?.query === 'string' ? p.action.query : 'web search',
            source: { provider, rawType, rawSubtype: 'web_search_call' },
            ...req,
          }) as ToolCallEvent,
        );
        break;
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = String(p.call_id ?? '');
        const pending = state.pendingCalls.get(callId);
        const timestampMs = base.timestampMs as number | undefined;
        const durationMs =
          pending?.timestampMs !== undefined && timestampMs !== undefined && timestampMs >= pending.timestampMs
            ? timestampMs - pending.timestampMs
            : undefined;
        let outputText = '';
        if (p.type === 'custom_tool_call_output') {
          // output is a JSON string of content blocks.
          let parsed: unknown = p.output;
          if (typeof p.output === 'string') {
            try {
              parsed = JSON.parse(p.output);
            } catch {
              parsed = p.output;
            }
          }
          outputText = joinContentText(parsed);
        } else {
          outputText = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        }
        const isError = outputText.startsWith('error:') || outputText.toLowerCase().includes('"error"');
        const t = truncate(outputText, ctx.outputLimit);
        events.push(
          mkEvent({
            ...base,
            kind: 'tool_result',
            callId,
            toolName: pending?.toolName,
            isError: isError || undefined,
            resultKind: pending?.toolName === 'shell' || pending?.toolName === 'exec' ? 'bash' : 'text',
            output: t.text,
            truncated: t.truncated || undefined,
            durationMs,
            source: {
              provider,
              rawType: 'response_item',
              rawSubtype: p.type,
            },
          }) as ToolResultEvent,
        );
        if (pending) state.pendingCalls.delete(callId);
        break;
      }

      default: {
        events.push(
          mkEvent({
            ...base,
            kind: 'unknown',
            rawType: `response_item:${String(p?.type ?? 'untyped')}`,
            note: 'Unrecognized response_item payload',
          }) as TraceEvent,
        );
      }
    }
    return events;
  }

  private parseEventMsg(
    p: Record<string, any>,
    mkEvent: (over: Record<string, unknown>) => TraceEvent,
    state: CodexState,
    _ctx: ParseCtx,
    base: Record<string, unknown>,
  ): TraceEvent[] {
    const provider = 'codex' as const;
    const events: TraceEvent[] = [];

    switch (p?.type) {
      case 'token_count': {
        // Cumulative usage — take the latest value.
        const totals = p.info?.total_token_usage;
        if (totals && typeof totals === 'object') {
          const u = state.meta.usage;
          u.inputTokens = num(totals.input_tokens);
          u.outputTokens = num(totals.output_tokens);
          u.cachedInputTokens = num(totals.cached_input_tokens);
          u.cacheWriteTokens = num(totals.cache_write_input_tokens);
          u.reasoningTokens = num(totals.reasoning_output_tokens);
          u.totalTokens = num(totals.total_tokens);
          u.modelRequests = state.requestIndex + 1;
        }
        state.meta.skippedTypes['token_count'] = (state.meta.skippedTypes['token_count'] ?? 0) + 1;
        break;
      }

      case 'item_completed': {
        const item = p.item;
        if (item?.type === 'FileChange' && item.changes && typeof item.changes === 'object') {
          for (const [path, change] of Object.entries(item.changes as Record<string, any>)) {
            const changeType =
              change?.type === 'add' ? 'add' : change?.type === 'delete' ? 'delete' : 'modify';
            events.push(
              mkEvent({
                ...base,
                kind: 'file_change',
                path,
                changeType,
                causedByEventId: undefined,
                source: { provider, rawType: 'event_msg', rawSubtype: 'item_completed:FileChange' },
              }) as FileChangeEvent,
            );
          }
        } else if (item?.type === 'ContextCompaction') {
          events.push(
            mkEvent({
              ...base,
              kind: 'compaction',
              text: 'Context compacted',
              source: { provider, rawType: 'event_msg', rawSubtype: 'item_completed:ContextCompaction' },
            }) as CompactionEvent,
          );
        }
        // Other item types (AgentMessage / Reasoning / McpToolCall / …) duplicate
        // response_item data — intentionally not re-emitted.
        state.meta.skippedTypes['item_completed'] = (state.meta.skippedTypes['item_completed'] ?? 0) + 1;
        break;
      }

      case 'task_started':
      case 'task_complete':
      case 'thread_settings_applied':
      case 'turn_aborted': {
        events.push(
          mkEvent({
            ...base,
            kind: 'system',
            subtype: p.type,
            level: p.type === 'turn_aborted' ? 'warn' : 'info',
            source: { provider, rawType: 'event_msg', rawSubtype: p.type },
          }) as SystemEvent,
        );
        break;
      }

      default: {
        // Streaming deltas and other noise — summarized, not evented.
        state.meta.skippedTypes[`event_msg:${String(p?.type ?? 'untyped')}`] =
          (state.meta.skippedTypes[`event_msg:${String(p?.type ?? 'untyped')}`] ?? 0) + 1;
      }
    }
    return events;
  }
}

/** v0 rollouts: a bare header line {id, timestamp, instructions} acts as session_meta. */
function inferV0Type(o: Record<string, any>): string | undefined {
  if (o.record_type === 'state') return 'state';
  if (o.type !== undefined) return undefined; // typed lines handled by the switch
  if (typeof o.id === 'string' && typeof o.timestamp === 'string' && 'instructions' in o) return 'session_meta';
  return undefined;
}

/** v0 rollouts: flat item lines that parseResponseItem understands. */
function isV0Item(p: Record<string, any>): boolean {
  if (typeof p.type !== 'string') return false;
  return (
    p.type === 'message' ||
    p.type === 'reasoning' ||
    p.type === 'function_call' ||
    p.type === 'function_call_output' ||
    p.type === 'custom_tool_call' ||
    p.type === 'custom_tool_call_output' ||
    p.type === 'local_shell_call' ||
    p.type === 'web_search_call'
  );
}

function joinContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === 'string' ? b.text : typeof b === 'string' ? b : ''))
      .join('\n');
  }
  return '';
}

/** Extract the shell command from a unified-exec JS payload (best effort). */
function extractExecCommand(js: string): string {
  const m = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(js);
  if (m) {
    try {
      const unescaped = JSON.parse(`"${m[1]}"`);
      return oneLine(unescaped, 300);
    } catch {
      /* fall through */
    }
  }
  const m2 = /'cmd'\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(js);
  if (m2) return oneLine(m2[1], 300);
  return oneLine(js, 200);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
