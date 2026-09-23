import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileChangeSummary, SessionSummary, TimelineSpan, TraceEvent, TraceRun } from './types.js';
import { api, openStream, type SearchMatch } from './api.js';
import { SessionLibrary } from './components/SessionLibrary.js';
import { RunHeader } from './components/RunHeader.js';
import { Timeline } from './components/Timeline.js';
import { FilterBar, type FilterState } from './components/FilterBar.js';
import { Trajectory } from './components/Trajectory.js';
import { Inspector } from './components/Inspector.js';
import { FilesPanel } from './components/FilesPanel.js';
import { fmtBytes } from './format.js';

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<TraceRun | null>(null);
  const [spans, setSpans] = useState<TimelineSpan[]>([]);
  const [fileChanges, setFileChanges] = useState<FileChangeSummary[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [autoScrollSeq, setAutoScrollSeq] = useState(0);
  const [filters, setFilters] = useState<FilterState>({ active: new Set() });
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const loadRunRef = useRef(0);

  // --- library ---
  const loadLibrary = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      const lib = await api.library(refresh);
      setSessions(lib.sessions);
    } catch (e) {
      setLoadError(`Failed to load library: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const loadRun = useCallback(async (runId: string) => {
    const token = ++loadRunRef.current;
    setSelectedId(runId);
    setLoading(true);
    setLoadError(null);
    setRun(null);
    setEvents([]);
    setSpans([]);
    setFileChanges([]);
    setSelectedEventId(null);
    setInspectorOpen(false);
    setFilesOpen(false);
    setFilters({ active: new Set() });
    setSearch('');
    setMatches([]);
    try {
      const detail = await api.run(runId);
      if (token !== loadRunRef.current) return;
      if (!detail.run) throw new Error('Run detail unavailable');
      setRun(detail.run);
      setSpans(detail.spans ?? []);
      setFileChanges(detail.fileChanges ?? []);
      const ev = await api.events(runId);
      if (token !== loadRunRef.current) return;
      setEvents(Array.isArray(ev.events) ? ev.events : []);
    } catch (e) {
      if (token !== loadRunRef.current) return;
      setLoadError((e as Error).message);
    } finally {
      if (token === loadRunRef.current) setLoading(false);
    }
  }, []);

  // Deep-link support: #run=<id> opens that run directly (bookmarks, tests).
  const hashRunRef = useRef<string | null>(null);
  useEffect(() => {
    const applyHash = () => {
      const m = /#run=([^&]+)/.exec(window.location.hash);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      if (hashRunRef.current !== id) {
        hashRunRef.current = id;
        void loadRun(id);
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [loadRun]);

  // --- live tail ---
  // SSE batches are merged and applied at most every 300ms — a chatty agent
  // (or the session running THIS tool) writes many lines per second, and
  // re-rendering the whole trajectory per batch makes the UI jitter.
  useEffect(() => {
    if (!run || !run.live || !selectedId) return;
    const cursor = events.length > 0 ? events[events.length - 1].seq : -1;
    let pending: TraceEvent[] = [];
    let latest: { run: TraceRun; spans: TimelineSpan[]; fileChanges: FileChangeSummary[] } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const fresh = pending;
      const meta = latest;
      pending = [];
      latest = null;
      if (fresh.length > 0) {
        setEvents((prev) => {
          const lastSeq = prev.length > 0 ? prev[prev.length - 1].seq : -1;
          const add = fresh.filter((e) => e.seq > lastSeq);
          return add.length > 0 ? [...prev, ...add] : prev;
        });
      }
      if (meta) {
        setRun(meta.run);
        setSpans(meta.spans);
        setFileChanges(meta.fileChanges);
      }
    };
    const close = openStream(
      selectedId,
      cursor,
      (msg) => {
        pending = [...pending, ...msg.events];
        latest = { run: msg.run, spans: msg.spans, fileChanges: msg.fileChanges };
        if (!timer) timer = setTimeout(flush, 300);
      },
      () => {
        if (timer) clearTimeout(timer);
        void loadRun(selectedId);
      },
    );
    return () => {
      close();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, run?.live]);

  // --- search (debounced, server-side) ---
  useEffect(() => {
    if (!selectedId || !search.trim()) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .search(selectedId, search.trim())
        .then((r) => setMatches(r.matches))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, selectedId]);

  // --- filtering ---
  const filteredEvents = useMemo(() => {
    if (filters.active.size === 0) return events;
    const active = filters.active;
    return events.filter((e) => {
      switch (e.kind) {
        case 'tool_call':
        case 'tool_result':
          if (active.has('tools')) return true;
          if (e.kind === 'tool_call' && e.toolCategory !== 'other' && active.has(e.toolCategory)) return true;
          if (e.kind === 'tool_call' && (e.toolCategory === 'edit' || e.toolCategory === 'write') && active.has('edit')) return true;
          if (e.kind === 'tool_call' && (e.toolCategory === 'grep' || e.toolCategory === 'glob') && active.has('grep')) return true;
          if (e.kind === 'tool_result' && e.isError && active.has('errors')) return true;
          // category-matched call implies its result passes via call side; keep orphan results for errors only
          return false;
        case 'user_message':
          return active.has('user');
        case 'assistant_message':
          return active.has('assistant');
        case 'reasoning':
          return active.has('reasoning');
        case 'synthetic_message':
          return active.has('synthetic');
        case 'error':
          return active.has('errors');
        case 'compaction':
          return active.has('compaction');
        case 'turn_boundary':
          return active.has('requests');
        case 'system':
        case 'unknown':
          return active.has('system');
        case 'file_change':
          return active.has('edit') || active.has('tools');
        default:
          return true;
      }
    });
  }, [events, filters]);

  // Keep tool_result rows resolvable for calls that pass the filter: build
  // results map from the unfiltered events inside Trajectory's buildRows —
  // but filtered-out results would be missing. Simplest correct behavior:
  // when a tool category filter is active, also include matching results.
  const patchedEvents = useMemo(() => {
    if (filters.active.size === 0) return filteredEvents;
    const active = filters.active;
    const hasToolFilter =
      active.has('tools') || active.has('bash') || active.has('read') || active.has('edit') || active.has('grep') || active.has('mcp');
    if (!hasToolFilter) return filteredEvents;
    const callIdOk = new Set<string>();
    for (const e of filteredEvents) if (e.kind === 'tool_call') callIdOk.add(e.callId);
    const includedSeq = new Set(filteredEvents.map((e) => e.seq));
    const extra = events.filter(
      (e) => e.kind === 'tool_result' && callIdOk.has(e.callId) && !includedSeq.has(e.seq),
    );
    return [...filteredEvents, ...extra].sort((a, b) => a.seq - b.seq);
  }, [filteredEvents, events, filters]);

  const selectedEvent = useMemo(() => events.find((e) => e.id === selectedEventId) ?? null, [events, selectedEventId]);

  const onSelectEvent = useCallback((eventId: string) => {
    setSelectedEventId(eventId);
    setInspectorOpen(true);
    setAutoScrollSeq((n) => n + 1);
  }, []);

  const jumpToEvent = useCallback(
    (eventId: string) => {
      setSelectedEventId(eventId);
      setInspectorOpen(true);
      setAutoScrollSeq((n) => n + 1);
    },
    [],
  );

  const onToggleFilter = useCallback((id: string) => {
    setFilters((prev) => {
      const next = new Set(prev.active);
      if (id === '__all') return { active: new Set() };
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { active: next };
    });
  }, []);

  const onImport = useCallback(
    async (path: string) => {
      try {
        await api.importPath(path);
        await loadLibrary(true);
      } catch (e) {
        setLoadError(`Import failed: ${(e as Error).message}`);
      }
    },
    [loadLibrary],
  );

  const emptyState = (
    <div className="empty-state">
      <div className="empty-logo">⌗</div>
      <h2>Agent Run Inspector</h2>
      <p>
        Select a session from the library, or import a trace by path.
        <br />
        Claude Code sessions come from <span className="mono">~/.claude/projects</span>, Codex from{' '}
        <span className="mono">~/.codex/sessions</span>.
      </p>
      {sessions.length === 0 && !refreshing && (
        <p className="empty-hint">
          No sessions discovered yet. Make sure the directories exist, or import a <span className="mono">.jsonl</span> trace
          manually with the <span className="mono">+</span> button.
        </p>
      )}
    </div>
  );

  return (
    <div className="app">
      <SessionLibrary
        sessions={sessions}
        selectedId={selectedId}
        onSelect={loadRun}
        onRefresh={() => void loadLibrary(true)}
        refreshing={refreshing}
        onImport={onImport}
      />
      <main className="main">
        {loadError && (
          <div className="error-banner">
            {loadError}
            <button onClick={() => setLoadError(null)}>✕</button>
          </div>
        )}
        {loading && (
          <div className="loading-state">
            <div className="loading-spinner" />
            <div>Parsing trace{selectedId ? ` ${selectedId.split(':')[1] ?? ''}` : ''}…</div>
            <div className="loading-hint">Large files (100MB+) can take a few seconds.</div>
          </div>
        )}
        {!loading && !run && emptyState}
        {!loading && run && (
          <>
            <RunHeader
              run={run}
              fileChanges={fileChanges}
              onShowFiles={() => setFilesOpen(!filesOpen)}
              filesOpen={filesOpen}
            />
            <Timeline spans={spans} onSelect={jumpToEvent} />
            <FilterBar
              filters={filters}
              onToggle={onToggleFilter}
              search={search}
              onSearch={setSearch}
              matches={matches}
              onJump={jumpToEvent}
              searching={searching}
              total={events.length}
              shown={patchedEvents.length}
            />
            <Trajectory
              events={patchedEvents}
              selectedEventId={selectedEventId}
              onSelect={onSelectEvent}
              autoScrollSeq={autoScrollSeq}
              live={run.live}
            />
          </>
        )}
      </main>
      {(inspectorOpen || filesOpen) && (
        <aside className="right-panel">
          {filesOpen && <FilesPanel fileChanges={fileChanges} onJump={jumpToEvent} />}
          {inspectorOpen && (
            <Inspector run={run!} event={selectedEvent} onClose={() => setInspectorOpen(false)} />
          )}
        </aside>
      )}
      <footer className="statusbar">
        <span>{sessions.length} sessions</span>
        {run && (
          <>
            <span>{run.fileName}</span>
            <span className="mono">{fmtBytes(run.fileSizeBytes)}</span>
            <span>{run.stats.requests} requests</span>
            <span>{run.stats.events} events</span>
            {run.live && <span className="live-badge">LIVE</span>}
          </>
        )}
        <span className="status-right">
          local only · no telemetry
          <button
            className="quit-btn"
            title="Stop the local trace-review server"
            onClick={() => {
              void api.quit().catch(() => undefined);
            }}
          >
            ⏻ Quit
          </button>
        </span>
      </footer>
    </div>
  );
}
