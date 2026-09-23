import type { ServerResponse } from 'node:http';
import { stat, open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import type { ParseHandle } from '../core/run-builder.js';
import { buildDerived } from '../core/run-builder.js';
import type { TraceEvent } from '../core/schema.js';
import { stripForTransport } from './api.js';

interface Client {
  res: ServerResponse;
}

/**
 * Watches an active trace file and pushes incremental unified events to SSE
 * subscribers. Never mutates the file; tolerant of truncate/rotate (emits
 * `reset` and re-parses from byte 0).
 */
export class RunWatcher {
  private clients = new Set<Client>();
  private watcher: import('node:fs').FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private handle: ParseHandle) {}

  get subscriberCount(): number {
    return this.clients.size;
  }

  addClient(res: ServerResponse): void {
    const client: Client = { res };
    this.clients.add(client);
    res.on('close', () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stop();
    });
    res.on('error', () => {
      this.clients.delete(client);
    });
    if (!this.watcher && !this.stopped) this.start();
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        this.broadcastComment(': ping');
      }, 15_000);
      this.heartbeat.unref?.();
    }
  }

  private start(): void {
    void this.initWatcher();
  }

  private async initWatcher(): Promise<void> {
    const fs = await import('node:fs');
    try {
      this.watcher = fs.watch(this.handle.filePath, { persistent: false }, () => {
        this.scheduleRead();
      });
      this.watcher.on('error', () => {
        this.fallbackToPolling();
      });
    } catch {
      this.fallbackToPolling();
    }
    // Poll as a safety net too — fs.watch can miss changes on network volumes.
    this.pollTimer = setInterval(() => this.scheduleRead(), 2_000);
    this.pollTimer.unref?.();
  }

  private fallbackToPolling(): void {
    // pollTimer already runs as a safety net; nothing else to do.
  }

  private scheduleRead(): void {
    if (this.stopped || this.clients.size === 0) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.readIncrement();
    }, 250);
    this.debounceTimer.unref?.();
  }

  private async readIncrement(): Promise<void> {
    if (this.stopped || this.clients.size === 0) return;
    const { handle } = this;
    let st;
    try {
      st = await stat(handle.filePath);
    } catch {
      return; // file vanished; keep clients waiting
    }

    // Truncated / rotated → full re-parse and reset clients.
    if (st.size < handle.byteOffset) {
      await this.reparseAndReset();
      return;
    }
    if (st.size === handle.byteOffset) {
      this.touchStat(st);
      return;
    }

    const fh = await open(handle.filePath, 'r');
    try {
      const length = st.size - handle.byteOffset;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, handle.byteOffset);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return; // still a partial line
      const complete = text.slice(0, lastNewline + 1);
      const consumed = Buffer.byteLength(complete);
      const chunkStart = handle.byteOffset;
      handle.byteOffset += consumed;

      const newEvents: TraceEvent[] = [];
      let lineStart = 0; // byte offset of the current line within the chunk
      for (const line of complete.split('\n')) {
        const lineBytes = Buffer.byteLength(line);
        const loc = { offset: chunkStart + lineStart, length: lineBytes };
        lineStart += lineBytes + 1;
        if (!line.trim()) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          handle.state.meta.badLines += 1;
          continue; // skip broken tail line
        }
        try {
          newEvents.push(...handle.adapter.parseLine(obj, loc, handle.state, handle.ctx));
        } catch (err) {
          handle.state.meta.warnings.push(`parse error during tail: ${(err as Error).message}`);
        }
      }
      if (newEvents.length === 0) {
        this.touchStat(st);
        return;
      }
      handle.parsed.events.push(...newEvents);
      this.rebuild(st);
      this.broadcast({ type: 'batch', events: newEvents.map(stripForTransport), ...this.payload() });
    } finally {
      await fh.close();
    }
  }

  private touchStat(st: { size: number; mtimeMs: number }): void {
    this.handle.parsed.run.fileSizeBytes = st.size;
    this.handle.parsed.run.mtimeMs = st.mtimeMs;
    this.handle.parsed.run.live = Date.now() - st.mtimeMs < 5 * 60 * 1000;
  }

  private rebuild(st: { size: number; mtimeMs: number }): void {
    const { handle } = this;
    const path = handle.parsed.run.filePath;
    const fileName = handle.parsed.run.fileName;
    handle.parsed = buildDerived({
      provider: handle.parsed.run.provider,
      filePath: path,
      fileName,
      fileSizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      events: handle.parsed.events,
      state: handle.state,
    });
  }

  private async reparseAndReset(): Promise<void> {
    const { parseTraceFile } = await import('../core/run-builder.js');
    try {
      const fresh = await parseTraceFile(this.handle.filePath, {
        provider: this.handle.parsed.run.provider,
      });
      this.handle.parsed = fresh.parsed;
      this.handle.state = fresh.state;
      this.handle.byteOffset = fresh.byteOffset;
      this.broadcast({ type: 'reset', ...this.payload() });
    } catch {
      /* keep old data on failure */
    }
  }

  private payload(): { run: unknown; spans: unknown; fileChanges: unknown } {
    return {
      run: this.handle.parsed.run,
      spans: this.handle.parsed.spans,
      fileChanges: this.handle.parsed.fileChanges,
    };
  }

  private broadcast(msg: unknown): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private broadcastComment(comment: string): void {
    for (const client of this.clients) {
      try {
        client.res.write(`${comment}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    // Wake any parked connections.
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

export interface CacheEntry {
  handle: ParseHandle;
  watcher: RunWatcher | null;
  lastAccess: number;
}

/** LRU cache of fully parsed runs. Evicts idle entries without SSE subscribers. */
export class RunCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private maxEntries = 6) {}

  get(runId: string): CacheEntry | undefined {
    const entry = this.entries.get(runId);
    if (entry) entry.lastAccess = Date.now();
    return entry;
  }

  put(handle: ParseHandle): CacheEntry {
    const existing = this.entries.get(handle.parsed.run.id);
    if (existing) {
      existing.handle = handle;
      existing.lastAccess = Date.now();
      return existing;
    }
    const entry: CacheEntry = { handle, watcher: null, lastAccess: Date.now() };
    this.entries.set(handle.parsed.run.id, entry);
    this.evictIfNeeded();
    return entry;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [id, entry] of sorted) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.watcher && entry.watcher.subscriberCount > 0) continue; // busy live tail
      entry.watcher?.stop();
      this.entries.delete(id);
    }
  }
}
