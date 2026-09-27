import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { RawLine } from './reader.js';

/**
 * OpenCode stores one session as three layers of pretty-printed JSON files
 * under `~/.local/share/opencode/storage/`:
 *
 *   session/<projectHash>/ses_<id>.json   — session metadata (title, cwd, times)
 *   message/ses_<id>/msg_<id>.json        — one file per message
 *   part/msg_<id>/prt_<id>.json           — one file per message part
 *
 * (tool calls/results, reasoning, steps all live in "parts"; a tool part
 * carries input AND output together in `state`).
 *
 * The rest of the pipeline is line-oriented (one JSONL file = one run), so
 * this projector collapses a session into a deterministic virtual JSONL
 * stream that the OpenCode adapter consumes like any other provider:
 *
 *   {"type":"oc_session", …}                       — session metadata
 *   {"type":"oc_message", message, parts:[…]}      — per message, parts embedded
 *
 * `loc` offsets of parsed events point into this virtual stream; the raw JSON
 * endpoint slices the projected text instead of the source file.
 */

export interface Projection {
  lines: RawLine[];
  /** The full virtual JSONL text (byte offsets in `lines` index into this). */
  text: string;
  totalBytes: number;
  /** Number of messages that failed to load (missing/corrupt files). */
  skippedMessages: number;
}

const READ_BATCH = 64;

export function looksLikeOpencodeSession(filePath: string): boolean {
  // …/storage/session/<projectHash>/ses_<id>.json
  return /[/\\]storage[/\\]session[/\\][^/\\]+[/\\]ses_[^/\\]+\.json$/.test(filePath);
}

/** Resolve the storage root from a session metadata file path. */
export function opencodeStorageRoot(sessionMetaPath: string): string {
  // dirname = storage/session/<hash> → up two levels = storage
  return path.resolve(path.dirname(sessionMetaPath), '..', '..');
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as Record<string, any>) : null;
  } catch {
    return null;
  }
}

async function readDirJson(dir: string): Promise<Record<string, any>[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return []; // missing dir is normal (session without messages)
  }
  const out: Record<string, any>[] = [];
  for (let i = 0; i < names.length; i += READ_BATCH) {
    const batch = names.slice(i, i + READ_BATCH);
    const objs = await Promise.all(batch.map((n) => readJson(path.join(dir, n))));
    for (let j = 0; j < batch.length; j++) {
      if (objs[j]) out.push(objs[j]!);
    }
  }
  return out;
}

/**
 * Project an OpenCode session into a virtual JSONL stream.
 * Messages are ordered by `time.created` (falling back to id); parts keep
 * their on-disk filename order, which matches insertion order.
 */
export async function projectOpencodeSession(
  sessionMetaPath: string,
  opts: { maxMessages?: number } = {},
): Promise<Projection> {
  const session = await readJson(sessionMetaPath);
  if (!session) throw new Error(`cannot read session metadata: ${sessionMetaPath}`);
  const storageRoot = opencodeStorageRoot(sessionMetaPath);
  const sessionId = typeof session.id === 'string' ? session.id : path.basename(sessionMetaPath, '.json');

  let messages = await readDirJson(path.join(storageRoot, 'message', sessionId));
  messages = messages
    .map((m, i) => ({ m, key: typeof m.time?.created === 'number' ? m.time.created : Number.MAX_SAFE_INTEGER - i }))
    .sort((a, b) => a.key - b.key || String(a.m.id ?? '').localeCompare(String(b.m.id ?? '')))
    .map((x) => x.m);
  if (opts.maxMessages !== undefined) messages = messages.slice(0, opts.maxMessages);

  const texts: string[] = [JSON.stringify({ type: 'oc_session', ...session })];
  let skippedMessages = 0;
  for (const message of messages) {
    const msgId = typeof message.id === 'string' ? message.id : '';
    if (!msgId) {
      skippedMessages++;
      continue;
    }
    const parts = await readDirJson(path.join(storageRoot, 'part', msgId));
    texts.push(JSON.stringify({ type: 'oc_message', message, parts }));
  }

  // Build byte-accurate line index over the virtual stream.
  const lines: RawLine[] = [];
  let offset = 0;
  for (const text of texts) {
    const length = Buffer.byteLength(text, 'utf8');
    lines.push({ offset, length, text });
    offset += length + 1; // + newline
  }
  return { lines, text: texts.join('\n') + '\n', totalBytes: offset, skippedMessages };
}
