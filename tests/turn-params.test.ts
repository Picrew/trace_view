import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeAdapter } from '../src/core/adapters/claude.js';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { defaultParseCtx } from '../src/core/adapter.js';
import { parseTraceFile } from '../src/core/run-builder.js';
import type { TurnBoundaryEvent, TraceEvent } from '../src/core/schema.js';

function tmpFixture(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-review-turns-'));
  const file = path.join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function boundaries(events: TraceEvent[]): TurnBoundaryEvent[] {
  return events.filter((e): e is TurnBoundaryEvent => e.kind === 'turn_boundary');
}

describe('Codex turn_context params', () => {
  it('carries effort / approval / sandbox on the boundary', async () => {
    const file = tmpFixture('turn-ctx.jsonl', [
      { timestamp: '2026-11-17T10:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: '/Users/demo/webapp' } },
      {
        timestamp: '2026-11-17T10:00:01.000Z',
        type: 'turn_context',
        payload: {
          turn_id: 't1',
          model: 'gpt-6-astra',
          effort: 'xhigh',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
        },
      },
      {
        timestamp: '2026-11-17T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      },
    ]);
    const { parsed } = await parseTraceFile(file);
    const b = boundaries(parsed.events);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'xhigh',
      approvalPolicy: 'never',
      sandboxPolicy: 'danger-full-access',
    });
  });

  it('"none"-valued params stay unset', async () => {
    const file = tmpFixture('turn-ctx-none.jsonl', [
      { timestamp: '2026-11-17T10:00:00.000Z', type: 'session_meta', payload: { id: 's1' } },
      {
        timestamp: '2026-11-17T10:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 't1', model: 'gpt-6-astra', effort: 'none', approval_policy: 'none', sandbox_policy: { type: 'none' } },
      },
    ]);
    const { parsed } = await parseTraceFile(file);
    const b = boundaries(parsed.events);
    expect(b[0].effort).toBeUndefined();
    expect(b[0].approvalPolicy).toBeUndefined();
    expect(b[0].sandboxPolicy).toBeUndefined();
  });

  it('folds token_count.last_token_usage into the boundary', async () => {
    const file = tmpFixture('turn-tokens.jsonl', [
      { timestamp: '2026-11-17T10:00:00.000Z', type: 'session_meta', payload: { id: 's1' } },
      {
        timestamp: '2026-11-17T10:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 't1', model: 'gpt-6-astra' },
      },
      {
        timestamp: '2026-11-17T10:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 26730, cached_input_tokens: 13056, output_tokens: 246 },
            total_token_usage: { input_tokens: 26730, cached_input_tokens: 13056, output_tokens: 246, total_tokens: 40032 },
          },
        },
      },
    ]);
    const { parsed } = await parseTraceFile(file);
    const b = boundaries(parsed.events);
    expect(b[0].usage).toEqual({ inputTokens: 39786, outputTokens: 246 });
  });
});

describe('Claude Code turn params', () => {
  const apiRequestLine = (over: Record<string, unknown> = {}) => ({
    type: 'api-request',
    sessionId: 'sess-p',
    timestamp: '2026-11-17T10:00:00.000Z',
    params: {
      model: 'claude-opus-5-5',
      max_tokens: 128000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    },
    ...over,
  });
  const permissionModeLine = { type: 'permission-mode', sessionId: 'sess-p', permissionMode: 'bypassPermissions' };
  const userLine = {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    sessionId: 'sess-p',
    timestamp: '2026-11-17T10:00:01.000Z',
    origin: { kind: 'human' },
    message: { content: 'fix the bug' },
  };
  const assistantLine = {
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    sessionId: 'sess-p',
    timestamp: '2026-11-17T10:00:02.000Z',
    message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] },
  };

  it('carries api-request params + permission mode on the boundary', async () => {
    const file = tmpFixture('turn-params.jsonl', [
      apiRequestLine(),
      permissionModeLine,
      userLine,
      assistantLine,
    ]);
    const { parsed } = await parseTraceFile(file);
    const b = boundaries(parsed.events);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      thinking: 'adaptive',
      maxTokens: 128000,
      permissionMode: 'bypassPermissions',
    });
  });

  it('exposes cost-state totals on the run', async () => {
    const file = tmpFixture('cost.jsonl', [
      userLine,
      assistantLine,
      {
        type: 'cost-state',
        sessionId: 'sess-p',
        totalCostUSD: 10.94,
        totalLinesAdded: 349,
        totalLinesRemoved: 52,
      },
    ]);
    const { parsed } = await parseTraceFile(file);
    expect(parsed.run.costUSD).toBeCloseTo(10.94, 2);
    expect(parsed.run.linesAdded).toBe(349);
    expect(parsed.run.linesRemoved).toBe(52);
  });

  it('exposes pr-links on the run', async () => {
    const file = tmpFixture('pr.jsonl', [
      userLine,
      assistantLine,
      {
        type: 'pr-link',
        sessionId: 'sess-p',
        prNumber: 4,
        prUrl: 'https://github.com/Picrew/trace_view/pull/4',
      },
    ]);
    const { parsed } = await parseTraceFile(file);
    expect(parsed.run.prLinks).toEqual([
      { label: 'PR #4', url: 'https://github.com/Picrew/trace_view/pull/4' },
    ]);
  });

  it('bookkeeping lines no longer surface as unknown events', async () => {
    const file = tmpFixture('noise.jsonl', [
      apiRequestLine(),
      permissionModeLine,
      { type: 'tools-used', sessionId: 'sess-p', tools: ['Bash'] },
      { type: 'file-history-snapshot', sessionId: 'sess-p' },
      { type: 'api-request-shape', sessionId: 'sess-p' },
      { type: 'api-request-blob', sessionId: 'sess-p' },
      userLine,
      assistantLine,
    ]);
    const { parsed } = await parseTraceFile(file);
    const unknowns = parsed.events.filter((e) => e.kind === 'unknown');
    expect(unknowns).toHaveLength(0);
  });

  it('agent-name lands in run notes', async () => {
    const file = tmpFixture('agent-name.jsonl', [
      { type: 'agent-name', sessionId: 'sess-p', agentName: 'Session review worker' },
      userLine,
      assistantLine,
    ]);
    const { parsed } = await parseTraceFile(file);
    expect(parsed.run.notes).toContain('agent: Session review worker');
  });
});

describe('adapter-level smoke', () => {
  it('codex boundary map patches in place', () => {
    const adapter = new CodexAdapter();
    const state = adapter.createState();
    const ctx = defaultParseCtx(0);
    const events: TraceEvent[] = [];
    events.push(
      ...adapter.parseLine(
        {
          timestamp: '2026-11-17T10:00:01.000Z',
          type: 'turn_context',
          payload: { turn_id: 't1', model: 'gpt-6-astra', effort: 'high' },
        },
        { offset: 0, length: 0 },
        state,
        ctx,
      ),
    );
    adapter.parseLine(
      {
        timestamp: '2026-11-17T10:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } },
      },
      { offset: 0, length: 0 },
      state,
      ctx,
    );
    adapter.finalize(state, ctx);
    const b = boundaries(events);
    expect(b[0].usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
});
