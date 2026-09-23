// @vitest-environment jsdom
/**
 * UI render test: real parser output (from the claude fixture) is served
 * through a mocked fetch, then we assert the React tree renders the
 * library, trajectory, filters and inspector correctly.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTraceFile } from '../src/core/run-builder.js';
import { stripForTransport } from '../src/server/api.js';

// React 18 act() requires this flag outside of jest.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement ResizeObserver. The virtualizer and Timeline both
// need it to report element rects. Emulate a tall viewport so every virtual
// row is inside the visible range (jsdom cannot faithfully emulate dynamic
// measurement — data-level assertions below are unaffected).
(globalThis as any).ResizeObserver = class {
  private cb: (entries: unknown[]) => void;
  constructor(cb: (entries: unknown[]) => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    const height = el.classList?.contains('trajectory') ? 20000 : 40;
    setTimeout(
      () => this.cb([{ target: el, borderBoxSize: [{ inlineSize: 1400, blockSize: height }] }]),
      0,
    );
  }
  unobserve() {}
  disconnect() {}
};

// jsdom performs no layout — back the element-based fallbacks too.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 20000 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 100000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-basic.jsonl');

let handle: Awaited<ReturnType<typeof parseTraceFile>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await act(async () => {
      await sleep(20);
    });
  }
}

function installFetchMock() {
  const calls: string[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The real client encodeURIComponent()s run ids; normalize before matching.
    const u = decodeURIComponent(String(url));
    calls.push(u);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u === '/api/library') {
      return json({
        sessions: [
          {
            ...handle.parsed.run,
            id: handle.parsed.run.id,
            title: handle.parsed.run.title,
            provider: 'claude-code',
            project: 'proj',
            filePath: FIXTURE,
            fileName: 'claude-basic.jsonl',
            live: false,
          },
        ],
        dirs: { claudeDir: '/x', codexDir: '/y', archivedCodexDir: '/z', extraDirs: [] },
        lastScan: Date.now(),
      });
    }
    if (u === `/api/runs/${handle.parsed.run.id}`) {
      return json({
        run: handle.parsed.run,
        spans: handle.parsed.spans,
        fileChanges: handle.parsed.fileChanges,
      });
    }
    if (u === `/api/runs/${handle.parsed.run.id}/events`) {
      return json({ events: handle.parsed.events.map(stripForTransport) });
    }
    const rawMatch = `/api/runs/${handle.parsed.run.id}/raw/`;
    if (u.startsWith(rawMatch)) {
      const eventId = u.split('/raw/')[1];
      const event = handle.parsed.events.find((e) => e.id === eventId);
      return json({ event: event ? stripForTransport(event) : null, raw: { type: 'user', probe: true } });
    }
    if (u.includes('/search?')) {
      return json({ query: '', matches: [] });
    }
    return json({ error: 'not found' }, 404);
  };
  (globalThis as any).fetch = fake;
  (globalThis as any).__fetchCalls = calls;
}

describe('web UI (jsdom render)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    handle = await parseTraceFile(FIXTURE);
    installFetchMock();
    container = document.createElement('div');
    document.body.appendChild(container);
    const { App } = await import('../web/src/App.js');
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
  });

  afterAll(() => {
    act(() => root.unmount());
    (globalThis as any).fetch = originalFetch;
  });

  it('renders the session library with the fixture session', async () => {
    await waitFor(() => container.querySelectorAll('.session-item').length > 0);
    const item = container.querySelector('.session-item')!;
    expect(item.textContent).toContain('Login bug fix session');
  });

  it('loads the run and renders trajectory rows', async () => {
    const item = container.querySelector('.session-item') as HTMLButtonElement;
    await act(async () => {
      item.click();
    });
    await waitFor(() => container.querySelector('.run-title') !== null);
    expect(container.querySelector('.run-title')!.textContent).toBe('Login bug fix session');
    // Trajectory rows render in the visible virtual window.
    await waitFor(() => container.querySelectorAll('.tool-row').length >= 1);
    const text = container.textContent!;
    expect(text).toContain('Now run the tests');
    expect(text).toContain('Bash');
    expect(text).toContain('npm test');
    // Request boundary divider with model + duration
    expect(text).toMatch(/Request \d+ · claude-\S+ · 14s/);
    // synthetic (continuing) message — the core feature
    expect(text).toContain('synthetic');
    expect(text).toContain('Your response above was cut off mid-stream. (continuing)');
    // unknown events kept visible
    expect(text).toContain('future-thing');
  });

  it('builds the full row model correctly (data layer)', async () => {
    const { buildRows } = await import('../web/src/rows.js');
    const rows = buildRows(handle.parsed.events);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'tool')).toHaveLength(3);
    expect(kinds).toContain('event');
    const toolRow = rows.find((r) => r.kind === 'tool') as { pair: { call: { toolName: string }; result?: { durationMs?: number } } };
    expect(toolRow.pair.call.toolName).toBe('Read');
    expect(toolRow.pair.result?.durationMs).toBe(2000);
    const bashRow = rows.filter((r) => r.kind === 'tool').map((r) => (r as any).pair).find((p: any) => p.call.toolName === 'Bash');
    expect(bashRow.result.durationMs).toBe(14000);
    expect(bashRow.result.stdout).toBe('ok - 12 tests\n');
    const aggregateRows = rows.filter((r) => r.kind === 'aggregate');
    expect(aggregateRows).toHaveLength(0); // only 3 consecutive tools — below threshold
  });

  it('filters events when chips are toggled', async () => {
    const chip = [...container.querySelectorAll('.filter-chip')].find((c) => c.textContent === 'User') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });
    await waitFor(() => container.querySelector('.message-row.user') !== null);
    const text = container.textContent!;
    // Both user messages render (the filtered list is short).
    expect(text).toContain('Fix the login bug');
    expect(text).toContain('Now run the tests');
    expect(text).not.toContain('Request 4'); // boundaries hidden under user filter
    expect(container.querySelector('.tool-row')).toBeNull();
    // back to all
    const allChip = [...container.querySelectorAll('.filter-chip')].find((c) => c.textContent === 'All') as HTMLButtonElement;
    await act(async () => {
      allChip.click();
    });
    await waitFor(() => container.querySelectorAll('.tool-row').length >= 1);
  });

  it('opens the inspector with metadata and raw JSON on event click', async () => {
    const toolHeader = container.querySelector('.tool-row .tool-header') as HTMLButtonElement;
    await act(async () => {
      toolHeader.click();
    });
    await waitFor(() => container.querySelector('.inspector') !== null);
    const text = container.textContent!;
    expect(text).toContain('Inspector');
    expect(text).toContain('Metadata');
    expect(text).toContain('tool_call');
    // raw JSON section appears (fetch on demand)
    await waitFor(() => container.querySelector('.raw-json') !== null);
    expect(text).toContain('Raw JSON');
  });

  it('shows files changed panel', async () => {
    const filesBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Files (')) as HTMLButtonElement;
    expect(filesBtn).toBeTruthy();
    await act(async () => {
      filesBtn.click();
    });
    await waitFor(() => container.querySelector('.files-panel') !== null);
    expect(container.querySelector('.file-path')!.textContent).toContain('auth.ts');
  });

  it('renders escape-first markdown (no raw HTML injection)', async () => {
    const md = container.querySelector('.message-text .md')!;
    expect(md.innerHTML).not.toContain('<script');
    expect(md.querySelector('script')).toBeNull();
  });
});
