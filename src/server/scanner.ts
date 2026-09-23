import { readdir, stat, mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DiscoveredSession, SessionSummary, TraceProvider } from '../core/schema.js';
import { summarizeTraceFile } from '../core/run-builder.js';

/** Persisted per-file summary cache to keep library scans cheap. */
interface CacheFile {
  version: 1;
  entries: Record<string, { size: number; mtimeMs: number; summary: SessionSummary }>;
}

export interface LibraryDirs {
  claudeDir: string;
  codexDir: string;
  archivedCodexDir: string;
  extraDirs: string[];
}

export function defaultDirs(): LibraryDirs {
  const home = os.homedir();
  return {
    claudeDir: path.join(home, '.claude', 'projects'),
    codexDir: path.join(home, '.codex', 'sessions'),
    archivedCodexDir: path.join(home, '.codex', 'archived_sessions'),
    extraDirs: [],
  };
}

export class Library {
  private cache = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary }>();
  private summaries = new Map<string, SessionSummary>(); // runId → summary
  private byPath = new Map<string, SessionSummary>();
  private cachePath: string;
  private lastScanMs = 0;
  private scanning: Promise<void> | null = null;

  constructor(private dirs: LibraryDirs) {
    this.cachePath = path.join(os.homedir(), '.trace-review', 'cache.json');
  }

  updateDirs(dirs: Partial<LibraryDirs>): void {
    Object.assign(this.dirs, dirs);
  }

  getDirs(): LibraryDirs {
    return { ...this.dirs };
  }

  async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.cache = new Map(Object.entries(parsed.entries));
      }
    } catch {
      /* first run or corrupt cache */
    }
  }

  private async saveCache(): Promise<void> {
    try {
      const dir = path.dirname(this.cachePath);
      await mkdir(dir, { recursive: true });
      const payload: CacheFile = {
        version: 1,
        entries: Object.fromEntries(this.cache),
      };
      const tmp = `${this.cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, this.cachePath);
    } catch {
      /* cache write failures are non-fatal */
    }
  }

  get(runId: string): SessionSummary | undefined {
    return this.summaries.get(runId);
  }

  findByPath(filePath: string): SessionSummary | undefined {
    return this.byPath.get(filePath);
  }

  all(): SessionSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  get lastScan(): number {
    return this.lastScanMs;
  }

  /** Scan all configured roots. Concurrent, cache-aware. */
  async scan(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan(force).finally(() => {
      this.scanning = null;
      this.lastScanMs = Date.now();
    });
    return this.scanning;
  }

  /** Returns immediately when a scan is already running (dedupes concurrent callers). */
  ensureFresh(maxAgeMs: number, force = false): Promise<void> | null {
    if (force || Date.now() - this.lastScanMs > maxAgeMs) {
      return this.scan(force);
    }
    return null;
  }

  private async doScan(force: boolean): Promise<void> {
    const files = new Set<string>();
    await collectJsonl(this.dirs.claudeDir, files, 2);
    await collectJsonl(this.dirs.codexDir, files, 4);
    await collectJsonl(this.dirs.archivedCodexDir, files, 1);
    for (const dir of this.dirs.extraDirs) {
      await collectJsonl(dir, files, 4);
    }

    const summaries: SessionSummary[] = [];
    const CONCURRENCY = 16;
    const queue = [...files];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) break;
        let st;
        try {
          st = await stat(file);
        } catch {
          continue;
        }
        const cached = this.cache.get(file);
        if (
          !force &&
          cached &&
          cached.size === st.size &&
          cached.mtimeMs === st.mtimeMs
        ) {
          // Refresh only the `live` flag.
          cached.summary.live = Date.now() - st.mtimeMs < 5 * 60 * 1000;
          summaries.push(cached.summary);
          continue;
        }
        try {
          const summary = await summarizeTraceFile(file);
          if (summary) {
            this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, summary });
            summaries.push(summary);
          } else {
            this.cache.delete(file);
          }
        } catch {
          this.cache.delete(file);
        }
      }
    });
    await Promise.all(workers);

    // Drop cache entries for files that no longer exist.
    for (const file of [...this.cache.keys()]) {
      if (!files.has(file)) this.cache.delete(file);
    }

    this.summaries = new Map(summaries.map((s) => [s.id, s]));
    this.byPath = new Map(summaries.map((s) => [s.filePath, s]));
    await this.saveCache();
  }

  /** Register a manually imported file/directory immediately. */
  async importPath(inputPath: string): Promise<SessionSummary[]> {
    const files = new Set<string>();
    const st = await stat(inputPath);
    if (st.isDirectory()) {
      await collectJsonl(inputPath, files, 5);
    } else if (inputPath.endsWith('.jsonl') || inputPath.endsWith('.ndjson') || inputPath.endsWith('.json')) {
      files.add(inputPath);
    } else {
      throw new Error('Unsupported file type — expected .jsonl / .ndjson / .json');
    }
    if (files.size === 0) throw new Error('No trace files found in that path');
    const out: SessionSummary[] = [];
    for (const file of files) {
      const summary = await summarizeTraceFile(file);
      if (summary) {
        this.summaries.set(summary.id, summary);
        this.byPath.set(file, summary);
        this.cache.set(file, { size: summary.fileSizeBytes, mtimeMs: summary.mtimeMs, summary });
        out.push(summary);
      }
    }
    if (out.length === 0) throw new Error('No parseable trace files found in that path');
    await this.saveCache();
    return out;
  }
}

export type { DiscoveredSession };

async function collectJsonl(dir: string, out: Set<string>, maxDepth: number, depth = 0): Promise<void> {
  if (depth > maxDepth) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing dir is normal
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectJsonl(p, out, maxDepth, depth + 1);
    } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.ndjson')) {
      out.add(p);
    }
  }
}
