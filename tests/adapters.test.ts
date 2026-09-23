import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { GenericAdapter } from '../src/core/adapters/generic.js';
import { defaultParseCtx } from '../src/core/adapter.js';
import { parseTraceFile, readEventRaw } from '../src/core/run-builder.js';
import type { TraceEvent } from '../src/core/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => path.join(__dirname, 'fixtures', name);

function parseAll(adapter: ClaudeAdapter | CodexAdapter | GenericAdapter, lines: string[]): TraceEvent[] {
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

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();
  const events = parseAll(adapter, readFixtureLines('claude-basic.jsonl'));

  it('detects claude-code files', () => {
    const head = readFixtureLines('claude-basic.jsonl').slice(0, 5).map((l) => JSON.parse(l));
    expect(adapter.detect(head)).toBe(true);
    expect(adapter.detect([{ foo: 1 }])).toBe(false);
  });

  it('produces the expected kind sequence', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'user_message',
      'turn_boundary',
      'reasoning',
      'assistant_message',
      'tool_call',
      'tool_result',
      'turn_boundary',
      'tool_call',
      'tool_result',
      'file_change',
      'turn_boundary',
      'assistant_message',
      'synthetic_message',
      'error',
      'user_message',
      'turn_boundary',
      'tool_call',
      'tool_result',
      'turn_boundary',
      'assistant_message',
      'synthetic_message',
      'turn_boundary',
      'assistant_message',
      'compaction',
      'system',
      'system',
      'system',
      'unknown',
    ]);
  });

  it('classifies human vs synthetic user messages', () => {
    const users = events.filter((e) => e.kind === 'user_message');
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ text: 'Fix the login bug in auth.ts' });
    const synth = events.filter((e) => e.kind === 'synthetic_message');
    expect(synth.map((s: any) => s.syntheticKind).sort()).toEqual(['compact-summary', 'meta']);
    const compact = synth.find((s: any) => s.syntheticKind === 'compact-summary')!;
    expect(compact.text).toContain('This session is being continued');
    const meta = synth.find((s: any) => s.syntheticKind === 'meta')!;
    expect(meta.text).toContain('(continuing)');
  });

  it('links tool calls to results with callId and duration', () => {
    const calls = events.filter((e): e is any => e.kind === 'tool_call');
    const results = events.filter((e): e is any => e.kind === 'tool_result');
    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'Edit', 'Bash']);
    expect(calls.map((c) => c.callId)).toEqual(results.map((r) => r.callId));
    expect(calls.map((c) => c.toolCategory)).toEqual(['read', 'edit', 'bash']);
    expect(results[0].durationMs).toBe(2000);
    expect(results[1].durationMs).toBe(3000);
    expect(results[2].durationMs).toBe(14000);
    expect(results[2].stdout).toBe('ok - 12 tests\n');
  });

  it('derives request boundaries from parent chains', () => {
    const boundaries = events.filter((e): e is any => e.kind === 'turn_boundary');
    expect(boundaries).toHaveLength(6);
    expect(boundaries.map((b) => b.requestIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(boundaries.every((b) => b.derived === true)).toBe(true);
  });

  it('extracts file changes from Edit structuredPatch', () => {
    const fc = events.filter((e): e is any => e.kind === 'file_change');
    expect(fc).toHaveLength(1);
    expect(fc[0]).toMatchObject({
      path: '/Users/demo/proj/src/auth.ts',
      changeType: 'modify',
      additions: 2,
      deletions: 1,
    });
    const causedBy = fc[0].causedByEventId;
    const call = events.find((e) => e.id === causedBy);
    expect(call?.kind).toBe('tool_call');
  });

  it('captures api errors with retry info', () => {
    const err = events.find((e): e is any => e.kind === 'error')!;
    expect(err.message).toContain('Request timed out.');
    expect(err.retryAttempt).toBe(1);
  });

  it('keeps unknown events with rawType', () => {
    const unk = events.filter((e): e is any => e.kind === 'unknown');
    expect(unk).toHaveLength(1);
    expect(unk[0].rawType).toBe('future-thing');
  });
});

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();
  const events = parseAll(adapter, readFixtureLines('codex-basic.jsonl'));

  it('detects codex files', () => {
    const head = readFixtureLines('codex-basic.jsonl').slice(0, 3).map((l) => JSON.parse(l));
    expect(adapter.detect(head)).toBe(true);
    expect(adapter.detect([{ type: 'user', message: {} }])).toBe(false);
  });

  it('produces the expected kind sequence', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'turn_boundary',
      'user_message',
      'reasoning',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'turn_boundary',
      'assistant_message',
      'file_change',
      'file_change',
      'compaction',
      'system',
      'synthetic_message',
      'turn_boundary',
      'user_message',
      'unknown',
    ]);
  });

  it('parses session metadata from session_meta', () => {
    const handle = parseAllMeta(adapter, readFixtureLines('codex-basic.jsonl'));
    expect(handle.cwd).toBe('/Users/demo/webapp');
    expect(handle.gitBranch).toBe('feat/dark-mode');
    expect(handle.gitRepo).toBe('https://github.com/demo/webapp.git');
    expect(handle.sessionId).toBe('01a04688-2d4a-74a3-ab20-348eb528609b');
  });

  it('handles legacy function_call and new custom_tool_call', () => {
    const calls = events.filter((e): e is any => e.kind === 'tool_call');
    expect(calls.map((c) => c.toolName)).toEqual(['shell', 'exec']);
    expect(calls.map((c) => c.toolCategory)).toEqual(['bash', 'bash']);
    expect(calls[0].summary).toBe('zsh -lc ls src');
    expect(calls[1].summary).toBe('npm test --grep settings');
    expect(calls[1].input).toContain('tools.exec_command');
    const results = events.filter((e): e is any => e.kind === 'tool_result');
    expect(results[0].output).toContain('settings.css');
    expect(results[1].output).toContain('3 tests passed');
    expect(results[0].durationMs).toBe(2000);
    expect(results[1].durationMs).toBe(4000);
  });

  it('marks injected context as synthetic', () => {
    const synth = events.find((e): e is any => e.kind === 'synthetic_message')!;
    expect(synth.syntheticKind).toBe('injected');
    expect(synth.text).toContain('user_instructions');
  });

  it('reads cumulative token usage from token_count', () => {
    const handle = parseAllMeta(adapter, readFixtureLines('codex-basic.jsonl'));
    expect(handle.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      reasoningTokens: 50,
      totalTokens: 1700,
      modelRequests: 3,
    });
  });

  it('emits file changes from item_completed', () => {
    const fc = events.filter((e): e is any => e.kind === 'file_change');
    expect(fc.map((f) => [f.path, f.changeType])).toEqual([
      ['/Users/demo/webapp/src/settings.css', 'modify'],
      ['/Users/demo/webapp/src/theme.ts', 'add'],
    ]);
  });

  it('assigns turn ids from turn_context', () => {
    const boundaries = events.filter((e): e is any => e.kind === 'turn_boundary');
    expect(boundaries.map((b) => b.turnId)).toEqual(['turn-001', 'turn-002', 'turn-003']);
    expect(boundaries[0].model).toBe('gpt-5.6-sol');
  });
});

describe('GenericAdapter', () => {
  const adapter = new GenericAdapter();
  const events = parseAll(adapter, readFixtureLines('generic-basic.jsonl'));

  it('classifies what it can and keeps the rest as unknown', () => {
    expect(events.map((e) => e.kind)).toEqual(['user_message', 'assistant_message', 'unknown', 'unknown']);
    expect(events[0]).toMatchObject({ text: 'Hello agent' });
  });
});

describe('parseTraceFile (integration)', () => {
  it('builds a full claude run with stats, spans and file changes', async () => {
    const handle = await parseTraceFile(FIX('claude-basic.jsonl'));
    const { run, events, spans, fileChanges } = handle.parsed;
    expect(run.provider).toBe('claude-code');
    expect(run.id.startsWith('claude-code:sess-1:')).toBe(true);
    expect(run.title).toBe('Login bug fix session');
    expect(run.cwd).toBe('/Users/demo/proj');
    expect(run.gitBranch).toBe('main');
    expect(run.models.sort()).toEqual(['claude-opus-4-8', 'claude-sonnet-5']);
    expect(run.startedAt).toBe('2026-09-20T10:00:00.000Z');
    expect(run.endedAt).toBe('2026-09-20T10:00:31.000Z');
    expect(run.durationMs).toBe(31000);
    expect(run.usage).toMatchObject({
      inputTokens: 14800,
      outputTokens: 140,
      cachedInputTokens: 12300,
      cacheWriteTokens: 200,
      reasoningTokens: 10,
      modelRequests: 6,
    });
    expect(run.stats).toMatchObject({
      events: 28,
      userMessages: 2,
      syntheticMessages: 2,
      assistantMessages: 4,
      reasoning: 1,
      toolCalls: 3,
      toolResults: 3,
      errors: 1,
      compactions: 1,
      requests: 6,
      commandsRun: 1,
      filesChanged: 1,
      toolTimeMs: 19000,
    });
    expect(run.stats.byTool).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(spans.filter((s) => s.track === 'model')).toHaveLength(6);
    expect(spans.filter((s) => s.spanKind === 'tool')).toHaveLength(3);
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]).toMatchObject({
      path: '/Users/demo/proj/src/auth.ts',
      additions: 2,
      deletions: 1,
    });
    // seq continuity
    expect(events[events.length - 1].seq).toBe(events.length - 1);
    // raw JSON retrieval by loc
    const firstUser = events.find((e) => e.kind === 'user_message')!;
    const raw = (await readEventRaw(handle, firstUser)) as any;
    expect(raw.type).toBe('user');
    expect(raw.message.content).toBe('Fix the login bug in auth.ts');
    // boundary durations patched
    const boundaries = events.filter((e): e is any => e.kind === 'turn_boundary');
    expect(boundaries[3].durationMs).toBe(14000); // bash request span
  });

  it('builds a full codex run', async () => {
    const handle = await parseTraceFile(FIX('codex-basic.jsonl'));
    const { run, events, spans, fileChanges } = handle.parsed;
    expect(run.provider).toBe('codex');
    expect(run.project).toBe('webapp');
    expect(run.title).toBe('Add a dark mode toggle to the settings page.');
    expect(run.gitRepo).toBe('https://github.com/demo/webapp.git');
    expect(run.durationMs).toBe(15000);
    expect(run.usage.totalTokens).toBe(1700);
    expect(run.stats).toMatchObject({
      userMessages: 2,
      syntheticMessages: 1,
      toolCalls: 2,
      requests: 3,
      fileChanges: 2,
      commandsRun: 2,
    });
    expect(spans.filter((s) => s.spanKind === 'tool')).toHaveLength(2);
    expect(fileChanges).toHaveLength(2);
    expect(events.every((e) => e.agentId === 'main')).toBe(true);
    // unknown future event kept
    expect(events.some((e) => e.kind === 'unknown')).toBe(true);
  });

  it('falls back to the generic adapter', async () => {
    const { parsed } = await parseTraceFile(FIX('generic-basic.jsonl'));
    expect(parsed.run.provider).toBe('generic');
    expect(parsed.run.title).toBe('Hello agent');
    expect(parsed.events).toHaveLength(4);
  });

  it('handles broken lines without dying', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `trace-review-test-${Date.now()}.jsonl`);
    const good = readFixtureLines('claude-basic.jsonl');
    const content = [...good.slice(0, 3), '{"type":"assistant","broken json', ...good.slice(3)].join('\n');
    await fs.writeFile(tmp, content, 'utf8');
    try {
      const { parsed } = await parseTraceFile(tmp);
      expect(parsed.run.warnings.join(' ')).toMatch(/unparseable/);
      expect(parsed.events.some((e) => e.kind === 'unknown')).toBe(true);
      expect(parsed.events.filter((e) => e.kind === 'user_message').length).toBe(2);
    } finally {
      await fs.rm(tmp);
    }
  });
});

/** Parse with the adapter and return final metadata (helper for meta assertions). */
function parseAllMeta(adapter: CodexAdapter, lines: string[]) {
  const state = adapter.createState();
  const ctx = defaultParseCtx(0);
  for (const line of lines) {
    adapter.parseLine(JSON.parse(line), { offset: 0, length: 0 }, state, ctx);
  }
  adapter.finalize(state, ctx);
  return state.meta as any;
}

// Real-data smoke test: runs only when this machine has real traces.
describe('real-data smoke (skipped when no local traces)', () => {
  const home = homedir();

  function firstJsonl(dir: string): string | null {
    if (!existsSync(dir)) return null;
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 5 || out.length > 0) return;
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = path.join(d, name);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name.endsWith('.jsonl')) {
          out.push(p);
          return;
        }
      }
    };
    walk(dir, 0);
    return out[0] ?? null;
  }

  it('parses a real claude-code session', async () => {
    const claudeDir = path.join(home, '.claude', 'projects');
    const file = firstJsonl(claudeDir);
    if (!file) return; // skip silently on machines without claude data
    const { parsed } = await parseTraceFile(file);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.run.provider).toBe('claude-code');
    expect(parsed.run.warnings.join('')).not.toContain('crash');
    console.log(
      `[smoke] claude ${path.basename(file)}: ${parsed.events.length} events, ` +
        `${parsed.run.stats.requests} requests, ${parsed.run.usage.totalTokens} tokens`,
    );
  }, 60_000);

  it('parses a real codex session', async () => {
    const codexDir = path.join(home, '.codex', 'sessions');
    const file = firstJsonl(codexDir);
    if (!file) return;
    const { parsed } = await parseTraceFile(file);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.run.provider).toBe('codex');
    console.log(
      `[smoke] codex ${path.basename(file)}: ${parsed.events.length} events, ` +
        `${parsed.run.stats.requests} requests, ${parsed.run.usage.totalTokens} tokens`,
    );
  }, 60_000);
});
