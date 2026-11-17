import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Codex rollout files carry no title — the UI title lives in
 * `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}` appended on
 * every rename, so later lines win). This reader maps sessionId → latest
 * thread_name, cached by the index file's mtime.
 *
 * Archived sessions (`~/.codex/archived_sessions/`) are absent from the index;
 * they fall back to the first-user-message title.
 */
export class CodexTitleIndex {
  private names = new Map<string, string>();
  private mtimeMs = -1;
  private size = -1;
  private loading: Promise<void> | null = null;

  constructor(private indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl')) {}

  /** Latest thread_name for a session, or undefined when unknown. */
  async get(sessionId: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.names.get(sessionId);
  }

  /** Identity of the index file as last loaded — callers use it to invalidate caches. */
  stats(): { mtimeMs: number; size: number } {
    return { mtimeMs: this.mtimeMs, size: this.size };
  }

  private async ensureLoaded(): Promise<void> {
    let st;
    try {
      st = await stat(this.indexPath);
    } catch {
      this.names.clear(); // index gone → no overrides
      return;
    }
    if (st.mtimeMs === this.mtimeMs && st.size === this.size) return; // fresh
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    const loading = this.load();
    this.loading = loading;
    await loading.finally(() => {
      if (this.loading === loading) this.loading = null;
    });
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch {
      return;
    }
    const names = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s) as { id?: unknown; thread_name?: unknown };
        if (typeof o.id === 'string' && typeof o.thread_name === 'string' && o.thread_name) {
          names.set(o.id, o.thread_name); // later lines carry the latest name
        }
      } catch {
        /* skip malformed lines */
      }
    }
    this.names = names;
  }
}
