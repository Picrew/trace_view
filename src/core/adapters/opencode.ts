import type {
  AssistantMessageEvent,
  CompactionEvent,
  ErrorEvent,
  EventLoc,
  FileChangeEvent,
  ReasoningEvent,
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
  oneLine,
  parseUnifiedDiff,
  toolSummary,
  truncate,
} from '../util.js';

export interface OpencodeState extends ParserStateBase {
  requestIndex: number;
  /** Last tool_call event id of the current message (for patch attribution). */
  lastToolCallEventId?: string;
}

/**
 * OpenCode adapter — consumes the virtual JSONL produced by
 * `projectOpencodeSession` (src/core/opencode-projector.ts):
 *
 *   {"type":"oc_session", …}
 *   {"type":"oc_message", message:{role,time,modelID,…}, parts:[…]}
 *
 * Parts: step-start | reasoning | text | tool | step-finish | patch | file |
 * compaction. A `tool` part carries call + result together in `state`
 * {status, input, output, metadata:{diff}}; a step-start..step-finish pair is
 * one model request (tokens on step-finish).
 *
 * OpenCode stores no per-part timestamps — part times are interpolated
 * linearly within the message's [created, completed] span, so durations of
 * individual tools are not meaningful (the run notes this).
 * See docs/trace-format-research.md §4.
 */
export class OpencodeAdapter implements TraceAdapter<OpencodeState> {
  readonly id = 'opencode' as const;
  readonly label = 'OpenCode';

  detect(headLines: unknown[]): boolean {
    for (const line of headLines) {
      if (!line || typeof line !== 'object') continue;
      const o = line as Record<string, any>;
      if (o.type === 'oc_session' || o.type === 'oc_message') return true;
    }
    return false;
  }

  createState(): OpencodeState {
    return { seq: 0, meta: newParserMeta(), requestIndex: -1 };
  }

  parseLine(line: unknown, loc: EventLoc, state: OpencodeState, ctx: ParseCtx): TraceEvent[] {
    if (!line || typeof line !== 'object') return [];
    const o = line as Record<string, any>;
    const provider = 'opencode' as const;

    if (o.type === 'oc_session') return this.parseSession(o, loc, state, ctx);
    if (o.type === 'oc_message') return this.parseMessage(o, loc, state, ctx);
    state.meta.skippedTypes[o.type] = (state.meta.skippedTypes[o.type] ?? 0) + 1;
    return [];
  }

  private parseSession(
    o: Record<string, any>,
    loc: EventLoc,
    state: OpencodeState,
    ctx: ParseCtx,
  ): TraceEvent[] {
    if (typeof o.id === 'string') state.meta.sessionId = o.id;
    if (typeof o.title === 'string') state.meta.title = oneLine(o.title, 200);
    if (typeof o.directory === 'string') {
      state.meta.cwd = o.directory;
      state.meta.project = o.directory.split('/').filter(Boolean).pop() ?? o.directory;
    }
    if (typeof o.time?.created === 'number') {
      state.meta.startedAt = new Date(o.time.created).toISOString();
    }
    if (typeof o.time?.updated === 'number') {
      state.meta.endedAt = new Date(o.time.updated).toISOString();
    }
    if (typeof o.parentID === 'string' && o.parentID) {
      state.meta.notes.push(`subagent of ${o.parentID}`);
    }
    if (typeof o.version === 'string') {
      const note = `opencode ${o.version}`;
      if (!state.meta.notes.includes(note)) state.meta.notes.push(note);
    }
    void ctx;
    void loc;
    return [];
  }

  private parseMessage(
    o: Record<string, any>,
    loc: EventLoc,
    state: OpencodeState,
    ctx: ParseCtx,
  ): TraceEvent[] {
    const provider = 'opencode' as const;
    const m = o.message;
    if (!m || typeof m !== 'object') return [];
    const parts: any[] = Array.isArray(o.parts) ? o.parts : [];
    const events: TraceEvent[] = [];

    const createdMs = typeof m.time?.created === 'number' ? m.time.created : undefined;
    const completedMs = typeof m.time?.completed === 'number' ? m.time.completed : undefined;
    const timestampMs = createdMs;
    const timestamp = createdMs !== undefined ? new Date(createdMs).toISOString() : undefined;
    // Parts carry no clocks — interpolate within the message span.
    const partMs = (i: number): number | undefined => {
      if (createdMs === undefined) return undefined;
      if (completedMs === undefined || parts.length < 2 || completedMs <= createdMs) return createdMs;
      return Math.round(createdMs + ((completedMs - createdMs) * i) / (parts.length - 1));
    };
    const mkEvent = (i: number, over: Record<string, unknown>): TraceEvent => {
      const ms = partMs(i);
      return {
        id: `e${state.seq}`,
        seq: state.seq++,
        timestamp: ms !== undefined ? new Date(ms).toISOString() : undefined,
        timestampMs: ms,
        agentId: 'main',
        source: { provider, rawType: 'oc_message' },
        loc,
        ...over,
      } as TraceEvent;
    };

    if (m.role === 'user') {
      const texts: string[] = [];
      let hasImages = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p?.type === 'text' && typeof p.text === 'string') {
          texts.push(p.text);
        } else if (p?.type === 'file' && typeof p.mime === 'string' && p.mime.startsWith('image/')) {
          hasImages = true;
        } else if (p?.type === 'compaction') {
          const text = typeof p.text === 'string' ? p.text : typeof p.summary === 'string' ? p.summary : '';
          events.push(
            mkEvent(i, {
              kind: 'compaction',
              text: truncate(text, ctx.textLimit).text,
              source: { provider, rawType: 'part', rawSubtype: 'compaction' },
            }) as CompactionEvent,
          );
        } else if (p?.type) {
          state.meta.skippedTypes[`user-part:${p.type}`] = (state.meta.skippedTypes[`user-part:${p.type}`] ?? 0) + 1;
        }
      }
      const joined = texts.join('\n');
      events.push(
        mkEvent(0, {
          kind: 'user_message',
          text: truncate(joined, ctx.textLimit).text,
          hasImages,
          truncated: joined.length > ctx.textLimit,
          source: { provider, rawType: 'oc_message', rawSubtype: 'user' },
        }) as UserMessageEvent,
      );
      return events;
    }

    if (m.role !== 'assistant') {
      events.push(
        mkEvent(0, {
          kind: 'unknown',
          rawType: `oc_message:${String(m.role)}`,
          note: 'unrecognized message role',
        }) as TraceEvent,
      );
      return events;
    }

    const model = typeof m.modelID === 'string' ? m.modelID : undefined;
    if (model) state.meta.models.add(model);
    if (typeof m.agent === 'string' && m.agent && m.agent !== 'main' && m.agent !== 'primary') {
      const note = `agent: ${m.agent}`;
      if (!state.meta.notes.includes(note)) state.meta.notes.push(note);
    }
    state.lastToolCallEventId = undefined;

    let stepInMessage = 0;
    let lastFinish: Record<string, any> | undefined;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || typeof p !== 'object') continue;
      switch (p.type) {
        case 'step-start': {
          state.requestIndex += 1;
          stepInMessage += 1;
          events.push(
            mkEvent(i, {
              kind: 'turn_boundary',
              requestIndex: state.requestIndex,
              model,
              turnId: `${typeof m.id === 'string' ? m.id : 'msg'}-s${stepInMessage}`,
              source: { provider, rawType: 'part', rawSubtype: 'step-start' },
            }) as TurnBoundaryEvent,
          );
          break;
        }

        case 'reasoning': {
          const text = typeof p.text === 'string' ? p.text : '';
          const trimmed = truncate(text, ctx.textLimit);
          events.push(
            mkEvent(i, {
              kind: 'reasoning',
              text: trimmed.text,
              truncated: trimmed.truncated,
              source: { provider, rawType: 'part', rawSubtype: 'reasoning' },
            }) as ReasoningEvent,
          );
          break;
        }

        case 'text': {
          const text = typeof p.text === 'string' ? p.text : '';
          const trimmed = truncate(text, ctx.textLimit);
          events.push(
            mkEvent(i, {
              kind: 'assistant_message',
              text: trimmed.text,
              truncated: trimmed.truncated,
              messageId: typeof m.id === 'string' ? m.id : undefined,
              stopReason: typeof lastFinish?.reason === 'string' ? lastFinish.reason : undefined,
              source: { provider, rawType: 'part', rawSubtype: 'text' },
            }) as AssistantMessageEvent,
          );
          break;
        }

        case 'tool': {
          events.push(...this.parseToolPart(p, m, mkEvent, i, state, ctx));
          break;
        }

        case 'step-finish': {
          lastFinish = p;
          const t = p.tokens ?? {};
          const cache = t.cache ?? {};
          state.meta.usage.inputTokens += typeof t.input === 'number' ? t.input : 0;
          state.meta.usage.outputTokens += typeof t.output === 'number' ? t.output : 0;
          state.meta.usage.reasoningTokens += typeof t.reasoning === 'number' ? t.reasoning : 0;
          state.meta.usage.cachedInputTokens += typeof cache.read === 'number' ? cache.read : 0;
          state.meta.usage.cacheWriteTokens += typeof cache.write === 'number' ? cache.write : 0;
          state.meta.usage.totalTokens +=
            (typeof t.input === 'number' ? t.input : 0) +
            (typeof t.output === 'number' ? t.output : 0) +
            (typeof cache.read === 'number' ? cache.read : 0) +
            (typeof cache.write === 'number' ? cache.write : 0);
          state.meta.usage.modelRequests = state.requestIndex + 1;
          break;
        }

        case 'patch': {
          // Step-level snapshot of files changed (no line counts available).
          const files: unknown[] = Array.isArray(p.files) ? p.files : [];
          for (const f of files) {
            if (typeof f !== 'string') continue;
            events.push(
              mkEvent(i, {
                kind: 'file_change',
                path: f,
                changeType: 'modify',
                causedByEventId: state.lastToolCallEventId,
                source: { provider, rawType: 'part', rawSubtype: 'patch' },
              }) as FileChangeEvent,
            );
          }
          break;
        }

        case 'file': {
          state.meta.skippedTypes['assistant-part:file'] =
            (state.meta.skippedTypes['assistant-part:file'] ?? 0) + 1;
          break;
        }

        default: {
          if (p.type) {
            state.meta.skippedTypes[`assistant-part:${p.type}`] =
              (state.meta.skippedTypes[`assistant-part:${p.type}`] ?? 0) + 1;
          }
          break;
        }
      }
    }
    return events;
  }

  private parseToolPart(
    p: Record<string, any>,
    m: Record<string, any>,
    mkEvent: (i: number, over: Record<string, unknown>) => TraceEvent,
    i: number,
    state: OpencodeState,
    ctx: ParseCtx,
  ): TraceEvent[] {
    const provider = 'opencode' as const;
    const events: TraceEvent[] = [];
    const st = p.state ?? {};
    const toolName = typeof p.tool === 'string' ? p.tool : 'unknown';
    const callId = typeof p.callID === 'string' ? p.callID : '';
    const input = st.input;
    const { category, mcpServer } = classifyTool(toolName);

    const callEvent = mkEvent(i, {
      kind: 'tool_call',
      callId,
      toolName,
      toolCategory: category,
      mcpServer,
      input,
      summary: toolSummary(toolName, input),
      source: { provider, rawType: 'part', rawSubtype: 'tool' },
    }) as ToolCallEvent;
    events.push(callEvent);
    state.lastToolCallEventId = callEvent.id;

    // Running tools have no result yet (live sessions) — re-projection will
    // pick the result up when the part file is rewritten.
    if (st.status === 'running' || st.status === 'pending') return events;

    const isError = st.status === 'error';
    const output = outputText(st.output);
    const trimmed = truncate(output, ctx.outputLimit);
    const metadata = st.metadata ?? {};
    const diffText = typeof metadata.diff === 'string' ? metadata.diff : undefined;
    const patches = diffText !== undefined ? parseUnifiedDiff(diffText) : [];
    const filePath =
      typeof input?.filePath === 'string' ? input.filePath : patches[0]?.newFile ?? patches[0]?.oldFile;

    let resultKind: ToolResultEvent['resultKind'] = 'text';
    if (isError) resultKind = 'error';
    else if (patches.length > 0) resultKind = category === 'write' ? 'write' : 'edit';
    else if (toolName === 'bash' || category === 'bash') resultKind = 'bash';
    else if (toolName === 'read' || category === 'read') resultKind = 'file-read';

    events.push(
      mkEvent(i, {
        kind: 'tool_result',
        callId,
        toolName,
        isError,
        resultKind,
        output: trimmed.text,
        truncated: trimmed.truncated,
        filePath,
        structuredPatch: patches.length > 0 ? patches : undefined,
        source: { provider, rawType: 'part', rawSubtype: 'tool' },
      }) as ToolResultEvent,
    );

    // Edit/write diffs also feed the Files Changed panel.
    if (patches.length > 0 && filePath) {
      const totals = countPatchLines(patches.flatMap((x) => x.hunks));
      const oldTotal = patches.reduce((a, x) => a + x.hunks.reduce((b, h) => b + h.oldLines, 0), 0);
      const newTotal = patches.reduce((a, x) => a + x.hunks.reduce((b, h) => b + h.newLines, 0), 0);
      const changeType = oldTotal === 0 ? 'add' : newTotal === 0 ? 'delete' : 'modify';
      events.push(
        mkEvent(i, {
          kind: 'file_change',
          path: filePath,
          changeType,
          additions: totals.additions,
          deletions: totals.deletions,
          causedByEventId: callEvent.id,
          source: { provider, rawType: 'part', rawSubtype: 'tool-diff' },
        }) as FileChangeEvent,
      );
    }
    void m;
    return events;
  }

  finalize(state: OpencodeState, ctx: ParseCtx): TraceEvent[] {
    if (state.requestIndex < 0) {
      state.meta.warnings.push('no opencode assistant messages found');
    }
    const note = 'part timestamps interpolated (opencode stores none)';
    if (!state.meta.warnings.includes(note)) state.meta.warnings.push(note);
    void ctx;
    return [];
  }
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && typeof (x as any).text === 'string') return (x as any).text as string;
        return JSON.stringify(x);
      })
      .join('\n');
  }
  if (output === null || output === undefined) return '';
  if (typeof output === 'object') return JSON.stringify(output);
  return String(output);
}
