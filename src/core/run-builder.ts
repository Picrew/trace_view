import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  FileChangeSummary,
  ParsedRun,
  RunStats,
  SessionSummary,
  TimelineSpan,
  ToolResultEvent,
  TraceEvent,
  TraceProvider,
  TraceRun,
} from './schema.js';
import { PARSER_VERSION } from './schema.js';
import { defaultParseCtx, type ParseCtx, type ParserStateBase } from './adapter.js';
import type { TraceAdapter } from './adapter.js';
import { detectAdapter, getAdapter } from './adapters/index.js';
import { readHeadLines, readJsonlLines, readSlice, readTailLines } from './reader.js';
import { emptyStats, oneLine, parseTimestampMs, runIdFor } from './util.js';

/** Full parse result plus state kept alive for live tailing. */
export interface ParseHandle {
  parsed: ParsedRun;
  adapter: TraceAdapter<any>;
  state: ParserStateBase;
  ctx: ParseCtx;
  filePath: string;
  /** Byte offset just past the last parsed line. */
  byteOffset: number;
  parsedAtMs: number;
}

const LIVE_WINDOW_MS = 5 * 60 * 1000;

export async function parseTraceFile(
  filePath: string,
  opts: { provider?: TraceProvider; fileSizeBytes?: number; mtimeMs?: number } = {},
): Promise<ParseHandle> {
  const st = opts.fileSizeBytes !== undefined && opts.mtimeMs !== undefined
    ? { size: opts.fileSizeBytes, mtimeMs: opts.mtimeMs }
    : await stat(filePath);
  const head = await readHeadLines(filePath, 128 * 1024);
  const adapter = opts.provider ? getAdapter(opts.provider) : detectAdapter(head);
  const state = adapter.createState();
  const ctx = defaultParseCtx(st.size / 3000);
  const events: TraceEvent[] = [];

  let byteOffset = 0;
  for await (const line of readJsonlLines(filePath)) {
    byteOffset = line.offset + line.length + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line.text);
    } catch {
      state.meta.badLines += 1;
      events.push({
        id: `e${state.seq}`,
        seq: state.seq++,
        kind: 'unknown',
        agentId: 'main',
        timestampMs: undefined,
        source: { provider: adapter.id, rawType: 'broken-line' },
        loc: { offset: line.offset, length: line.length },
        note: oneLine(line.text, 200),
      });
      continue;
    }
    events.push(...adapter.parseLine(obj, { offset: line.offset, length: line.length }, state, ctx));
  }
  events.push(...adapter.finalize(state, ctx));

  const parsed = buildDerived({
    provider: adapter.id,
    filePath,
    fileName: path.basename(filePath),
    fileSizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    events,
    state,
  });

  return { parsed, adapter, state, ctx, filePath, byteOffset, parsedAtMs: Date.now() };
}

/** Recompute run metadata / stats / spans / file changes from the event list. */
export function buildDerived(input: {
  provider: TraceProvider;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  mtimeMs: number;
  events: TraceEvent[];
  state: ParserStateBase;
}): ParsedRun {
  const { events, state } = input;
  const meta = state.meta;

  const stats: RunStats = { ...emptyStats(), byKind: {}, byTool: {}, byToolCategory: {} };
  const bumpKind = (k: TraceEvent['kind']) => {
    stats.byKind[k] = (stats.byKind[k] ?? 0) + 1;
  };

  // Pair tool calls with results for spans/durations.
  const resultsByCallId = new Map<string, ToolResultEvent>();
  for (const e of events) {
    if (e.kind === 'tool_result') resultsByCallId.set(e.callId, e);
  }

  const spans: TimelineSpan[] = [];
  const fileChangeMap = new Map<string, FileChangeSummary>();
  const agents = new Set<string>();
  let lastTimestampMs: number | undefined;
  let firstTimestampMs: number | undefined;
  let title = meta.title;

  // Model request spans: [turn_boundary(N) .. last event of request N].
  let currentSpan: TimelineSpan | null = null;
  let currentSpanRequest: number | undefined = undefined;
  const boundaries: TraceEvent[] = [];
  const lastTsByRequest = new Map<number, number>();

  for (const e of events) {
    stats.events++;
    bumpKind(e.kind);
    if (e.agentId) agents.add(e.agentId);
    if (e.timestampMs !== undefined) {
      if (firstTimestampMs === undefined || e.timestampMs < firstTimestampMs) firstTimestampMs = e.timestampMs;
      if (lastTimestampMs === undefined || e.timestampMs > lastTimestampMs) lastTimestampMs = e.timestampMs;
      if (e.requestIndex !== undefined) {
        const prev = lastTsByRequest.get(e.requestIndex);
        if (prev === undefined || e.timestampMs > prev) lastTsByRequest.set(e.requestIndex, e.timestampMs);
      }
    }

    switch (e.kind) {
      case 'user_message':
        stats.userMessages++;
        if (!title && e.text.trim()) title = oneLine(e.text, 120);
        break;
      case 'synthetic_message':
        stats.syntheticMessages++;
        break;
      case 'assistant_message':
        stats.assistantMessages++;
        break;
      case 'reasoning':
        stats.reasoning++;
        break;
      case 'tool_call': {
        stats.toolCalls++;
        stats.byTool[e.toolName] = (stats.byTool[e.toolName] ?? 0) + 1;
        stats.byToolCategory[e.toolCategory] = (stats.byToolCategory[e.toolCategory] ?? 0) + 1;
        if (e.toolCategory === 'bash') stats.commandsRun++;
        const result = resultsByCallId.get(e.callId);
        const endMs = result?.timestampMs ?? e.timestampMs;
        if (e.timestampMs !== undefined && endMs !== undefined && endMs >= e.timestampMs) {
          spans.push({
            id: `span-${e.id}`,
            eventId: e.id,
            track: e.toolCategory,
            startMs: e.timestampMs,
            endMs,
            label: `${e.toolName} ${oneLine(e.summary, 60)}`,
            spanKind: 'tool',
            isError: result?.isError,
          });
          stats.toolTimeMs += endMs - e.timestampMs;
        }
        break;
      }
      case 'tool_result':
        stats.toolResults++;
        break;
      case 'error':
        stats.errors++;
        break;
      case 'compaction':
        stats.compactions++;
        break;
      case 'file_change': {
        stats.fileChanges++;
        const existing = fileChangeMap.get(e.path);
        const add = e.additions ?? 0;
        const del = e.deletions ?? 0;
        if (existing) {
          existing.additions += add;
          existing.deletions += del;
          if (e.causedByEventId && !existing.eventIds.includes(e.causedByEventId)) {
            existing.eventIds.push(e.causedByEventId);
          }
        } else {
          fileChangeMap.set(e.path, {
            path: e.path,
            changeType: e.changeType,
            additions: add,
            deletions: del,
            eventIds: e.causedByEventId ? [e.causedByEventId] : [e.id],
          });
        }
        break;
      }
      case 'turn_boundary': {
        boundaries.push(e);
        // Close previous model span at this boundary.
        if (currentSpan && e.timestampMs !== undefined && e.timestampMs >= currentSpan.startMs) {
          currentSpan.endMs = e.timestampMs;
          spans.push(currentSpan);
        }
        currentSpan = null;
        if (e.timestampMs !== undefined) {
          currentSpan = {
            id: `span-${e.id}`,
            eventId: e.id,
            track: 'model',
            startMs: e.timestampMs,
            endMs: e.timestampMs,
            label: `Request ${e.requestIndex + 1}${e.model ? ` · ${e.model}` : ''}`,
            spanKind: 'request',
          };
          currentSpanRequest = e.requestIndex;
        }
        break;
      }
      default:
        break;
    }

    // Extend the open model span to the latest event of this request.
    if (currentSpan && e.kind !== 'turn_boundary' && e.timestampMs !== undefined) {
      if (e.requestIndex !== undefined && e.requestIndex !== currentSpanRequest) {
        // Event belongs to a different request (boundary missing) → close the span.
        currentSpan.endMs = Math.max(currentSpan.endMs, currentSpan.startMs);
        spans.push(currentSpan);
        currentSpan = null;
      } else if (e.timestampMs >= currentSpan.startMs) {
        currentSpan.endMs = e.timestampMs;
      }
    }
  }
  if (currentSpan) spans.push(currentSpan);

  // Request durations for the boundary rows.
  for (const b of boundaries) {
    const last = b.timestampMs !== undefined && b.requestIndex !== undefined ? lastTsByRequest.get(b.requestIndex) : undefined;
    if (last !== undefined && b.timestampMs !== undefined && last > b.timestampMs) {
      b.durationMs = last - b.timestampMs;
    }
  }

  let maxRequest = 0;
  for (const e of events) {
    if (e.kind === 'turn_boundary' && e.requestIndex + 1 > maxRequest) maxRequest = e.requestIndex + 1;
  }
  stats.requests = maxRequest;
  meta.usage.modelRequests = Math.max(maxRequest, meta.usage.modelRequests);
  stats.filesChanged = fileChangeMap.size;
  stats.agents = Math.max(1, agents.size);
  stats.modelTimeMs = spans.filter((s) => s.track === 'model').reduce((a, s) => a + (s.endMs - s.startMs), 0);

  // Prefer line-level timestamps (they include non-event lines like session_meta).
  const startedAtMs = parseTimestampMs(meta.startedAt) ?? firstTimestampMs;
  const endedAtMs = parseTimestampMs(meta.endedAt) ?? lastTimestampMs;
  const durationMs =
    startedAtMs !== undefined && endedAtMs !== undefined && endedAtMs >= startedAtMs ? endedAtMs - startedAtMs : undefined;

  const warnings = [...meta.warnings];
  const skipped = Object.entries(meta.skippedTypes).filter(([, n]) => n > 0);
  if (skipped.length > 0) {
    warnings.push(`summarized non-event lines: ${skipped.map(([t, n]) => `${t}×${n}`).join(', ')}`);
  }

  const run: TraceRun = {
    id: runIdFor(input.provider, input.filePath, meta.sessionId),
    provider: input.provider,
    title: title ?? input.fileName,
    project: meta.project ?? projectFromPath(input.filePath),
    cwd: meta.cwd,
    gitRepo: meta.gitRepo,
    gitBranch: meta.gitBranch,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationMs,
    models: [...meta.models],
    usage: meta.usage,
    stats,
    filePath: input.filePath,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    mtimeMs: input.mtimeMs,
    live: Date.now() - input.mtimeMs < LIVE_WINDOW_MS,
    parserVersion: PARSER_VERSION,
    warnings,
  };

  const fileChanges = [...fileChangeMap.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { run, events, spans, fileChanges };
}

function projectFromPath(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return dir || path.basename(filePath);
}

/** Fast session summary for the library list — head/tail read only, no full parse. */
export async function summarizeTraceFile(
  filePath: string,
  provider?: TraceProvider,
): Promise<SessionSummary | null> {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  let head: unknown[];
  try {
    head = await readHeadLines(filePath, 512 * 1024);
  } catch {
    return null;
  }
  if (head.length === 0) return null;
  const adapter = provider ? getAdapter(provider) : detectAdapter(head);

  // Lightweight pass over head lines for title/models/cwd.
  let title: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  const models = new Set<string>();
  let startedAt: string | undefined;
  let sessionId: string | undefined;
  for (const line of head) {
    if (!line || typeof line !== 'object') continue;
    const o = line as Record<string, any>;
    if (!startedAt && typeof o.timestamp === 'string') startedAt = o.timestamp;
    if (typeof o.timestamp === 'string' && (!startedAt || o.timestamp < startedAt)) startedAt = o.timestamp;
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!gitBranch && typeof o.gitBranch === 'string') gitBranch = o.gitBranch;
    if (!sessionId && typeof o.sessionId === 'string') sessionId = o.sessionId;
    if (typeof o.message?.model === 'string') models.add(o.message.model);
    if (o.type === 'turn_context' && typeof o.payload?.model === 'string') models.add(o.payload.model);
    if (o.type === 'session_meta' && o.payload) {
      if (typeof o.payload.id === 'string') sessionId = o.payload.id;
      if (typeof o.payload.cwd === 'string') cwd = o.payload.cwd;
      if (typeof o.payload.git?.branch === 'string') gitBranch = o.payload.git.branch;
    }
    if (!title) {
      const t = headTitleOf(o);
      if (t) title = t;
    }
  }

  let endedAt: string | undefined;
  try {
    const tail = await readTailLines(filePath, 128 * 1024);
    endedAt = tail.lastTimestamp;
  } catch {
    /* ignore */
  }

  return {
    id: runIdFor(adapter.id, filePath, sessionId),
    provider: adapter.id,
    title: title ?? path.basename(filePath),
    project: cwd
      ? (cwd.split('/').filter(Boolean).pop() ?? cwd)
      : projectFromPath(filePath),
    startedAt,
    endedAt,
    models: [...models],
    filePath,
    fileName: path.basename(filePath),
    fileSizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    live: Date.now() - st.mtimeMs < LIVE_WINDOW_MS,
    gitBranch,
  };
}

function headTitleOf(o: Record<string, any>): string | undefined {
  // Claude Code human prompt.
  if (o.type === 'user' && typeof o.message?.content === 'string' && o.origin?.kind === 'human') {
    return oneLine(o.message.content, 120);
  }
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') return oneLine(o.customTitle, 120);
  // Codex user message (not an injected context block).
  if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'user') {
    const text = Array.isArray(o.payload.content)
      ? o.payload.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n').trim()
      : '';
    const trimmed = text.trimStart();
    if (text && !trimmed.startsWith('<') && !trimmed.startsWith('# Files mentioned')) return oneLine(text, 120);
  }
  return undefined;
}

/** Decode a Claude projects directory name ("-Users-foo-bar" → "/Users/foo/bar"). */
export function decodeClaudeDirName(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName;
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

/** Read raw JSON for one event's source line. */
export async function readEventRaw(handle: ParseHandle, event: TraceEvent): Promise<unknown | null> {
  if (!event.loc) return null;
  const raw = await readSlice(handle.filePath, event.loc.offset, event.loc.length);
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}
