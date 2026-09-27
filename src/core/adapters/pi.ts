import type {
  AssistantMessageEvent,
  CompactionEvent,
  ErrorEvent,
  EventLoc,
  ReasoningEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TurnBoundaryEvent,
  UserMessageEvent,
} from '../schema.js';
import { newParserMeta, type ParseCtx, type ParserStateBase, type TraceAdapter } from '../adapter.js';
import { classifyTool, oneLine, parseTimestampMs, resultKindFor, toolSummary, truncate } from '../util.js';

export interface PiState extends ParserStateBase {
  requestIndex: number;
  currentModel?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

/**
 * pi (badlogic's coding agent, `~/.pi/agent/sessions/<cwd-dir>/*.jsonl`)
 * writes typed NDJSON — session header, model/thinking-level changes, and
 * `message` events whose content blocks are text | thinking | toolCall |
 * image. Tool results come back as separate `role:"toolResult"` messages
 * keyed by toolCallId. Every assistant message is one model request (its
 * usage object carries that request's token counts).
 * See docs/trace-format-research.md §5.
 */
export class PiAdapter implements TraceAdapter<PiState> {
  readonly id = 'pi' as const;
  readonly label = 'Pi';

  detect(headLines: unknown[]): boolean {
    for (const line of headLines) {
      if (!line || typeof line !== 'object') continue;
      const o = line as Record<string, any>;
      if (o.type === 'session' && typeof o.cwd === 'string' && typeof o.id === 'string') return true;
      if (o.type === 'message' && o.message && typeof o.message === 'object' && o.message.role === 'toolResult') {
        return true;
      }
    }
    return false;
  }

  createState(): PiState {
    return { seq: 0, meta: newParserMeta(), requestIndex: -1 };
  }

  parseLine(line: unknown, loc: EventLoc, state: PiState, ctx: ParseCtx): TraceEvent[] {
    if (!line || typeof line !== 'object') return [];
    const o = line as Record<string, any>;
    const provider = 'pi' as const;
    const timestamp = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    const timestampMs = parseTimestampMs(timestamp);
    const base = { timestamp, timestampMs, agentId: 'main', source: { provider, rawType: String(o.type) }, loc };
    const mkEvent = (over: Record<string, unknown>): TraceEvent =>
      ({ ...base, id: `e${state.seq}`, seq: state.seq++, ...over } as TraceEvent);

    if (timestamp && (!state.meta.startedAt || timestamp < state.meta.startedAt)) state.meta.startedAt = timestamp;
    if (timestamp && (!state.meta.endedAt || timestamp > state.meta.endedAt)) state.meta.endedAt = timestamp;

    const events: TraceEvent[] = [];

    switch (o.type) {
      case 'session': {
        if (typeof o.id === 'string') state.meta.sessionId = o.id;
        if (typeof o.cwd === 'string') {
          state.meta.cwd = o.cwd;
          state.meta.project = o.cwd.split('/').filter(Boolean).pop() ?? o.cwd;
        }
        break;
      }

      case 'model_change': {
        if (typeof o.modelId === 'string') {
          state.currentModel = o.modelId;
          state.meta.models.add(o.modelId);
        }
        state.meta.skippedTypes['model_change'] = (state.meta.skippedTypes['model_change'] ?? 0) + 1;
        break;
      }

      case 'thinking_level_change': {
        state.meta.skippedTypes['thinking_level_change'] =
          (state.meta.skippedTypes['thinking_level_change'] ?? 0) + 1;
        break;
      }

      case 'compaction': {
        events.push(
          mkEvent({
            kind: 'compaction',
            text: typeof o.summary === 'string' ? truncate(o.summary, ctx.textLimit).text : undefined,
            source: { provider, rawType: 'compaction' },
          }) as CompactionEvent,
        );
        break;
      }

      case 'message': {
        events.push(...this.parseMessage(o, mkEvent, state, ctx, base));
        break;
      }

      default:
        state.meta.skippedTypes[o.type] = (state.meta.skippedTypes[o.type] ?? 0) + 1;
        break;
    }
    return events;
  }

  private parseMessage(
    o: Record<string, any>,
    mkEvent: (over: Record<string, unknown>) => TraceEvent,
    state: PiState,
    ctx: ParseCtx,
    base: Record<string, unknown>,
  ): TraceEvent[] {
    const provider = 'pi' as const;
    const m = o.message;
    if (!m || typeof m !== 'object') return [];
    const role = m.role;
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    const events: TraceEvent[] = [];

    if (role === 'user') {
      const texts: string[] = [];
      let hasImages = false;
      let images = 0;
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b?.type === 'image') images++;
        else state.meta.skippedTypes[`user-block:${b?.type}`] = (state.meta.skippedTypes[`user-block:${b?.type}`] ?? 0) + 1;
      }
      if (images > 0) hasImages = true;
      const joined = texts.join('\n');
      events.push(
        mkEvent({
          kind: 'user_message',
          text: truncate(joined, ctx.textLimit).text,
          hasImages,
          truncated: joined.length > ctx.textLimit,
          source: { provider, rawType: 'message', rawSubtype: 'user' },
        }) as UserMessageEvent,
      );
      return events;
    }

    if (role === 'toolResult') {
      const outTexts: string[] = [];
      let hasImage = false;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && typeof b.text === 'string') outTexts.push(b.text);
        else if (b?.type === 'image') hasImage = true;
      }
      const output = outTexts.join('\n');
      const toolName = typeof m.toolName === 'string' ? m.toolName : undefined;
      const trimmed = truncate(output, ctx.outputLimit);
      events.push(
        mkEvent({
          kind: 'tool_result',
          callId: typeof m.toolCallId === 'string' ? m.toolCallId : '',
          toolName,
          isError: m.isError === true,
          resultKind: m.isError === true ? 'error' : resultKindFor(toolName, output),
          output: trimmed.text,
          truncated: trimmed.truncated,
          hasImage,
          source: { provider, rawType: 'message', rawSubtype: 'toolResult' },
        }) as ToolResultEvent,
      );
      return events;
    }

    if (role === 'assistant') {
      // Each assistant message is one model request.
      state.requestIndex += 1;
      const turnId = `req-${state.requestIndex + 1}`;
      const model = typeof m.model === 'string' ? m.model : state.currentModel;
      if (model) state.meta.models.add(model);
      const usage = (m.usage ?? {}) as PiUsage;
      state.meta.usage.inputTokens += usage.input ?? 0;
      state.meta.usage.outputTokens += usage.output ?? 0;
      state.meta.usage.cachedInputTokens += usage.cacheRead ?? 0;
      state.meta.usage.cacheWriteTokens += usage.cacheWrite ?? 0;
      state.meta.usage.totalTokens += usage.totalTokens ?? 0;
      state.meta.usage.modelRequests = state.requestIndex + 1;

      const requestBase = { ...base, turnId, requestIndex: state.requestIndex, model };
      const mkReqEvent = (over: Record<string, unknown>): TraceEvent =>
        ({
          ...requestBase,
          id: `e${state.seq}`,
          seq: state.seq++,
          ...over,
        }) as TraceEvent;

      events.push(
        mkReqEvent({
          kind: 'turn_boundary',
          requestIndex: state.requestIndex,
          model,
          source: { provider, rawType: 'message', rawSubtype: 'assistant' },
        }) as TurnBoundaryEvent,
      );

      const texts: string[] = [];
      const flushText = () => {
        if (texts.length === 0) return;
        const joined = texts.join('\n');
        const trimmed = truncate(joined, ctx.textLimit);
        events.push(
          mkReqEvent({
            kind: 'assistant_message',
            text: trimmed.text,
            truncated: trimmed.truncated,
            messageId: typeof o.id === 'string' ? o.id : undefined,
            source: { provider, rawType: 'message', rawSubtype: 'assistant' },
          }) as AssistantMessageEvent,
        );
        texts.length = 0;
      };

      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (b?.type === 'thinking' && typeof (b.thinking ?? b.text) === 'string') {
          flushText();
          const trimmed = truncate((b.thinking ?? b.text) as string, ctx.textLimit);
          events.push(
            mkReqEvent({
              kind: 'reasoning',
              text: trimmed.text,
              truncated: trimmed.truncated,
              source: { provider, rawType: 'thinking' },
            }) as ReasoningEvent,
          );
        } else if (b?.type === 'toolCall') {
          flushText();
          const toolName = typeof b.name === 'string' ? b.name : 'unknown';
          const { category, mcpServer } = classifyTool(toolName);
          events.push(
            mkReqEvent({
              kind: 'tool_call',
              callId: typeof b.id === 'string' ? b.id : '',
              toolName,
              toolCategory: category,
              mcpServer,
              input: b.arguments,
              summary: toolSummary(toolName, b.arguments),
              source: { provider, rawType: 'toolCall' },
            }) as ToolCallEvent,
          );
        } else if (b?.type) {
          state.meta.skippedTypes[`assistant-block:${b.type}`] =
            (state.meta.skippedTypes[`assistant-block:${b.type}`] ?? 0) + 1;
        }
      }
      flushText();

      if (m.stopReason === 'error') {
        const msg = typeof m.errorMessage === 'string' ? oneLine(m.errorMessage, 500) : 'request failed';
        events.push(
          mkReqEvent({
            kind: 'error',
            message: truncate(msg, ctx.textLimit).text,
            source: { provider, rawType: 'message', rawSubtype: 'error' },
          }) as ErrorEvent,
        );
      }
      return events;
    }

    // Unknown role (future versions) — keep it visible.
    events.push(
      mkEvent({
        kind: 'unknown',
        rawType: `message:${String(role)}`,
        note: 'unrecognized message role',
      }) as TraceEvent,
    );
    return events;
  }

  finalize(state: PiState, ctx: ParseCtx): TraceEvent[] {
    if (state.requestIndex < 0 && state.meta.models.size === 0) {
      state.meta.warnings.push('no pi messages found in file');
    }
    return [];
  }
}
