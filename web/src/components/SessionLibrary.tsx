import { useMemo, useState } from 'react';
import type { SessionSummary } from '../types.js';
import { PROVIDER_LABEL, dateGroup, fmtBytes, fmtDuration, fmtTokens, relativeTime } from '../format.js';

const PROVIDER_ORDER: Array<SessionSummary['provider']> = ['claude-code', 'codex', 'generic'];

export function SessionLibrary({
  sessions,
  selectedId,
  onSelect,
  onRefresh,
  refreshing,
  onImport,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onImport: (path: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState('');

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return sessions.filter((s) => {
      if (providerFilter.size > 0 && !providerFilter.has(s.provider)) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q) ||
        s.fileName.toLowerCase().includes(q) ||
        (s.gitBranch ?? '').toLowerCase().includes(q)
      );
    });
  }, [sessions, filter, providerFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sessions) c[s.provider] = (c[s.provider] ?? 0) + 1;
    return c;
  }, [sessions]);

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: SessionSummary[] }> = [];
    for (const s of filtered) {
      const label = dateGroup(s.mtimeMs);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  }, [filtered]);

  const toggleProvider = (p: string) => {
    setProviderFilter((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="library">
      <div className="library-header">
        <div className="library-title">
          <span className="app-name">Trace Review</span>
          <span className="session-count">{sessions.length} sessions</span>
        </div>
        <div className="library-actions">
          <button className="icon-btn" title="Rescan session directories" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? '⟳' : '↻'}
          </button>
          <button className="icon-btn" title="Import a trace file or folder by path" onClick={() => setImportOpen(!importOpen)}>
            +
          </button>
        </div>
      </div>

      {importOpen && (
        <div className="import-box">
          <input
            placeholder="/absolute/path/to/trace.jsonl or folder"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && importPath.trim()) {
                onImport(importPath.trim());
                setImportPath('');
                setImportOpen(false);
              }
            }}
          />
          <div className="import-hint">Enter an absolute path — the file stays where it is.</div>
        </div>
      )}

      <div className="library-search">
        <input placeholder="Search sessions…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="provider-chips">
        {PROVIDER_ORDER.filter((p) => counts[p]).map((p) => (
          <button
            key={p}
            className={`provider-chip provider-${p} ${providerFilter.size === 0 || providerFilter.has(p) ? 'on' : 'off'}`}
            onClick={() => toggleProvider(p)}
          >
            <span className="provider-dot" />
            {PROVIDER_LABEL[p] ?? p}
            <span className="chip-count">{counts[p]}</span>
          </button>
        ))}
      </div>

      <div className="library-list">
        {grouped.length === 0 && <div className="library-empty">No sessions match.</div>}
        {grouped.map((g) => (
          <div key={g.label} className="library-group">
            <div className="group-label">{g.label}</div>
            {g.items.map((s) => (
              <SessionItem key={s.id} s={s} active={s.id === selectedId} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionItem({ s, active, onSelect }: { s: SessionSummary; active: boolean; onSelect: (id: string) => void }): JSX.Element {
  return (
    <button className={`session-item ${active ? 'active' : ''}`} onClick={() => onSelect(s.id)}>
      <div className="session-title-line">
        {s.live && <span className="live-dot" title="Modified recently — possibly still running" />}
        <span className={`provider-tag provider-${s.provider}`}>{s.provider === 'claude-code' ? 'CC' : s.provider === 'codex' ? 'CX' : 'GX'}</span>
        <span className="session-title">{s.title}</span>
      </div>
      <div className="session-meta">
        <span className="session-project" title={s.filePath}>
          {s.project}
          {s.gitBranch ? ` · ${s.gitBranch}` : ''}
        </span>
      </div>
      <div className="session-meta dim">
        <span>{relativeTime(s.mtimeMs)}</span>
        {s.endedAt && s.startedAt && <span>{fmtDuration(Date.parse(s.endedAt) - Date.parse(s.startedAt))}</span>}
        <span>{fmtBytes(s.fileSizeBytes)}</span>
        {s.usage && s.usage.totalTokens > 0 && <span>{fmtTokens(s.usage.totalTokens)} tok</span>}
        {s.stats && s.stats.toolCalls > 0 && <span>{s.stats.toolCalls} tools</span>}
        {s.models.length > 0 && <span className="session-model">{s.models[0]}</span>}
      </div>
    </button>
  );
}
