import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TraceEvent } from '../core/schema.js';
import type { ParseHandle } from '../core/run-builder.js';

/** Remove server-only fields and over-size payloads before sending to the UI. */
export function stripForTransport(event: TraceEvent): TraceEvent {
  const { loc: _loc, ...rest } = event as TraceEvent & { loc?: unknown };
  void _loc;
  if (rest.kind === 'tool_call' && rest.input !== undefined) {
    (rest as any).input = shrinkValue(rest.input, 16_384);
  }
  return rest;
}

function shrinkValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? value.slice(0, maxChars) : value;
  }
  if (Array.isArray(value)) {
    return value.length > 100 ? value.slice(0, 100) : value.map((v) => shrinkValue(v, maxChars));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = shrinkValue(v, maxChars);
    }
    return out;
  }
  return value;
}

export interface SearchMatch {
  eventId: string;
  seq: number;
  kind: TraceEvent['kind'];
  toolName?: string;
  timestamp?: string;
  /** Snippet with the match highlighted by ⌷ markers. */
  snippet: string;
}

/** Full-text search across everything we keep in memory for the run. */
export function searchEvents(events: TraceEvent[], query: string, limit = 200): SearchMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const matches: SearchMatch[] = [];
  for (const e of events) {
    let haystack = '';
    switch (e.kind) {
      case 'user_message':
      case 'synthetic_message':
      case 'assistant_message':
      case 'reasoning':
        haystack = e.text ?? '';
        break;
      case 'tool_call':
        haystack = `${e.toolName} ${e.summary} ${safeStringify(e.input)}`;
        break;
      case 'tool_result':
        haystack = `${e.toolName ?? ''} ${e.output ?? ''} ${e.stdout ?? ''} ${e.stderr ?? ''} ${e.filePath ?? ''}`;
        break;
      case 'error':
        haystack = e.message;
        break;
      case 'compaction':
        haystack = e.text ?? 'compaction';
        break;
      case 'system':
        haystack = `${e.subtype ?? ''} ${e.text ?? ''}`;
        break;
      case 'file_change':
        haystack = e.path;
        break;
      case 'turn_boundary':
        haystack = `request ${e.requestIndex + 1} ${e.model ?? ''} ${e.turnId ?? ''}`;
        break;
      default:
        haystack = `${(e as any).rawType ?? ''} ${(e as any).note ?? ''}`;
    }
    const idx = haystack.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    matches.push({
      eventId: e.id,
      seq: e.seq,
      kind: e.kind,
      toolName: e.kind === 'tool_call' ? e.toolName : e.kind === 'tool_result' ? e.toolName : undefined,
      timestamp: e.timestamp,
      snippet: makeSnippet(haystack, idx, q.length),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

function makeSnippet(text: string, idx: number, matchLen: number): string {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + matchLen + 80);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim();
  return `${prefix}${body}${suffix}`;
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 2000 ? s.slice(0, 2000) : (s ?? '');
  } catch {
    return '';
  }
}

/** SSE headers + no-buffering for event streams. */
export function initSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

export function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function eventBySeq(handle: ParseHandle, eventId: string): TraceEvent | undefined {
  const seq = Number(eventId.replace(/^e/, ''));
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  return handle.parsed.events.find((e) => e.seq === seq);
}
