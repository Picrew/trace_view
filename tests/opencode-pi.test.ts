import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { PiAdapter } from '../src/core/adapters/pi.js';
import { OpencodeAdapter } from '../src/core/adapters/opencode.js';
import { defaultParseCtx } from '../src/core/adapter.js';
import {
  parseTraceFile,
  readEventRaw,
  summarizeTraceFile,
} from '../src/core/run-builder.js';
import { projectOpencodeSession } from '../src/core/opencode-projector.js';
import { parseUnifiedDiff } from '../src/core/util.js';
import type { TraceEvent } from '../src/core/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => path.join(__dirname, 'fixtures', name);

function parseLines(
  adapter: PiAdapter | OpencodeAdapter,
  lines: string[],
): TraceEvent[] {
  const state = adapter.createState();
  const ctx = defaultParseCtx(0);
  const events: TraceEvent[] = [];
  let offset = 0;
  for (const line of lines) {
    const loc = { offset, length: Buffer.byteLength(line) };
    offset += loc.length + 1;
    events.push(...adapter.parseLine(JSON.parse(line), loc, state, ctx));
  }
  events.push(...adapter.finalize(state, ctx));
  return events;
}

function readFixtureLines(name: string): string[] {
  return readFileSync(FIX(name), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

describe('PiAdapter', () => {
  const adapter = new PiAdapter();
  const lines = readFixtureLines('pi-sample.jsonl');
  const events = parseLines(adapter, lines);

  it('detects pi files', () => {
    const head = lines.slice(0, 5).map((l) => JSON.parse(l));
    expect(adapter.detect(head)).toBe(true);
    expect(adapter.detect([{ type: 'user', message: { content: 'x' } }])).toBe(false);
  });

  it('produces the expected kind sequence', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'user_message',
      'turn_boundary', // a1
      'reasoning',
      'tool_call',
      'tool_result', // r1
      'turn_boundary', // a2
      'assistant_message',
      'turn_boundary', // a3
      'error',
      'user_message', // u2 (with image)
      'compaction',
    ]);
  });

  it('pairs tool call and result by callId with a real duration', () => {
    const call = events.find((e) => e.kind === 'tool_call');
    const result = events.find((e) => e.kind === 'tool_result');
    expect(call && result && (call as any).callId === (result as any).callId).toBe(true);
    expect(result && (result as any).output).toBe('a.test.ts\nb.test.ts');
    if (call?.timestampMs !== undefined && result?.timestampMs !== undefined) {
      expect(result.timestampMs - call.timestampMs).toBe(500);
    }
  });

  it('marks user messages with images', () => {
    const u2 = events.filter((e) => e.kind === 'user_message')[1] as any;
    expect(u2.hasImages).toBe(true);
  });
});

describe('Pi end-to-end (parseTraceFile)', () => {
  it('summarizes and parses a real-shaped pi session', async () => {
    const file = FIX('pi-sample.jsonl');
    const summary = await summarizeTraceFile(file);
    expect(summary?.provider).toBe('pi');
    expect(summary?.title).toContain('列出这个目录里的所有测试文件');
    expect(summary?.project).toBe('proj');
    expect(summary?.models).toContain('gpt-5.6-sol');

    const handle = await parseTraceFile(file, { provider: summary!.provider });
    const run = handle.parsed.run;
    expect(run.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 50,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      totalTokens: 385,
      modelRequests: 3,
    });
    expect(run.stats.requests).toBe(3);
    expect(run.stats.toolCalls).toBe(1);
    expect(run.cwd).toBe('/Users/demo/proj');

    // Raw JSON round-trip for the tool call.
    const call = handle.parsed.events.find((e) => e.kind === 'tool_call')!;
    const raw = (await readEventRaw(handle, call)) as any;
    expect(raw.type).toBe('message');
    expect(raw.message.role).toBe('assistant');
  });
});

describe('parseUnifiedDiff', () => {
  it('parses hunks with counts', () => {
    const patches = parseUnifiedDiff(
      '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n fn() {\n-  old\n+  new\n }',
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.oldFile).toBe('a/src/app.ts');
    expect(patches[0]!.hunks).toHaveLength(1);
    expect(patches[0]!.hunks[0]!.lines).toEqual([' fn() {', '-  old', '+  new', ' }']);
  });

  it('handles /dev/null as a new file', () => {
    const patches = parseUnifiedDiff(
      '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.oldFile).toBeUndefined();
    expect(patches[0]!.newFile).toBe('b/new.ts');
    expect(patches[0]!.hunks[0]!.lines).toEqual(['+one', '+two']);
  });
});

describe('OpenCode projector', () => {
  const sessionPath = FIX('opencode-storage/session/projhash1/ses_test0001.json');

  it('projects session + messages with byte-accurate offsets', async () => {
    const projection = await projectOpencodeSession(sessionPath);
    expect(projection.lines).toHaveLength(3); // session + user + assistant
    expect(projection.lines[0]!.offset).toBe(0);
    // offsets are contiguous: offset[n] = offset[n-1] + length[n-1] + 1
    for (let i = 1; i < projection.lines.length; i++) {
      expect(projection.lines[i]!.offset).toBe(
        projection.lines[i - 1]!.offset + projection.lines[i - 1]!.length + 1,
      );
    }
    // slicing the joined text by any line's loc returns that exact line
    for (const line of projection.lines) {
      const sliced = Buffer.from(projection.text, 'utf8')
        .subarray(line.offset, line.offset + line.length)
        .toString('utf8');
      expect(sliced).toBe(line.text);
    }
    const first = JSON.parse(projection.lines[0]!.text);
    expect(first.type).toBe('oc_session');
    const second = JSON.parse(projection.lines[1]!.text);
    expect(second.type).toBe('oc_message');
    expect(second.message.role).toBe('user'); // created sorts before assistant
    expect(projection.totalBytes).toBe(Buffer.byteLength(projection.text, 'utf8'));
  });
});

describe('OpenCode end-to-end (parseTraceFile)', () => {
  const sessionPath = FIX('opencode-storage/session/projhash1/ses_test0001.json');

  it('summarizes the session', async () => {
    const summary = await summarizeTraceFile(sessionPath, 'opencode');
    expect(summary?.provider).toBe('opencode');
    expect(summary?.title).toBe('Fixture 会话标题');
    expect(summary?.project).toBe('fixture-app');
    expect(summary?.models).toContain('claude-opus-4.5');
    expect(summary?.fileSizeBytes).toBeGreaterThan(1000);
  });

  it('parses parts into the unified schema', async () => {
    const handle = await parseTraceFile(sessionPath, { provider: 'opencode' });
    const events = handle.parsed.events;
    expect(events.map((e) => e.kind)).toEqual([
      'user_message',
      'turn_boundary', // step-start 1
      'reasoning',
      'tool_call', // bash
      'tool_result',
      'turn_boundary', // step-start 2
      'tool_call', // edit
      'tool_result',
      'file_change', // from edit diff
      'file_change', // from patch part
      'assistant_message',
    ]);

    const run = handle.parsed.run;
    expect(run.usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cachedInputTokens: 20,
      cacheWriteTokens: 5,
      reasoningTokens: 10,
      totalTokens: 455,
      modelRequests: 2,
    });
    expect(run.title).toBe('Fixture 会话标题');
    expect(run.cwd).toBe('/Users/demo/fixture-app');
    expect(run.notes.join(' ')).toContain('subagent of ses_parent01');

    // Edit result carries the structured patch…
    const editResult = events.find(
      (e) => e.kind === 'tool_result' && (e as any).toolName === 'edit',
    ) as any;
    expect(editResult.structuredPatch).toHaveLength(1);
    expect(editResult.structuredPatch[0].hunks[0].lines).toEqual([
      ' function main() {',
      '-  old line',
      '+  new line',
      ' }',
    ]);

    // …and the diff feeds Files Changed with counts.
    const fromDiff = handle.parsed.fileChanges[0];
    expect(fromDiff.path).toBe('/Users/demo/fixture-app/src/app.ts');
    expect(fromDiff.additions).toBe(1);
    expect(fromDiff.deletions).toBe(1);

    // Raw JSON slices come from the virtual stream.
    const bashCall = events.find((e) => e.kind === 'tool_call')!;
    const raw = (await readEventRaw(handle, bashCall)) as any;
    expect(raw.type).toBe('oc_message');
    expect(raw.message.role).toBe('assistant');
    expect(Array.isArray(raw.parts)).toBe(true);
  });
});
