import type { ToolCallEvent, ToolResultEvent, TraceEvent } from './types.js';

export interface ToolPair {
  call?: ToolCallEvent;
  result?: ToolResultEvent;
}

export type Row =
  | { kind: 'event'; key: string; event: TraceEvent }
  | { kind: 'tool'; key: string; pair: ToolPair }
  | { kind: 'aggregate'; key: string; pairs: ToolPair[] };

/** Aggregate consecutive tool runs longer than this into one collapsible row. */
const AGGREGATE_THRESHOLD = 4;

export function buildRows(events: TraceEvent[]): Row[] {
  const resultsByCallId = new Map<string, ToolResultEvent>();
  const calledCallIds = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_call') calledCallIds.add(e.callId);
    else if (e.kind === 'tool_result') resultsByCallId.set(e.callId, e);
  }

  const rows: Row[] = [];
  let toolBuffer: ToolPair[] = [];
  let aggIndex = 0;

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length >= AGGREGATE_THRESHOLD) {
      rows.push({ kind: 'aggregate', key: `agg-${aggIndex++}`, pairs: toolBuffer });
    } else {
      for (const pair of toolBuffer) {
        rows.push({ kind: 'tool', key: pair.call?.id ?? pair.result?.id ?? `t-${rows.length}`, pair });
      }
    }
    toolBuffer = [];
  };

  for (const e of events) {
    if (e.kind === 'tool_call') {
      toolBuffer.push({ call: e, result: resultsByCallId.get(e.callId) });
      continue;
    }
    if (e.kind === 'tool_result') {
      if (calledCallIds.has(e.callId)) continue; // paired with its call
      toolBuffer.push({ result: e }); // orphan result
      continue;
    }
    flushTools();
    rows.push({ kind: 'event', key: e.id, event: e });
  }
  flushTools();
  return rows;
}

/** Map every contained event id → row index (for jump-to-event). */
export function rowIndexByEvent(rows: Row[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.kind === 'event') map.set(row.event.id, i);
    else if (row.kind === 'tool') {
      if (row.pair.call) map.set(row.pair.call.id, i);
      if (row.pair.result) map.set(row.pair.result.id, i);
    } else {
      for (const p of row.pairs) {
        if (p.call) map.set(p.call.id, i);
        if (p.result) map.set(p.result.id, i);
      }
    }
  });
  return map;
}
