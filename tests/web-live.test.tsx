// @vitest-environment jsdom
/**
 * Live-tail client test: a live run auto-connects to the SSE stream; a
 * simulated batch must append events and refresh run metadata without a
 * reload, and a reset must refetch everything.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTraceFile } from '../src/core/run-builder.js';
import { stripForTransport } from '../src/server/api.js';
import type { TraceEvent } from '../src/core/schema.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver = class {
  cb: (e: unknown[]) => void;
  constructor(cb: (e: unknown[]) => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    const height = el.classList?.contains('trajectory') ? 20000 : 40;
    setTimeout(() => this.cb([{ target: el, borderBoxSize: [{ inlineSize: 1400, blockSize: height }] }]), 0);
  }
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 20000 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

/** Minimal EventSource capture harness. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('live tail (SSE client)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalFetch = globalThis.fetch;
  const originalES = (globalThis as any).EventSource;
  let handle: Awaited<ReturnType<typeof parseTraceFile>>;
  let fetchCount = { run: 0, events: 0, library: 0 };

  beforeAll(async () => {
    handle = await parseTraceFile(path.join(__dirname, 'fixtures', 'claude-basic.jsonl'));
    (globalThis as any).EventSource = MockEventSource;
    const liveRun = { ...handle.parsed.run, live: true };
    (globalThis as any).fetch = async (url: any): Promise<Response> => {
      const u = decodeURIComponent(String(url));
      const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
      if (u === '/api/library') {
        fetchCount.library++;
        return json({
          sessions: [{ ...liveRun, title: liveRun.title, project: 'proj', filePath: 'x', fileName: 'f', live: true }],
          dirs: { claudeDir: '', codexDir: '', archivedCodexDir: '', extraDirs: [] },
          lastScan: 0,
        });
      }
      if (u === `/api/runs/${liveRun.id}`) {
        fetchCount.run++;
        return json({ run: liveRun, spans: handle.parsed.spans, fileChanges: handle.parsed.fileChanges });
      }
      if (u === `/api/runs/${liveRun.id}/events`) {
        fetchCount.events++;
        return json({ events: handle.parsed.events.map(stripForTransport) });
      }
      return json({ error: 'nf' }, 404);
    };
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
    (globalThis as any).EventSource = originalES;
  });

  it('opens a session and auto-connects to the stream because run is live', async () => {
    await act(async () => {
      (container.querySelector('.session-item') as HTMLElement).click();
    });
    await waitFor(() => container.querySelector('.run-title') !== null);
    expect(container.textContent).toContain('LIVE');
    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0];
    expect(es.url).toContain(`/api/runs/${encodeURIComponent(handle.parsed.run.id)}/stream`);
    expect(es.url).toContain('cursor=');
    expect(es.closed).toBe(false);
  });

  it('appends streamed events without a reload', async () => {
    const before = fetchCount.events;
    const newEvent: TraceEvent = {
      id: 'e999',
      seq: 999,
      kind: 'user_message',
      text: 'STREAMED PROBE MESSAGE',
      agentId: 'main',
      source: { provider: 'claude-code', rawType: 'user' },
      timestamp: '2026-09-20T10:30:00.000Z',
    };
    await act(async () => {
      MockEventSource.instances[0].emit({
        type: 'batch',
        events: [newEvent],
        run: { ...handle.parsed.run, live: true, stats: { ...handle.parsed.run.stats, events: 29 } },
        spans: handle.parsed.spans,
        fileChanges: handle.parsed.fileChanges,
      });
    });
    await waitFor(() => container.textContent!.includes('STREAMED PROBE MESSAGE'));
    // No refetch of the events list happened — append-only.
    expect(fetchCount.events).toBe(before);
  });

  it('handles reset by refetching the full run', async () => {
    const before = fetchCount.run;
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'reset' });
    });
    await waitFor(() => fetchCount.run > before);
  });
});
