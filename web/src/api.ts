import type { FileChangeSummary, SessionSummary, TimelineSpan, TraceEvent, TraceRun } from './types.js';

export interface LibraryResponse {
  sessions: SessionSummary[];
  dirs: { claudeDir: string; codexDir: string; archivedCodexDir: string; extraDirs: string[] };
  lastScan: number;
}

export interface RunDetail {
  run: TraceRun;
  spans: TimelineSpan[];
  fileChanges: FileChangeSummary[];
}

export interface SearchMatch {
  eventId: string;
  seq: number;
  kind: TraceEvent['kind'];
  toolName?: string;
  timestamp?: string;
  snippet: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  library: (refresh = false) => json<LibraryResponse>(`/api/library${refresh ? '?refresh=1' : ''}`),
  run: (runId: string) => json<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
  events: (runId: string) => json<{ events: TraceEvent[] }>(`/api/runs/${encodeURIComponent(runId)}/events`),
  raw: (runId: string, eventId: string) =>
    json<{ event: TraceEvent; raw: unknown }>(
      `/api/runs/${encodeURIComponent(runId)}/raw/${encodeURIComponent(eventId)}`,
    ),
  search: (runId: string, q: string, limit = 200) =>
    json<{ query: string; matches: SearchMatch[] }>(
      `/api/runs/${encodeURIComponent(runId)}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  importPath: (path: string) =>
    json<{ imported: number; sessions: SessionSummary[] }>('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
};

export function openStream(
  runId: string,
  cursor: number,
  onBatch: (msg: { events: TraceEvent[]; run: TraceRun; spans: TimelineSpan[]; fileChanges: FileChangeSummary[] }) => void,
  onReset: () => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    // Environment without SSE (very old browsers, test DOMs) — no live tail.
    return () => undefined;
  }
  const es = new EventSource(
    `/api/runs/${encodeURIComponent(runId)}/stream?cursor=${cursor}`,
  );
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { type: string } & Parameters<typeof onBatch>[0];
      if (msg.type === 'batch') onBatch(msg);
      else if (msg.type === 'reset') onReset();
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => es.close();
}
