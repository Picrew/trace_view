import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileChangeEvent, StructuredPatch, TraceEvent } from '../types.js';
import type { Row, ToolPair } from '../rows.js';
import { buildRows } from '../rows.js';
import { fmtDuration, fmtTime } from '../format.js';
import { Highlight, splitHighlight } from '../highlight.js';
import { SafeMarkdown } from './SafeMarkdown.js';
import { JsonView } from './JsonView.js';
import { IconAlert, IconArrowDown, IconCheck, IconChevron, IconCompact, IconImage, IconInfo, IconSearch, IconUnknown } from './Icons.js';

export function Trajectory({
  events,
  selectedEventId,
  onSelect,
  autoScrollSeq,
  live,
  searchQuery,
  matchEventIds,
  activeMatchId,
}: {
  events: TraceEvent[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  autoScrollSeq: number;
  live: boolean;
  searchQuery: string;
  matchEventIds: ReadonlySet<string>;
  activeMatchId: string | null;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reasoningOpen, setReasoningOpen] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState(true);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => estimateRow(rows[i]),
    getItemKey: (i) => rows[i].key,
    overscan: 12,
    // Fallback viewport before the element is measured (also helps jsdom tests).
    initialRect: { width: 1000, height: 600 },
  });

  // Jump-to-event handling.
  const indexByEvent = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === 'event') map.set(row.event.id, i);
      else if (row.kind === 'tool') {
        if (row.pair.call) map.set(row.pair.call.id, i);
        if (row.pair.result) map.set(row.pair.result.id, i);
      } else {
        for (const p of row.pairs) {
          if (p.call) map.set(p.call.id, i);
          if (p.result) map.set(p.result.id, i);
        }
      }
    });
    return map;
  }, [rows]);

  const lastJumpRef = useRef<{ id: string | null; seq: number }>({ id: null, seq: -1 });
  useEffect(() => {
    if (!selectedEventId) return;
    const last = lastJumpRef.current;
    if (last.id === selectedEventId && last.seq === autoScrollSeq) return;
    lastJumpRef.current = { id: selectedEventId, seq: autoScrollSeq };
    const idx = indexByEvent.get(selectedEventId);
    if (idx !== undefined) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
      // Expand the containing aggregate/tool row if hidden.
      const row = rows[idx];
      if (row.kind === 'tool' || row.kind === 'aggregate') {
        const key = row.kind === 'tool' ? row.key : row.key;
        setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      }
    }
  }, [selectedEventId, autoScrollSeq, indexByEvent, rows, virtualizer]);

  // Live-tail auto-follow: ON while the user stays at the bottom; scrolling
  // up pauses it and shows a "follow" pill. No invisible re-pinning — the
  // user decides when to resume.
  const followRef = useRef(true);
  const suppressScrollEval = useRef(false);
  const onScroll = () => {
    if (suppressScrollEval.current) return; // our own programmatic scroll
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (followRef.current && !atBottom) {
      followRef.current = false;
      setFollow(false);
    }
  };
  const jumpToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    followRef.current = true;
    setFollow(true);
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    if (followRef.current) {
      const el = parentRef.current;
      if (el) {
        // Suppress the scroll-event evaluation our own jump triggers.
        suppressScrollEval.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          suppressScrollEval.current = false;
        });
      }
    }
  }, [rows.length]);

  return (
    <div className="trajectory-wrap">
      <div className="trajectory" ref={parentRef} onScroll={onScroll}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }}
          >
            <RowView
              row={rows[vi.index]}
              expanded={expanded}
              onToggle={toggle}
              reasoningOpen={reasoningOpen}
              onToggleReasoning={(k) =>
                setReasoningOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              selectedEventId={selectedEventId}
              onSelect={onSelect}
              searchQuery={searchQuery}
              matchEventIds={matchEventIds}
              activeMatchId={activeMatchId}
            />
          </div>
        ))}
      </div>
        {rows.length === 0 && <div className="trajectory-empty">No events match the current filters.</div>}
      </div>
      {live && !follow && (
        <button className="follow-btn" onClick={jumpToBottom} title="Follow live events">
          <IconArrowDown size={13} />
          Follow live
        </button>
      )}
    </div>
  );
}

function estimateRow(row: Row): number {
  if (row.kind === 'event') {
    switch (row.event.kind) {
      case 'user_message':
      case 'synthetic_message':
        return 90;
      case 'assistant_message':
        return 110;
      case 'reasoning':
        return 60;
      case 'turn_boundary':
        return 28;
      default:
        return 36;
    }
  }
  if (row.kind === 'tool') return 36;
  return 40;
}

const RowView = memo(function RowView({
  row,
  expanded,
  onToggle,
  reasoningOpen,
  onToggleReasoning,
  selectedEventId,
  onSelect,
  searchQuery,
  matchEventIds,
  activeMatchId,
}: {
  row: Row;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  reasoningOpen: Set<string>;
  onToggleReasoning: (key: string) => void;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  searchQuery: string;
  matchEventIds: ReadonlySet<string>;
  activeMatchId: string | null;
}): JSX.Element {
  if (row.kind === 'tool') {
    return <ToolRow pair={row.pair} expanded={expanded.has(row.key)} onToggle={() => onToggle(row.key)} selectedEventId={selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matchEventIds={matchEventIds} activeMatchId={activeMatchId} />;
  }
  if (row.kind === 'aggregate') {
    return <AggregateRow pairs={row.pairs} expanded={expanded.has(row.key)} onToggle={() => onToggle(row.key)} selectedEventId={selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matchEventIds={matchEventIds} activeMatchId={activeMatchId} />;
  }
  const e = row.event;
  switch (e.kind) {
    case 'user_message':
      return <MessageRow e={e} tone="user" label="You" selected={e.id === selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matched={matchEventIds.has(e.id)} />;
    case 'assistant_message':
      return <MessageRow e={e} tone="assistant" label="Assistant" model={e.model} selected={e.id === selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matched={matchEventIds.has(e.id)} />;
    case 'synthetic_message':
      return <SyntheticRow e={e} selected={e.id === selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matched={matchEventIds.has(e.id)} />;
    case 'reasoning':
      return <ReasoningRow e={e} open={reasoningOpen.has(e.id)} onToggle={() => onToggleReasoning(e.id)} selected={e.id === selectedEventId} onSelect={onSelect} searchQuery={searchQuery} matched={matchEventIds.has(e.id)} />;
    case 'turn_boundary':
      return <BoundaryRow e={e} onSelect={onSelect} />;
    case 'system':
      return <SmallRow e={e} tone="system" icon={<IconInfo size={13} />} text={`${e.subtype ?? 'system'}${e.text ? ` — ${e.text}` : ''}`} onSelect={onSelect} searchQuery={searchQuery} />;
    case 'error':
      return <SmallRow e={e} tone="error" icon={<IconAlert size={13} />} text={e.message} onSelect={onSelect} searchQuery={searchQuery} />;
    case 'compaction':
      return <SmallRow e={e} tone="warn" icon={<IconCompact size={13} />} text={e.text ?? 'Context compacted'} onSelect={onSelect} searchQuery={searchQuery} />;
    case 'file_change':
      return <FileChangeRow e={e} selected={e.id === selectedEventId} onSelect={onSelect} searchQuery={searchQuery} />;
    default:
      return <SmallRow e={e} tone="dim" icon={<IconUnknown size={13} />} text={`${(e as { rawType?: string }).rawType ?? 'unknown'}${(e as { note?: string }).note ? ` — ${(e as { note?: string }).note}` : ''}`} onSelect={onSelect} searchQuery={searchQuery} />;
  }
});

function TimeGutter({ e }: { e: TraceEvent }): JSX.Element {
  return <span className="time-gutter">{e.timestamp ? fmtTime(e.timestamp) : ''}</span>;
}

function MatchMark({ matched }: { matched: boolean }): JSX.Element | null {
  if (!matched) return null;
  return <span className="match-mark" title="Search match" aria-label="Search match" />;
}

function MessageRow({
  e,
  tone,
  label,
  model,
  selected,
  onSelect,
  searchQuery,
  matched,
}: {
  e: Extract<TraceEvent, { text: string }>;
  tone: 'user' | 'assistant';
  label: string;
  model?: string;
  selected: boolean;
  onSelect: (id: string) => void;
  searchQuery: string;
  matched: boolean;
}): JSX.Element {
  const hasImages = (e as { hasImages?: boolean }).hasImages === true;
  return (
    <div
      className={`row message-row ${tone} ${selected ? 'selected' : ''} ${matched && !selected ? 'has-match' : ''}`}
      onClick={() => onSelect(e.id)}
    >
      <div className="row-gutter">
        <TimeGutter e={e} />
        <MatchMark matched={matched} />
      </div>
      <div className="row-body">
        <div className="row-label">
          <span className="role-dot" aria-hidden="true" />
          {label}
          {hasImages && (
            <span className="img-badge" title="message included pasted images">
              <IconImage size={12} />
              Image
            </span>
          )}
          {model && <span className="row-model">{model}</span>}
        </div>
        <div className="message-text">
          <SafeMarkdown text={e.text} highlight={searchQuery} />
          {(e as { truncated?: boolean }).truncated && <div className="truncated-note">text truncated — see raw JSON</div>}
        </div>
      </div>
    </div>
  );
}

function SyntheticRow({ e, selected, onSelect, searchQuery, matched }: { e: Extract<TraceEvent, { kind: 'synthetic_message' }>; selected: boolean; onSelect: (id: string) => void; searchQuery: string; matched: boolean }): JSX.Element {
  const kindLabel: Record<string, string> = {
    'compact-summary': 'compact summary',
    meta: 'meta',
    continuation: 'continuation',
    injected: 'injected',
    queue: 'queued',
  };
  const text = e.text;
  const short = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return (
    <div className={`row synthetic-row ${selected ? 'selected' : ''} ${matched && !selected ? 'has-match' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
        <MatchMark matched={matched} />
      </div>
      <div className="row-body">
        <div className="row-label">
          <span className="synthetic-badge">synthetic</span>
          <span className="synthetic-kind">{kindLabel[e.syntheticKind] ?? e.syntheticKind}</span>
        </div>
        <div className="synthetic-text">
          <Highlight text={short} query={searchQuery} />
        </div>
      </div>
    </div>
  );
}

function ReasoningRow({
  e,
  open,
  onToggle,
  selected,
  onSelect,
  searchQuery,
  matched,
}: {
  e: Extract<TraceEvent, { kind: 'reasoning' }>;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (id: string) => void;
  searchQuery: string;
  matched: boolean;
}): JSX.Element {
  const long = e.text.length > 200;
  // A match hidden inside a collapsed reasoning row still gets found: show
  // text when matched, and slide the 200-char preview window to the first
  // hit so the highlight is actually inside what we render.
  const q = searchQuery.trim();
  let text: string;
  let showText: boolean;
  if (q && matched) {
    const hit = splitHighlight(e.text, q).find((p) => p.hit);
    if (hit) {
      const at = e.text.indexOf(hit.s);
      const start = long ? Math.max(0, at - 60) : 0;
      text = (start > 0 ? '…' : '') + e.text.slice(start, start + 260) + (start + 260 < e.text.length ? '…' : '');
    } else {
      text = e.text;
    }
    showText = true;
  } else {
    text = open || !long ? e.text : `${e.text.slice(0, 200)}…`;
    showText = open || !long;
  }
  return (
    <div className={`row reasoning-row ${selected ? 'selected' : ''} ${matched && !selected ? 'has-match' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
        <MatchMark matched={matched} />
      </div>
      <div className="row-body">
        <button className="reasoning-toggle" aria-expanded={showText} onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>
          <IconChevron size={12} className={`chev ${showText ? 'open' : ''}`} />
          Reasoning
        </button>
        {showText && (
          <div className="reasoning-text">
            <Highlight text={text} query={searchQuery} />
          </div>
        )}
      </div>
    </div>
  );
}

function BoundaryRow({ e, onSelect }: { e: Extract<TraceEvent, { kind: 'turn_boundary' }>; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div className="row boundary-row" onClick={() => onSelect(e.id)}>
      <span className="boundary-label">
        <span className="boundary-tag">Request {e.requestIndex + 1}</span>
        <span className="boundary-meta">
          {e.model ? ` · ${e.model}` : ''}
          {e.durationMs !== undefined ? ` · ${fmtDuration(e.durationMs)}` : ''}
        </span>
      </span>
      <span className="boundary-line" />
    </div>
  );
}

function SmallRow({
  e,
  tone,
  icon,
  text,
  onSelect,
  searchQuery,
}: {
  e: TraceEvent;
  tone: string;
  icon: JSX.Element;
  text: string;
  onSelect: (id: string) => void;
  searchQuery: string;
}): JSX.Element {
  return (
    <div className={`row small-row ${tone}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body small-body">
        <span className="small-icon">{icon}</span>
        <span className="small-text">
          <Highlight text={text} query={searchQuery} />
        </span>
      </div>
    </div>
  );
}

function FileChangeRow({ e, selected, onSelect, searchQuery }: { e: FileChangeEvent; selected: boolean; onSelect: (id: string) => void; searchQuery: string }): JSX.Element {
  return (
    <div className={`row small-row file-change-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body small-body">
        <span className={`change-tag change-${e.changeType}`}>{e.changeType}</span>
        <span className="mono">
          <Highlight text={e.path} query={searchQuery} />
        </span>
        {e.additions !== undefined && (
          <span className="diffstat">
            <span className="add">+{e.additions}</span> <span className="del">−{e.deletions ?? 0}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function AggregateRow({
  pairs,
  expanded,
  onToggle,
  selectedEventId,
  onSelect,
  searchQuery,
  matchEventIds,
  activeMatchId,
}: {
  pairs: ToolPair[];
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  searchQuery: string;
  matchEventIds: ReadonlySet<string>;
  activeMatchId: string | null;
}): JSX.Element {
  const counts = new Map<string, { n: number; cat: string }>();
  for (const p of pairs) {
    const name = p.call?.toolName ?? p.result?.toolName ?? '?';
    const entry = counts.get(name);
    if (entry) entry.n++;
    else counts.set(name, { n: 1, cat: p.call?.toolCategory ?? 'other' });
  }
  const totalMs = pairs.reduce((a, p) => a + (p.result?.durationMs ?? p.call?.durationMs ?? 0), 0);
  const errorCount = pairs.filter((p) => p.result?.isError).length;
  const anchor = pairs[0]?.call ?? pairs[0]?.result;
  const matchCount = pairs.filter((p) => matchEventIds.has(p.call?.id ?? '') || matchEventIds.has(p.result?.id ?? '')).length;
  const hasActive = pairs.some((p) => activeMatchId === p.call?.id || activeMatchId === p.result?.id);
  return (
    <div className={`aggregate-row ${expanded ? 'open' : ''} ${matchCount > 0 ? 'has-match' : ''} ${hasActive ? 'active-match' : ''}`}>
      <div className="row aggregate-head">
        <div className="row-gutter">
          {anchor && <TimeGutter e={anchor} />}
          {matchCount > 0 && (
            <span className="match-mark" title={`${matchCount} search matches in this group`}>
              <IconSearch size={11} />
              {matchCount}
            </span>
          )}
        </div>
        <div className="row-body">
          <button className="aggregate-header" aria-expanded={expanded} onClick={onToggle}>
            <span className="aggregate-chevron">
              <IconChevron size={12} className={`chev ${expanded ? 'open' : ''}`} />
            </span>
            <span className="aggregate-count">{pairs.length} tool actions</span>
            <span className="aggregate-tools">
              {[...counts.entries()].map(([name, { n, cat }]) => (
                <span key={name} className={`aggregate-tool cat-${cat}`}>
                  {name}
                  <span className="aggregate-n">×{n}</span>
                </span>
              ))}
            </span>
            {errorCount > 0 && <span className="aggregate-errors">{errorCount} failed</span>}
            {totalMs > 0 && <span className="aggregate-duration">{fmtDuration(totalMs)}</span>}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="aggregate-body">
          {pairs.map((p, i) => (
            <ToolRow key={p.call?.id ?? p.result?.id ?? i} pair={p} expanded={false} onToggle={() => onSelect(p.call?.id ?? p.result?.id ?? '')} selectedEventId={selectedEventId} onSelect={onSelect} flat searchQuery={searchQuery} matchEventIds={matchEventIds} activeMatchId={activeMatchId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({
  pair,
  expanded,
  onToggle,
  selectedEventId,
  onSelect,
  flat,
  searchQuery,
  matchEventIds,
  activeMatchId,
}: {
  pair: ToolPair;
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelect: (id: string) => void;
  flat?: boolean;
  searchQuery: string;
  matchEventIds: ReadonlySet<string>;
  activeMatchId: string | null;
}): JSX.Element {
  const call = pair.call;
  const result = pair.result;
  const anchor = call ?? result!;
  const selected = selectedEventId === (call?.id ?? result?.id) || selectedEventId === (result?.id ?? call?.id);
  const matched = matchEventIds.has(call?.id ?? '') || matchEventIds.has(result?.id ?? '');
  const active = activeMatchId !== null && (activeMatchId === call?.id || activeMatchId === result?.id);
  const name = call?.toolName ?? result?.toolName ?? '?';
  const dur = result?.durationMs ?? call?.durationMs;
  const isError = result?.isError;
  const summary = call?.summary ?? (result?.filePath ? shortPath(result.filePath) : '');
  return (
    <div
      className={`row tool-row ${flat ? 'flat' : ''} ${selected ? 'selected' : ''} ${isError ? 'has-error' : ''} ${matched && !selected ? 'has-match' : ''} ${active ? 'active-match' : ''}`}
    >
      <div className="row-gutter">
        <TimeGutter e={anchor} />
        <MatchMark matched={matched} />
      </div>
      <div className="row-body">
        <button
          className="tool-header"
          onClick={() => {
            onToggle();
            onSelect(anchor.id);
          }}
        >
          <span className={`tool-cat cat-${call?.toolCategory ?? 'other'}`}>{name}</span>
          <span className="tool-summary mono" title={summary}>
            <Highlight text={summary} query={searchQuery} />
          </span>
          {result?.additions !== undefined && (
            <span className="diffstat">
              <span className="add">+{result.additions}</span> <span className="del">−{result.deletions ?? 0}</span>
            </span>
          )}
          {dur !== undefined && <span className="tool-dur">{fmtDuration(dur)}</span>}
          {isError ? (
            <span className="tool-status err">error</span>
          ) : result ? (
            <span className="tool-status ok" title="Succeeded">
              <IconCheck size={12} />
            </span>
          ) : (
            <span className="tool-status pending" title="Pending">…</span>
          )}
          <span className="tool-chevron">
            <IconChevron size={12} className={`chev ${expanded ? 'open' : ''}`} />
          </span>
        </button>
        {expanded && (
          <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
            {call?.input !== undefined && (
              <div className="tool-section">
                <div className="tool-section-label">Arguments</div>
                <JsonView data={call.input} name={undefined} defaultOpen />
              </div>
            )}
            {result?.stdout && (
              <OutputBlock label="stdout" text={result.stdout} highlight={searchQuery} />
            )}
            {result?.stderr && <OutputBlock label="stderr" text={result.stderr} tone="err" highlight={searchQuery} />}
            {result?.output && !result.stdout && <OutputBlock label="output" text={result.output} tone={isError ? 'err' : undefined} highlight={searchQuery} />}
            {result?.structuredPatch && result.structuredPatch.length > 0 && (
              <div className="tool-section">
                <div className="tool-section-label">Diff</div>
                <PatchView patches={result.structuredPatch} highlight={searchQuery} />
              </div>
            )}
            <div className="tool-meta">
              {call && <MetaChip label="call" value={call.callId} />}
              {result && <MetaChip label="duration" value={fmtDuration(result.durationMs)} />}
              {result?.exitCode !== undefined && <MetaChip label="exit" value={String(result.exitCode)} />}
              {result?.filePath && <MetaChip label="file" value={shortPath(result.filePath)} />}
              {call?.mcpServer && <MetaChip label="mcp" value={call.mcpServer} />}
              <span className="tool-hint">click row title to inspect raw JSON →</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OutputBlock({ label, text, tone, highlight }: { label: string; text: string; tone?: 'err'; highlight?: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 1500;
  const shown = expanded || !isLong ? text : `${text.slice(0, 1500)}\n… (${text.length} chars — click to expand)`;
  return (
    <div className="tool-section">
      <button className="tool-section-label clickable" onClick={() => setExpanded(!expanded)}>
        {label}
        {isLong && <IconChevron size={11} className={`chev ${expanded ? 'open' : ''}`} />}
      </button>
      <pre className={`tool-output ${tone === 'err' ? 'err' : ''}`}>
        <Highlight text={shown} query={highlight ?? ''} />
      </pre>
    </div>
  );
}

function PatchView({ patches, highlight }: { patches: StructuredPatch[]; highlight: string }): JSX.Element {
  return (
    <div className="patch-view">
      {patches.map((p, i) => (
        <div key={i}>
          {p.newFile && <div className="patch-file mono"><Highlight text={p.newFile} query={highlight} /></div>}
          {(p.hunks ?? []).map((h, j) => (
            <pre key={j} className="patch-hunk mono">
              {h.lines.map((line, k) => (
                <div key={k} className={`patch-line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}`}>
                  <Highlight text={line || ' '} query={highlight} />
                </div>
              ))}
            </pre>
          ))}
        </div>
      ))}
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="meta-chip">
      <span className="meta-label">{label}</span> <span className="mono">{value}</span>
    </span>
  );
}

export function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}
