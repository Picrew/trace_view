import { open, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

export interface RawLine {
  /** Byte offset of the line start. */
  offset: number;
  /** Byte length excluding the trailing newline. */
  length: number;
  text: string;
}

/**
 * Read a (possibly huge) NDJSON file line by line with byte offsets.
 * Splitting on 0x0A at the byte level is UTF-8 safe: multi-byte sequences
 * never contain 0x0A.
 *
 * `requireCompleteLastLine` skips a trailing unterminated line — used by live
 * tail so half-written lines are not parsed.
 */
export async function* readJsonlLines(
  filePath: string,
  opts: { requireCompleteLastLine?: boolean } = {},
): AsyncGenerator<RawLine> {
  const CHUNK = 1 << 20; // 1 MiB
  const handle = await open(filePath, 'r');
  try {
    let buffer = Buffer.alloc(0);
    let bufferStart = 0; // absolute byte offset of buffer[0]
    let scanned = 0; // consumed position within buffer
    while (true) {
      const chunk = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer.subarray(scanned), chunk.subarray(0, bytesRead)]);
      bufferStart += scanned;
      scanned = 0;
      let idx: number;
      while ((idx = buffer.indexOf(0x0a, scanned)) !== -1) {
        yield {
          offset: bufferStart + scanned,
          length: idx - scanned,
          text: buffer.subarray(scanned, idx).toString('utf8'),
        };
        scanned = idx + 1;
      }
    }
    if (scanned < buffer.length) {
      const rest = buffer.subarray(scanned);
      if (opts.requireCompleteLastLine !== true) {
        yield { offset: bufferStart + scanned, length: rest.length, text: rest.toString('utf8') };
      }
    }
  } finally {
    await handle.close();
  }
}

/** Read up to `bytes` from `position` and return the raw text. */
export async function readSlice(
  filePath: string,
  position: number,
  bytes: number,
): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, bytes));
    const { bytesRead } = await handle.read(buf, 0, bytes, position);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Parsed JSON lines from the head of a file (a partial final line is dropped). */
export async function readHeadLines(filePath: string, bytes: number): Promise<unknown[]> {
  const raw = await readSlice(filePath, 0, bytes);
  const lines: unknown[] = [];
  for (const part of raw.split('\n')) {
    const s = part.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      break; // partial tail line
    }
  }
  return lines;
}

/** Parsed JSON lines from the tail of a file, oldest first. */
export async function readTailLines(
  filePath: string,
  bytes: number,
): Promise<{ lines: unknown[]; lastTimestamp?: string }> {
  const size = (await stat(filePath)).size;
  const raw = await readSlice(filePath, Math.max(0, size - bytes), bytes);
  const lines: unknown[] = [];
  let lastTimestamp: string | undefined;
  const parts = raw.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      lines.push(obj);
      if (obj && typeof obj === 'object' && typeof (obj as any).timestamp === 'string') {
        lastTimestamp = (obj as any).timestamp;
      }
    } catch {
      if (i === parts.length - 1) continue; // partial last line
    }
  }
  return { lines, lastTimestamp };
}

/** Read a single line by byte offset (for raw-JSON detail lookups). */
export async function readLineAt(
  filePath: string,
  offset: number,
  length: number,
): Promise<unknown | null> {
  try {
    const raw = await readSlice(filePath, offset, length);
    const text = raw.trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
