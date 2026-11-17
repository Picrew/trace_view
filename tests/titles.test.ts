import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { defaultParseCtx } from '../src/core/adapter.js';
import { summarizeTraceFile } from '../src/core/run-builder.js';
import type { TraceEvent } from '../src/core/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseLines(adapter: ClaudeAdapter, lines: unknown[]): TraceEvent[] {
  const state = adapter.createState();
  const ctx = defaultParseCtx(0);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    events.push(...adapter.parseLine(line, { offset: 0, length: 0 }, state, ctx));
  }
  events.push(...adapter.finalize(state, ctx));
  return events;
}

function tmpFixture(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-review-titles-'));
  const file = path.join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const claudeUserLine = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  parentUuid: null,
  sessionId: 'sess-t',
  timestamp: '2026-11-17T10:00:00.000Z',
  cwd: '/Users/demo/proj',
  gitBranch: 'main',
  origin: { kind: 'human' },
  message: { content: text },
});

const aiTitleLine = (title: string) => ({
  type: 'ai-title',
  sessionId: 'sess-t',
  aiTitle: title,
});

describe('Claude Code ai-title (v2.1.270+)', () => {
  it('uses the LAST ai-title, like the resume list does', async () => {
    const file = tmpFixture('ai-title.jsonl', [
      claudeUserLine('u1', 'Fix the login bug'),
      aiTitleLine('Login bug fix'),
      aiTitleLine('Login bug fix — auth flow'),
      aiTitleLine('Auth flow refactor'),
    ]);
    const { parsed } = await import('../src/core/run-builder.js').then((m) => m.parseTraceFile(file));
    expect(parsed.run.title).toBe('Auth flow refactor');
  });

  it('prefers a user-set custom-title over ai-title', async () => {
    const file = tmpFixture('custom-over-ai.jsonl', [
      claudeUserLine('u1', 'Fix the login bug'),
      aiTitleLine('Login bug fix'),
      { type: 'custom-title', sessionId: 'sess-t', customTitle: 'My own title' },
      aiTitleLine('Later ai title'), // never overrides a custom title
    ]);
    const { parsed } = await import('../src/core/run-builder.js').then((m) =>
      m.parseTraceFile(file),
    );
    expect(parsed.run.title).toBe('My own title');
  });

  it('falls back to the first user message without title lines', async () => {
    const file = tmpFixture('no-title.jsonl', [claudeUserLine('u1', 'Fix the login bug')]);
    const { parsed } = await import('../src/core/run-builder.js').then((m) => m.parseTraceFile(file));
    expect(parsed.run.title).toBe('Fix the login bug');
  });

  it('summarize head scan: last ai-title wins over earlier user message', async () => {
    const file = tmpFixture('ai-title-summary.jsonl', [
      claudeUserLine('u1', 'Fix the login bug'),
      aiTitleLine('Login bug fix'),
      aiTitleLine('Auth flow refactor'),
    ]);
    const summary = await summarizeTraceFile(file);
    expect(summary?.title).toBe('Auth flow refactor');
  });

  it('summarize head scan: first user message stays when later messages appear', async () => {
    const file = tmpFixture('fallback-first.jsonl', [
      claudeUserLine('u1', 'List the test files'),
      claudeUserLine('u2', 'continue'),
    ]);
    const summary = await summarizeTraceFile(file);
    expect(summary?.title).toBe('List the test files');
  });

  it('adapter counts ai-title lines without emitting events', () => {
    const events = parseLines(new ClaudeAdapter(), [
      claudeUserLine('u1', 'Fix the login bug'),
      aiTitleLine('Login bug fix'),
    ]);
    expect(events.every((e) => e.kind === 'user_message')).toBe(true);
  });
});

describe('Codex session-index titles', () => {
  const codexSessionMeta = (id: string) => ({
    timestamp: '2026-11-17T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      cwd: '/Users/demo/webapp',
      originator: 'codex_vscode',
      git: { branch: 'main' },
    },
  });
  const codexUserLine = (text: string) => ({
    timestamp: '2026-11-17T10:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

  it('resolves the title through the injected resolver', async () => {
    const file = tmpFixture('rollout-1.jsonl', [
      codexSessionMeta('01a1e804-dbb8-7ef1-8a7c-9234dcb5b2f9'),
      codexUserLine('Add a dark mode toggle'),
    ]);
    const summary = await summarizeTraceFile(file, undefined, {
      titleResolver: async (provider, sessionId) => {
        expect(provider).toBe('codex');
        return sessionId === '01a1e804-dbb8-7ef1-8a7c-9234dcb5b2f9'
          ? '[UI]-暗色模式'
          : undefined;
      },
    });
    expect(summary?.title).toBe('[UI]-暗色模式');
  });

  it('falls back to the first user message when the resolver misses', async () => {
    const file = tmpFixture('rollout-2.jsonl', [
      codexSessionMeta('not-in-index'),
      codexUserLine('Add a dark mode toggle'),
    ]);
    const summary = await summarizeTraceFile(file, undefined, {
      titleResolver: async () => undefined,
    });
    expect(summary?.title).toBe('Add a dark mode toggle');
  });
});

describe('CodexTitleIndex', () => {
  it('maps session id to the LATEST thread_name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trace-review-idx-'));
    const indexPath = path.join(dir, 'session_index.jsonl');
    writeFileSync(
      indexPath,
      [
        { id: 's1', thread_name: 'Old name', updated_at: '2026-11-16T00:00:00Z' },
        { id: 's1', thread_name: 'New name', updated_at: '2026-11-17T00:00:00Z' },
        { id: 's2', thread_name: 'Another', updated_at: '2026-11-17T01:00:00Z' },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    const { CodexTitleIndex } = await import('../src/server/codex-index.js');
    const index = new CodexTitleIndex(indexPath);
    expect(await index.get('s1')).toBe('New name');
    expect(await index.get('s2')).toBe('Another');
    expect(await index.get('s3')).toBeUndefined();
  });

  it('returns nothing when the index file is missing', async () => {
    const { CodexTitleIndex } = await import('../src/server/codex-index.js');
    const index = new CodexTitleIndex(path.join(tmpdir(), 'no-such-index.jsonl'));
    expect(await index.get('s1')).toBeUndefined();
  });
});
