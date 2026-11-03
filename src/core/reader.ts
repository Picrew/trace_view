import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

const CHUNK = 1 << 20; // 1 MiB

/** Node ≥ 22.15 / 23.8 ships zstd in zlib; older runtimes simply skip .zst traces. */
export const ZSTD_SUPPORTED = typeof zlib.createZstdDecompress === 'function';

/**
 * Codex compresses finished rollouts in place (`x.jsonl` → `x.jsonl.zst`).
 * For these files every offset (`loc`, `byteOffset`) is in decompressed bytes;
 * zstd has no random access, so reads stream from the start.
 */
export function isZstdPath(filePath: string): boolean {
  return filePath.endsWith('.zst');
}

function zstdChunks(filePath: string): AsyncIterable<Buffer> {
  if (!ZSTD_SUPPORTED) throw new Error('Reading .zst traces needs Node ≥ 22.15');
  // pipeline() tears down the file stream when the consumer stops early;
  // real errors still surface through the async iterator.
  return pipeline(
    createReadStream(filePath, { highWaterMark: CHUNK }),
    zlib.createZstdDecompress({ chunkSize: CHUNK }),
    () => {},
  );
}

/**
 * Decompressed size recorded in the first zstd frame header (Frame_Content_Size).
 * Cheap size hint for parse budgets; undefined when the encoder omitted it.
 */
export async function zstdContentSize(filePath: string): Promise<number | undefined> {
  const handle = await open(filePath, 'r');
  try {
    const h = Buffer.alloc(18); // magic(4) + descriptor(1) + window(1) + dict id(≤4) + FCS(≤8)
    const { bytesRead } = await handle.read(h, 0, h.length, 0);
    if (bytesRead < 6 || h.readUInt32LE(0) !== 0xfd2fb528) return undefined;
    const descriptor = h[4]!;
    const singleSegment = (descriptor >> 5) & 1;
    const fcsBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6]!;
    const pos = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]!;
    if (fcsBytes === 0 || bytesRead < pos + fcsBytes) return undefined;
    if (fcsBytes === 1) return h[pos];
    if (fcsBytes === 2) return h.readUInt16LE(pos) + 256;
    if (fcsBytes === 4) return h.readUInt32LE(pos);
    return Number(h.readBigUInt64LE(pos));
  } finally {
    await handle.close();
  }
}

/** Content chunks of a trace file, decompressing `.zst` transparently. */
async function* readChunks(filePath: string): AsyncGenerator<Buffer> {
  if (isZstdPath(filePath)) {
    yield* zstdChunks(filePath);
    return;
  }
  const handle = await open(filePath, 'r');
  try {
    while (true) {
      const chunk = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
      if (bytesRead === 0) break;
      yield chunk.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** Decompressed bytes [position, position + bytes) — stops reading once covered. */
async function readZstdRange(filePath: string, position: number, bytes: number): Promise<Buffer> {
  if (bytes <= 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let pos = 0;
  let got = 0;
  for await (const chunk of readChunks(filePath)) {
    const end = pos + chunk.length;
    if (end > position) {
      const from = Math.max(0, position - pos);
      const take = Math.min(chunk.length - from, bytes - got);
      parts.push(chunk.subarray(from, from + take));
      got += take;
      if (got >= bytes) break;
    }
    pos = end;
  }
  return Buffer.concat(parts);
}

/** Last `bytes` decompressed bytes (the whole stream is read; only a window is kept). */
async function readZstdTail(filePath: string, bytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let kept = 0;
  for await (const chunk of readChunks(filePath)) {
    parts.push(chunk);
    kept += chunk.length;
    while (parts.length > 1 && kept - parts[0]!.length >= bytes) kept -= parts.shift()!.length;
  }
  const all = Buffer.concat(parts);
  return all.subarray(Math.max(0, all.length - bytes));
}

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
  let buffer = Buffer.alloc(0);
  let bufferStart = 0; // absolute byte offset of buffer[0]
  let scanned = 0; // consumed position within buffer
  for await (const chunk of readChunks(filePath)) {
    buffer = Buffer.concat([buffer.subarray(scanned), chunk]);
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
}

/** Read up to `bytes` from `position` and return the raw text. */
export async function readSlice(
  filePath: string,
  position: number,
  bytes: number,
): Promise<string> {
  if (isZstdPath(filePath)) return (await readZstdRange(filePath, position, bytes)).toString('utf8');
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
  let raw: string;
  if (isZstdPath(filePath)) {
    raw = (await readZstdTail(filePath, bytes)).toString('utf8');
  } else {
    const size = (await stat(filePath)).size;
    raw = await readSlice(filePath, Math.max(0, size - bytes), bytes);
  }
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
