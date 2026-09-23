import type {
  EventLoc,
  TraceEvent,
  TraceProvider,
  TraceUsage,
} from './schema.js';

/** Metadata accumulated while parsing; becomes the TraceRun after finalize. */
export interface ParserMeta {
  sessionId?: string;
  title?: string;
  project?: string;
  cwd?: string;
  gitRepo?: string;
  gitBranch?: string;
  models: Set<string>;
  startedAt?: string;
  endedAt?: string;
  usage: TraceUsage;
  warnings: string[];
  badLines: number;
  /** Line types intentionally summarized instead of becoming events. */
  skippedTypes: Record<string, number>;
  /** Extra notes shown in the UI (e.g. collaboration mode). */
  notes: string[];
}

export interface ParserStateBase {
  /** Next event seq to assign. */
  seq: number;
  meta: ParserMeta;
}

export interface ParseCtx {
  /** Truncation budget (chars) for tool outputs / long previews. */
  outputLimit: number;
  /** Truncation budget (chars) for message / reasoning text. */
  textLimit: number;
}

export function defaultParseCtx(eventCountHint = 0): ParseCtx {
  // Adaptive budgets: keep huge runs transportable.
  if (eventCountHint > 50_000) return { outputLimit: 512, textLimit: 2_000 };
  if (eventCountHint > 10_000) return { outputLimit: 1_024, textLimit: 8_000 };
  return { outputLimit: 4_096, textLimit: 32_000 };
}

export function newParserMeta(): ParserMeta {
  return {
    models: new Set<string>(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      modelRequests: 0,
    },
    warnings: [],
    badLines: 0,
    skippedTypes: {},
    notes: [],
  };
}

/**
 * A provider adapter turns provider JSONL lines into unified TraceEvents.
 *
 * Contract:
 *  - `parseLine` is synchronous and pure w.r.t. `state`; it may return 0..n events.
 *  - Lines that produce no events (e.g. Claude's `custom-title`) should record
 *    themselves in `meta.skippedTypes` so nothing silently disappears.
 *  - Events must receive stable ids (`e<seq>`); seq increments monotonically.
 *  - Live tail reuses the same state object, so all cross-line bookkeeping
 *    (pending tool calls, uuid chains) must live in the state, never in the adapter.
 */
export interface TraceAdapter<S extends ParserStateBase = ParserStateBase> {
  readonly id: TraceProvider;
  readonly label: string;

  /** Quick sniff from the first parsed lines of a file. */
  detect(headLines: unknown[]): boolean;

  createState(): S;

  parseLine(line: unknown, loc: EventLoc, state: S, ctx: ParseCtx): TraceEvent[];

  /** Called once after the last line (or after each live-tail batch). */
  finalize(state: S, ctx: ParseCtx): TraceEvent[];
}
