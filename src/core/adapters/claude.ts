import type {
  AssistantMessageEvent,
  CompactionEvent,
  ErrorEvent,
  EventLoc,
  FileChangeEvent,
  ReasoningEvent,
  StructuredPatch,
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
  countPatchLines,
  emptyUsage,
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

export interface ClaudeState extends ParserStateBase {
  /** uuid → line kind, used to derive request boundaries via parentUuid chains. */
  uuidKinds: Map<string, string>;
  /** message.id → already-counted usage (blocks of one response share usage). */
  countedMessageIds: Set<string>;
  pendingCalls: Map<string, PendingCall>;
  requestIndex: number;
  currentTurnId?: string;
  firstUserTitle?: string;
}

const CONTINUATION_PREFIXES = [
  '(continuing)',
  'continue from where you left off',
  'your response above was cut off',
  'continue the conversation',
];

/** Claude Code JSONL adapter — format researched from CLI v2.1.270 (see docs/trace-format-research.md §1). */
export class ClaudeAdapter implements TraceAdapter<ClaudeState> {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code';

  detect(headLines: unknown[]): boolean {
    let hits = 0;
    for (const line of headLines) {
      if (!line || typeof line !== 'object') continue;
      const o = line as Record<string, unknown>;
      if (
        (o.type === 'user' || o.type === 'assistant' || o.type === 'system') &&
        typeof o.sessionId === 'string' &&
        typeof o.uuid === 'string' &&
        o.message !== undefined
      ) {
        hits++;
      }
    }
    return hits > 0;
  }

  createState(): ClaudeState {
    return {
      seq: 0,
      meta: newParserMeta(),
      uuidKinds: new Map(),
      countedMessageIds: new Set(),
      pendingCalls: new Map(),
      requestIndex: -1,
    };
  }

  parseLine(line: unknown, loc: EventLoc, state: ClaudeState, ctx: ParseCtx): TraceEvent[] {
    if (!line || typeof line !== 'object') return [];
    const o = line as Record<string, any>;
    const provider = 'claude-code' as const;
    const agentId = o.isSidechain === true ? 'agent:sidechain' : 'main';
    const timestamp = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    const timestampMs = parseTimestampMs(timestamp);
    const base = {
      timestamp,
      timestampMs,
      agentId,
      source: { provider, rawType: String(o.type ?? 'unknown') },
      loc,
    };
    const mkEvent = (over: Record<string, unknown>): TraceEvent =>
      ({ ...base, id: `e${state.seq}`, seq: state.seq++, ...over } as TraceEvent);

    // Session-level metadata available on most lines.
    if (!state.meta.sessionId && typeof o.sessionId === 'string') state.meta.sessionId = o.sessionId;
    if (!state.meta.cwd && typeof o.cwd === 'string') state.meta.cwd = o.cwd;
    if (!state.meta.gitBranch && typeof o.gitBranch === 'string') state.meta.gitBranch = o.gitBranch;
    if (timestamp && (!state.meta.startedAt || timestamp < state.meta.startedAt)) state.meta.startedAt = timestamp;
    if (timestamp && (!state.meta.endedAt || timestamp > state.meta.endedAt)) state.meta.endedAt = timestamp;

    const events: TraceEvent[] = [];

    switch (o.type) {
      case 'user': {
        state.uuidKinds.set(String(o.uuid), 'user');
        const content = o.message?.content;
        if (typeof content === 'string') {
          events.push(...this.parseUserString(o, content, false, mkEvent, state, ctx));
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'tool_result') {
              events.push(...this.parseToolResult(o, block, mkEvent, state, ctx));
            }
          }
          if (events.length === 0) {
            // No tool_result blocks: a normal message with text and/or pasted
            // images (e.g. a screenshot + caption). These are REAL user input
            // — treat them exactly like string content.
            const text = content
              .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
              .join('\n')
              .trim();
            const hasImages = content.some((b: any) => b?.type === 'image');
            if (text || hasImages) {
              events.push(...this.parseUserString(o, text || '(image message)', hasImages, mkEvent, state, ctx));
            }
          }
        }
        break;
      }

      case 'assistant': {
        const msg = o.message ?? {};
        const model = typeof msg.model === 'string' ? msg.model : undefined;
        if (model) state.meta.models.add(model);

        // Usage is repeated on every block of the same response — count once per message.id.
        const messageId = typeof msg.id === 'string' ? msg.id : undefined;
        if (msg.usage && messageId) {
          if (!state.countedMessageIds.has(messageId)) {
            state.countedMessageIds.add(messageId);
            addUsage(state.meta.usage, msg.usage);
          }
        } else if (msg.usage) {
          addUsage(state.meta.usage, msg.usage);
        }

        if (o.isApiErrorMessage) {
          const message = oneLine(
            typeof o.error?.message === 'string' ? o.error.message : JSON.stringify(o.error ?? 'API error'),
            500,
          );
          events.push(
            mkEvent({ kind: 'error', message, source: { provider, rawType: 'assistant', rawSubtype: 'api_error' } }) as ErrorEvent,
          );
          state.uuidKinds.set(String(o.uuid), 'assistant');
          break;
        }

        // Request boundary: an assistant line whose parent is a user line (or has no
        // parent we know) starts a new model request.
        const parentKind = o.parentUuid ? state.uuidKinds.get(String(o.parentUuid)) : 'user';
        if (parentKind === 'user' || parentKind === undefined) {
          state.requestIndex += 1;
          state.currentTurnId = `req-${state.requestIndex + 1}`;
        }
        const requestIndex = Math.max(0, state.requestIndex);
        const turnId = state.currentTurnId ?? `req-${requestIndex + 1}`;
        state.meta.usage.modelRequests = state.requestIndex + 1;
        if (parentKind === 'user' || parentKind === undefined) {
          // Derived boundary event so the UI renders uniform request dividers
          // (Codex provides these natively via turn_context lines).
          events.push(
            mkEvent({
              kind: 'turn_boundary',
              requestIndex,
              model,
              turnId,
              derived: true,
              source: { provider, rawType: 'assistant', rawSubtype: 'derived:turn_boundary' },
            }) as TurnBoundaryEvent,
          );
        }

        const blocks = Array.isArray(msg.content) ? msg.content : [];
        let emitted = 0;
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking') {
            const text = typeof block.thinking === 'string' ? block.thinking : '';
            if (!text) continue;
            const t = truncate(text, ctx.textLimit);
            events.push(
              mkEvent({
                kind: 'reasoning',
                text: t.text,
                truncated: t.truncated,
                requestIndex,
                turnId,
                model,
              }) as ReasoningEvent,
            );
            emitted++;
          } else if (block.type === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            if (!text.trim()) continue;
            const t = truncate(text, ctx.textLimit);
            events.push(
              mkEvent({
                kind: 'assistant_message',
                text: t.text,
                truncated: t.truncated,
                stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
                messageId,
                requestIndex,
                turnId,
                model,
              }) as AssistantMessageEvent,
            );
            emitted++;
          } else if (block.type === 'tool_use') {
            const toolName = String(block.name ?? 'unknown');
            const { category, mcpServer } = classifyTool(toolName);
            const input = block.input ?? undefined;
            const callId = String(block.id ?? `missing-${state.seq}`);
            const eventId = `e${state.seq}`;
            events.push(
              mkEvent({
                kind: 'tool_call',
                callId,
                toolName,
                toolCategory: category,
                mcpServer,
                input: maybeTruncateInput(input, ctx),
                summary: toolSummary(toolName, input),
                requestIndex,
                turnId,
                model,
              }) as ToolCallEvent,
            );
            state.pendingCalls.set(callId, { eventId, toolName, timestampMs });
            emitted++;
          }
        }
        // Container lines with no visible blocks still register the uuid.
        state.uuidKinds.set(String(o.uuid), 'assistant');
        void emitted;
        break;
      }

      case 'system': {
        const subtype = typeof o.subtype === 'string' ? o.subtype : undefined;
        if (subtype === 'api_error') {
          const message = oneLine(
            typeof o.error?.message === 'string' ? o.error.message : JSON.stringify(o.error ?? 'api_error'),
            500,
          );
          events.push(
            mkEvent({
              kind: 'error',
              message,
              retryAttempt: typeof o.retryAttempt === 'number' ? o.retryAttempt : undefined,
              source: { provider, rawType: 'system', rawSubtype: subtype },
            }) as ErrorEvent,
          );
        } else if (subtype === 'compact_boundary') {
          events.push(
            mkEvent({
              kind: 'compaction',
              text: typeof o.content === 'string' ? o.content : 'Conversation compacted',
              source: { provider, rawType: 'system', rawSubtype: subtype },
            }) as CompactionEvent,
          );
        } else {
          events.push(
            mkEvent({
              kind: 'system',
              subtype,
              text: typeof o.content === 'string' ? oneLine(o.content, 300) : undefined,
              level: 'info',
              source: { provider, rawType: 'system', rawSubtype: subtype },
            }) as SystemEvent,
          );
        }
        break;
      }

      case 'attachment': {
        const at = o.attachment ?? {};
        const subtype = typeof at.type === 'string' ? at.type : 'unknown';
        const text =
          typeof at.text === 'string'
            ? oneLine(at.text, 200)
            : typeof at.filename === 'string'
              ? `file: ${at.filename}`
              : undefined;
        events.push(
          mkEvent({
            kind: 'system',
            subtype: `attachment:${subtype}`,
            text,
            level: 'info',
            source: { provider, rawType: 'attachment', rawSubtype: subtype },
          }) as SystemEvent,
        );
        break;
      }

      case 'queue-operation': {
        events.push(
          mkEvent({
            kind: 'system',
            subtype: `queue:${String(o.operation ?? 'unknown')}`,
            level: 'info',
            source: { provider, rawType: 'queue-operation' },
          }) as SystemEvent,
        );
        break;
      }

      case 'mode': {
        // No timestamp on these lines, but permission-mode changes are semantically
        // interesting — keep as system events (they render in sequence order).
        events.push(
          mkEvent({
            kind: 'system',
            subtype: `mode:${String(o.mode ?? 'unknown')}`,
            level: 'info',
            source: { provider, rawType: 'mode' },
          }) as SystemEvent,
        );
        break;
      }

      case 'custom-title': {
        if (typeof o.customTitle === 'string' && o.customTitle) state.meta.title = o.customTitle;
        state.meta.skippedTypes['custom-title'] = (state.meta.skippedTypes['custom-title'] ?? 0) + 1;
        break;
      }

      case 'last-prompt':
      case 'atis-latch': {
        // Pure UI-recovery bookkeeping, no timestamp, no execution semantics.
        state.meta.skippedTypes[o.type] = (state.meta.skippedTypes[o.type] ?? 0) + 1;
        break;
      }

      default: {
        events.push(
          mkEvent({
            kind: 'unknown',
            rawType: typeof o.type === 'string' ? o.type : 'untyped',
            note: 'Unrecognized Claude Code line type',
          }) as TraceEvent,
        );
      }
    }

    return events;
  }

  finalize(state: ClaudeState): TraceEvent[] {
    if (state.meta.badLines > 0) {
      state.meta.warnings.push(`${state.meta.badLines} unparseable line(s)`);
    }
    if (!state.meta.title && state.firstUserTitle) state.meta.title = state.firstUserTitle;
    if (!state.meta.project && state.meta.cwd) {
      state.meta.project = state.meta.cwd.split('/').filter(Boolean).pop() ?? state.meta.cwd;
    }
    return [];
  }

  private parseUserString(
    o: Record<string, any>,
    content: string,
    hasImages: boolean,
    mkEvent: (over: Record<string, unknown>) => TraceEvent,
    state: ClaudeState,
    ctx: ParseCtx,
  ): TraceEvent[] {
    const provider = 'claude-code' as const;
    const t = truncate(content, ctx.textLimit);

    // 1. Compaction summary.
    if (o.isCompactSummary === true || content.startsWith('This session is being continued from a previous conversation')) {
      return [
        mkEvent({
          kind: 'synthetic_message',
          text: t.text,
          truncated: t.truncated,
          syntheticKind: 'compact-summary',
          source: { provider, rawType: 'user', rawSubtype: 'compact-summary' },
        }) as SyntheticMessageEvent,
      ];
    }
    // 2. Meta injections ("Your response above was cut off…", "(continuing)", …).
    if (o.isMeta === true) {
      return [
        mkEvent({
          kind: 'synthetic_message',
          text: t.text,
          truncated: t.truncated,
          syntheticKind: 'meta',
          source: { provider, rawType: 'user', rawSubtype: 'isMeta' },
        }) as SyntheticMessageEvent,
      ];
    }
    // 3. Explicit non-human origin (queue injections, turn companions…).
    if (o.origin && typeof o.origin === 'object' && o.origin.kind !== 'human') {
      return [
        mkEvent({
          kind: 'synthetic_message',
          text: t.text,
          truncated: t.truncated,
          syntheticKind: 'queue',
          source: { provider, rawType: 'user', rawSubtype: `origin:${String(o.origin.kind)}` },
        }) as SyntheticMessageEvent,
      ];
    }
    // 4. v2.1.270+: human prompts always carry origin.kind === 'human'.
    if (o.origin?.kind === 'human') {
      if (!state.firstUserTitle) state.firstUserTitle = oneLine(content, 120);
      return [
        mkEvent({
          kind: 'user_message',
          text: t.text,
          truncated: t.truncated,
          hasImages: hasImages || undefined,
          source: { provider, rawType: 'user', rawSubtype: 'human' },
        }) as UserMessageEvent,
      ];
    }
    // 5. No origin info (older versions) — heuristic. Messages carrying
    // images are always genuine user input.
    const lower = content.trim().toLowerCase();
    const looksInjected =
      !hasImages &&
      (CONTINUATION_PREFIXES.some((p) => lower.startsWith(p)) ||
        content.startsWith('<system-reminder>') ||
        content.startsWith('<command-name>') ||
        content.startsWith('Caveat:'));
    return [
      mkEvent({
        kind: looksInjected ? 'synthetic_message' : 'user_message',
        text: t.text,
        truncated: t.truncated,
        syntheticKind: looksInjected ? 'continuation' : undefined,
        hasImages: !looksInjected && hasImages ? true : undefined,
        source: {
          provider,
          rawType: 'user',
          rawSubtype: looksInjected ? 'heuristic:synthetic' : 'heuristic:human',
        },
      }) as TraceEvent,
    ];
  }

  private parseToolResult(
    o: Record<string, any>,
    block: Record<string, any>,
    mkEvent: (over: Record<string, unknown>) => TraceEvent,
    state: ClaudeState,
    ctx: ParseCtx,
  ): TraceEvent[] {
    const provider = 'claude-code' as const;
    const callId = String(block.tool_use_id ?? '');
    const pending = state.pendingCalls.get(callId);
    const toolName = pending?.toolName;
    const tur = o.toolUseResult;
    const isError = block.is_error === true || typeof tur === 'string';
    const timestampMs = parseTimestampMs(typeof o.timestamp === 'string' ? o.timestamp : undefined);
    const durationMs =
      pending?.timestampMs !== undefined && timestampMs !== undefined && timestampMs >= pending.timestampMs
        ? timestampMs - pending.timestampMs
        : undefined;

    let resultKind: ToolResultEvent['resultKind'] = 'unknown';
    let output: string | undefined;
    let stdout: string | undefined;
    let stderr: string | undefined;
    let exitCode: number | undefined;
    let interrupted: boolean | undefined;
    let hasImage: boolean | undefined;
    let filePath: string | undefined;
    let structuredPatch: StructuredPatch[] | undefined;
    let additions: number | undefined;
    let deletions: number | undefined;

    const blockContent = block.content;
    const blockText =
      typeof blockContent === 'string'
        ? blockContent
        : Array.isArray(blockContent)
          ? blockContent
              .map((b: any) => (typeof b?.text === 'string' ? b.text : typeof b === 'string' ? b : ''))
              .join('\n')
          : '';

    if (typeof tur === 'string') {
      resultKind = 'error';
      output = tur;
    } else if (tur && typeof tur === 'object') {
      const r = tur as Record<string, any>;
      if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
        resultKind = 'bash';
        if (typeof r.stderr === 'string' && r.stderr) stderr = r.stderr;
        if (typeof r.stdout === 'string' && r.stdout) stdout = r.stdout;
        if (!stdout && !stderr) {
          stdout = blockText || (r.noOutputExpected ? '(no output)' : '');
        }
        interrupted = r.interrupted === true || undefined;
        exitCode = typeof r.exitCode === 'number' ? r.exitCode : undefined;
      } else if (Array.isArray(r.structuredPatch)) {
        resultKind = toolName === 'Write' ? 'write' : 'edit';
        structuredPatch = r.structuredPatch as StructuredPatch[];
        filePath = typeof r.filePath === 'string' ? r.filePath : undefined;
        const counts = countPatchLines(structuredPatch.flatMap((p) => p.hunks ?? []));
        additions = counts.additions;
        deletions = counts.deletions;
      } else if (typeof r.file === 'string' || typeof r.filePath === 'string') {
        resultKind = 'file-read';
        filePath = (typeof r.file === 'string' ? r.file : r.filePath) as string;
        output = blockText;
      } else {
        resultKind = 'unknown';
        output = blockText || (Object.keys(r).length ? undefined : undefined);
      }
      hasImage = r.isImage === true || undefined;
    } else {
      resultKind = isError ? 'error' : 'text';
      output = blockText;
    }

    const budget = ctx.outputLimit;
    const outT = output !== undefined ? truncate(output, budget) : undefined;
    const stdoutT = stdout !== undefined ? truncate(stdout, budget) : undefined;
    const stderrT = stderr !== undefined ? truncate(stderr, budget) : undefined;

    const events: TraceEvent[] = [];
    events.push(
      mkEvent({
        kind: 'tool_result',
        callId,
        toolName,
        isError: isError || undefined,
        resultKind,
        output: outT?.text,
        stdout: stdoutT?.text,
        stderr: stderrT?.text,
        exitCode,
        interrupted,
        hasImage,
        filePath,
        structuredPatch: structuredPatch && structuredPatch.length > 0 ? structuredPatch : undefined,
        additions,
        deletions,
        durationMs,
        truncated: outT?.truncated || stdoutT?.truncated || stderrT?.truncated || undefined,
        requestIndex: state.requestIndex >= 0 ? state.requestIndex : undefined,
        turnId: state.currentTurnId,
        source: { provider, rawType: 'user', rawSubtype: 'tool_result' },
      }) as ToolResultEvent,
    );

    // Emit file_change events for edit/write results.
    if (structuredPatch && structuredPatch.length > 0 && filePath) {
      for (const patch of structuredPatch) {
        const counts = countPatchLines(patch.hunks ?? []);
        events.push(
          mkEvent({
            kind: 'file_change',
            path: filePath,
            changeType: 'modify',
            additions: counts.additions,
            deletions: counts.deletions,
            causedByEventId: pending?.eventId,
            source: { provider, rawType: 'user', rawSubtype: 'tool_result:patch' },
          }) as FileChangeEvent,
        );
      }
    }

    if (pending) state.pendingCalls.delete(callId);
    return events;
  }
}

function addUsage(target: ReturnType<typeof emptyUsage>, usage: Record<string, any>): void {
  target.inputTokens += num(usage.input_tokens);
  target.outputTokens += num(usage.output_tokens);
  target.cachedInputTokens += num(usage.cache_read_input_tokens);
  target.cacheWriteTokens += num(usage.cache_creation_input_tokens);
  const thinking = usage.output_tokens_details?.thinking_tokens;
  target.reasoningTokens += num(thinking);
  target.totalTokens +=
    num(usage.input_tokens) +
    num(usage.output_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function maybeTruncateInput(input: unknown, ctx: ParseCtx): unknown {
  if (typeof input === 'string' && input.length > ctx.outputLimit) {
    return input.slice(0, ctx.outputLimit);
  }
  return input;
}
