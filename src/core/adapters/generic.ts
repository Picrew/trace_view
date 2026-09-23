import type {
  AssistantMessageEvent,
  EventLoc,
  TraceEvent,
  UserMessageEvent,
} from '../schema.js';
import { newParserMeta, type ParseCtx, type ParserStateBase, type TraceAdapter } from '../adapter.js';
import { oneLine, parseTimestampMs, truncate } from '../util.js';

export interface GenericState extends ParserStateBase {
  firstUserTitle?: string;
}

/**
 * Last-resort adapter for manually imported .jsonl/.ndjson/.json traces.
 * Best-effort field detection; everything unclassifiable stays visible as
 * `unknown` events with raw JSON on demand.
 */
export class GenericAdapter implements TraceAdapter<GenericState> {
  readonly id = 'generic' as const;
  readonly label = 'Generic JSONL';

  detect(_headLines: unknown[]): boolean {
    return true; // generic accepts anything parseable
  }

  createState(): GenericState {
    return { seq: 0, meta: newParserMeta() };
  }

  parseLine(line: unknown, loc: EventLoc, state: GenericState, ctx: ParseCtx): TraceEvent[] {
    if (line === null || line === undefined) return [];
    if (typeof line !== 'object') {
      return [
        {
          id: `e${state.seq}`,
          seq: state.seq++,
          kind: 'unknown',
          agentId: 'main',
          source: { provider: 'generic', rawType: typeof line },
          loc,
          note: 'Non-object JSON line',
        },
      ];
    }
    const o = line as Record<string, any>;
    const timestamp =
      typeof o.timestamp === 'string'
        ? o.timestamp
        : typeof o.ts === 'string'
          ? o.ts
          : typeof o.time === 'string'
            ? o.time
            : typeof o.created_at === 'string'
              ? o.created_at
              : undefined;
    const timestampMs = parseTimestampMs(timestamp);
    if (timestamp && (!state.meta.startedAt || timestamp < state.meta.startedAt)) state.meta.startedAt = timestamp;
    if (timestamp && (!state.meta.endedAt || timestamp > state.meta.endedAt)) state.meta.endedAt = timestamp;
    if (!state.meta.sessionId && typeof o.sessionId === 'string') state.meta.sessionId = o.sessionId;
    if (!state.meta.cwd && typeof o.cwd === 'string') state.meta.cwd = o.cwd;

    const rawType = typeof o.type === 'string' ? o.type : undefined;
    const role =
      (typeof o.role === 'string' ? o.role : undefined) ??
      (typeof o.message?.role === 'string' ? o.message.role : undefined) ??
      (rawType === 'assistant' ? 'assistant' : rawType === 'user' ? 'user' : undefined);

    const content: unknown = o.content ?? o.message?.content ?? o.text ?? o.message?.text;
    const text = normalizeContent(content);
    const base = {
      timestamp,
      timestampMs,
      agentId: 'main',
      source: { provider: 'generic' as const, rawType },
      loc,
    };

    if (role === 'user' && text) {
      if (!state.firstUserTitle) state.firstUserTitle = oneLine(text, 120);
      const t = truncate(text, ctx.textLimit);
      return [{ ...base, id: `e${state.seq}`, seq: state.seq++, kind: 'user_message', text: t.text, truncated: t.truncated } as UserMessageEvent];
    }
    if (role === 'assistant' && text) {
      const t = truncate(text, ctx.textLimit);
      return [
        { ...base, id: `e${state.seq}`, seq: state.seq++, kind: 'assistant_message', text: t.text, truncated: t.truncated } as AssistantMessageEvent,
      ];
    }

    return [
      {
        ...base,
        id: `e${state.seq}`,
        seq: state.seq++,
        kind: 'unknown',
        rawType: rawType ?? 'untyped',
        note: 'Unclassifiable line — open raw JSON for details',
      },
    ];
  }

  finalize(state: GenericState): TraceEvent[] {
    if (!state.meta.title && state.firstUserTitle) state.meta.title = state.firstUserTitle;
    if (!state.meta.project && state.meta.cwd) {
      state.meta.project = state.meta.cwd.split('/').filter(Boolean).pop() ?? state.meta.cwd;
    }
    return [];
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === 'string' ? b.text : typeof b === 'string' ? b : ''))
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, any>;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}
