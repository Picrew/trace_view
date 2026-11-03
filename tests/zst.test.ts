import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import {
  ZSTD_SUPPORTED,
  readHeadLines,
  readJsonlLines,
  readSlice,
  readTailLines,
  zstdContentSize,
} from '../src/core/reader.js';
import { parseTraceFile, readEventRaw, summarizeTraceFile } from '../src/core/run-builder.js';
import { Library } from '../src/server/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => path.join(__dirname, 'fixtures', name);

/** Write `text` both plain and as `<name>.zst` into `dir`; returns [plain, zst]. */
async function writePair(dir: string, name: string, text: string): Promise<[string, string]> {
  const plain = path.join(dir, name);
  const zst = `${plain}.zst`;
  await writeFile(plain, text);
  await writeFile(zst, zlib.zstdCompressSync(Buffer.from(text)));
  return [plain, zst];
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe.skipIf(!ZSTD_SUPPORTED)('.jsonl.zst traces', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'trace-review-zst-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads lines, slices, head and tail identically to the plain file', async () => {
    // ~3 MiB so reads cross the 1 MiB chunk boundaries; multi-byte text checks UTF-8 safety.
    const lines = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({ i, timestamp: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z`, pad: '轨迹'.repeat(160 + (i % 7)) }),
    );
    const text = `${lines.join('\n')}\n`;
    const [plain, zst] = await writePair(tmp, 'big.jsonl', text);

    const a = await collect(readJsonlLines(plain));
    const b = await collect(readJsonlLines(zst));
    expect(b).toHaveLength(3000);
    expect(b).toEqual(a);

    const mid = a[1500]!;
    expect(await readSlice(zst, mid.offset, mid.length)).toBe(mid.text);
    // A slice that straddles the first 1 MiB chunk boundary.
    expect(await readSlice(zst, (1 << 20) - 100, 300)).toBe(await readSlice(plain, (1 << 20) - 100, 300));

    expect(await readHeadLines(zst, 64 * 1024)).toEqual(await readHeadLines(plain, 64 * 1024));
    expect(await readTailLines(zst, 128 * 1024)).toEqual(await readTailLines(plain, 128 * 1024));
    expect(await zstdContentSize(zst)).toBe(Buffer.byteLength(text));
  });

  it('parses a compressed codex rollout like the plain one', async () => {
    const dir = path.join(tmp, 'parse');
    await mkdir(dir);
    const [plain, zst] = await writePair(dir, 'rollout.jsonl', await readFile(FIX('codex-basic.jsonl'), 'utf8'));

    const p = await parseTraceFile(plain);
    const z = await parseTraceFile(zst);
    expect(z.parsed.run.provider).toBe('codex');
    expect(z.parsed.run.id).toBe(p.parsed.run.id); // id survives in-place compression
    expect(z.parsed.run.title).toBe(p.parsed.run.title);
    expect(z.parsed.run.stats).toEqual(p.parsed.run.stats);
    expect(z.parsed.events).toEqual(p.parsed.events);
    expect(z.byteOffset).toBe(p.byteOffset);

    // Raw-JSON lookups use decompressed offsets.
    const ev = z.parsed.events.find((e) => e.kind === 'user_message')!;
    expect(await readEventRaw(z, ev)).toEqual(await readEventRaw(p, ev));

    const sp = await summarizeTraceFile(plain);
    const sz = await summarizeTraceFile(zst);
    expect(sz).toMatchObject({
      id: sp!.id,
      provider: 'codex',
      title: sp!.title,
      startedAt: sp!.startedAt,
      endedAt: sp!.endedAt,
      fileName: 'rollout.jsonl.zst',
    });
  });

  it('library scan collects .jsonl.zst and prefers the plain file mid-compression', async () => {
    const root = path.join(tmp, 'codex');
    const day = path.join(root, '2026', '09', '12');
    await mkdir(day, { recursive: true });
    const codex = await readFile(FIX('codex-basic.jsonl'), 'utf8');
    const withId = (id: string) => codex.replace('01a04688-2d4a-74a3-ab20-348eb528609b', id);
    await writeFile(path.join(day, 'a.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(withId('aaaa'))));
    await writeFile(path.join(day, 'b.jsonl'), withId('bbbb'));
    await writePair(day, 'c.jsonl', withId('cccc')); // both c.jsonl and c.jsonl.zst

    // Library persists its cache under $HOME — point it at the temp dir.
    const realHome = process.env.HOME;
    process.env.HOME = tmp;
    let lib: Library;
    try {
      lib = new Library({
        claudeDir: path.join(tmp, 'none'),
        codexDir: root,
        archivedCodexDir: path.join(tmp, 'none'),
        opencodeDir: path.join(tmp, 'none'),
        piDir: path.join(tmp, 'none'),
        extraDirs: [],
      });
    } finally {
      process.env.HOME = realHome;
    }
    await lib.scan(true);
    const names = lib.all().map((s) => s.fileName).sort();
    expect(names).toEqual(['a.jsonl.zst', 'b.jsonl', 'c.jsonl']);
    expect(lib.all().every((s) => s.provider === 'codex')).toBe(true);
  });
});
