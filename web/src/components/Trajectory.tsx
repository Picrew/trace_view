import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileChangeEvent, StructuredPatch, TraceEvent } from '../types.js';
import type { Row, ToolPair } from '../rows.js';
import { buildRows } from '../rows.js';
import { fmtDuration, fmtTime } from '../format.js';
import { SafeMarkdown } from './SafeMarkdown.js';
import { JsonView } from './JsonView.js';

export function Trajectory({
  events,
  selectedEventId,
  onSelect,
  autoScrollSeq,
  live,
}: {
  events: TraceEvent[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  autoScrollSeq: number;
  live: boolean;
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
            />
          </div>
        ))}
      </div>
        {rows.length === 0 && <div className="trajectory-empty">No events match the current filters.</div>}
      </div>
      {live && !follow && (
        <button className="follow-btn" onClick={jumpToBottom} title="Follow live events">
          ↓ Follow live
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
}: {
  row: Row;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  reasoningOpen: Set<string>;
  onToggleReasoning: (key: string) => void;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}): JSX.Element {
  if (row.kind === 'tool') {
    return <ToolRow pair={row.pair} expanded={expanded.has(row.key)} onToggle={() => onToggle(row.key)} selectedEventId={selectedEventId} onSelect={onSelect} />;
  }
  if (row.kind === 'aggregate') {
    return <AggregateRow pairs={row.pairs} expanded={expanded.has(row.key)} onToggle={() => onToggle(row.key)} selectedEventId={selectedEventId} onSelect={onSelect} />;
  }
  const e = row.event;
  switch (e.kind) {
    case 'user_message':
      return <MessageRow e={e} tone="user" label="You" selected={e.id === selectedEventId} onSelect={onSelect} />;
    case 'assistant_message':
      return <MessageRow e={e} tone="assistant" label="Assistant" model={e.model} selected={e.id === selectedEventId} onSelect={onSelect} />;
    case 'synthetic_message':
      return <SyntheticRow e={e} selected={e.id === selectedEventId} onSelect={onSelect} />;
    case 'reasoning':
      return <ReasoningRow e={e} open={reasoningOpen.has(e.id)} onToggle={() => onToggleReasoning(e.id)} selected={e.id === selectedEventId} onSelect={onSelect} />;
    case 'turn_boundary':
      return <BoundaryRow e={e} onSelect={onSelect} />;
    case 'system':
      return <SmallRow e={e} tone="system" icon="⚙" text={`${e.subtype ?? 'system'}${e.text ? ` — ${e.text}` : ''}`} onSelect={onSelect} />;
    case 'error':
      return <SmallRow e={e} tone="error" icon="✗" text={e.message} onSelect={onSelect} />;
    case 'compaction':
      return <SmallRow e={e} tone="warn" icon="⇲" text={e.text ?? 'Context compacted'} onSelect={onSelect} />;
    case 'file_change':
      return <FileChangeRow e={e} selected={e.id === selectedEventId} onSelect={onSelect} />;
    default:
      return <SmallRow e={e} tone="dim" icon="?" text={`${(e as { rawType?: string }).rawType ?? 'unknown'}${(e as { note?: string }).note ? ` — ${(e as { note?: string }).note}` : ''}`} onSelect={onSelect} />;
  }
});

function TimeGutter({ e }: { e: TraceEvent }): JSX.Element {
  return <span className="time-gutter">{e.timestamp ? fmtTime(e.timestamp) : ''}</span>;
}

function MessageRow({
  e,
  tone,
  label,
  model,
  selected,
  onSelect,
}: {
  e: Extract<TraceEvent, { text: string }>;
  tone: 'user' | 'assistant';
  label: string;
  model?: string;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const hasImages = (e as { hasImages?: boolean }).hasImages === true;
  return (
    <div className={`row message-row ${tone} ${selected ? 'selected' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body">
        <div className="row-label">
          {tone === 'user' ? '● ' : '◆ '}
          {label}
          {hasImages && <span className="img-badge" title="message included pasted images">🖼 {tone === 'user' ? '' : ''}</span>}
          {model && <span className="row-model">{model}</span>}
        </div>
        <div className="message-text">
          <SafeMarkdown text={e.text} />
          {(e as { truncated?: boolean }).truncated && <div className="truncated-note">text truncated — see raw JSON</div>}
        </div>
      </div>
    </div>
  );
}

function SyntheticRow({ e, selected, onSelect }: { e: Extract<TraceEvent, { kind: 'synthetic_message' }>; selected: boolean; onSelect: (id: string) => void }): JSX.Element {
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
    <div className={`row synthetic-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body">
        <div className="row-label">
          <span className="synthetic-badge">synthetic</span>
          <span className="synthetic-kind">{kindLabel[e.syntheticKind] ?? e.syntheticKind}</span>
        </div>
        <div className="synthetic-text">{short}</div>
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
}: {
  e: Extract<TraceEvent, { kind: 'reasoning' }>;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const long = e.text.length > 200;
  return (
    <div className={`row reasoning-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body">
        <button className="reasoning-toggle" onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>
          {open || !long ? '▾' : '▸'} Reasoning
        </button>
        {(open || !long) && <div className="reasoning-text">{e.text}</div>}
      </div>
    </div>
  );
}

function BoundaryRow({ e, onSelect }: { e: Extract<TraceEvent, { kind: 'turn_boundary' }>; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div className="row boundary-row" onClick={() => onSelect(e.id)}>
      <span className="boundary-line" />
      <span className="boundary-label">
        Request {e.requestIndex + 1}
        {e.model ? ` · ${e.model}` : ''}
        {e.durationMs !== undefined ? ` · ${fmtDuration(e.durationMs)}` : ''}
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
}: {
  e: TraceEvent;
  tone: string;
  icon: string;
  text: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className={`row small-row ${tone}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body small-body">
        <span className="small-icon">{icon}</span>
        <span className="small-text">{text}</span>
      </div>
    </div>
  );
}

function FileChangeRow({ e, selected, onSelect }: { e: FileChangeEvent; selected: boolean; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div className={`row small-row file-change-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(e.id)}>
      <div className="row-gutter">
        <TimeGutter e={e} />
      </div>
      <div className="row-body small-body">
        <span className={`change-tag change-${e.changeType}`}>{e.changeType}</span>
        <span className="mono">{shortPath(e.path)}</span>
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
}: {
  pairs: ToolPair[];
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}): JSX.Element {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const name = p.call?.toolName ?? p.result?.toolName ?? '?';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const totalMs = pairs.reduce((a, p) => a + (p.result?.durationMs ?? p.call?.durationMs ?? 0), 0);
  const errorCount = pairs.filter((p) => p.result?.isError).length;
  return (
    <div className="aggregate-row">
      <button className="aggregate-header" onClick={onToggle}>
        <span className="aggregate-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="aggregate-count">{pairs.length} tool actions</span>
        {[...counts.entries()].map(([name, n]) => (
          <span key={name} className="aggregate-tool">
            {name} ×{n}
          </span>
        ))}
        {totalMs > 0 && <span className="aggregate-duration">{fmtDuration(totalMs)}</span>}
        {errorCount > 0 && <span className="aggregate-errors">{errorCount} failed</span>}
      </button>
      {expanded && (
        <div className="aggregate-body">
          {pairs.map((p, i) => (
            <ToolRow key={p.call?.id ?? p.result?.id ?? i} pair={p} expanded={false} onToggle={() => onSelect(p.call?.id ?? p.result?.id ?? '')} selectedEventId={selectedEventId} onSelect={onSelect} flat />
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
}: {
  pair: ToolPair;
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelect: (id: string) => void;
  flat?: boolean;
}): JSX.Element {
  const call = pair.call;
  const result = pair.result;
  const anchor = call ?? result!;
  const selected = selectedEventId === (call?.id ?? result?.id) || selectedEventId === (result?.id ?? call?.id);
  const name = call?.toolName ?? result?.toolName ?? '?';
  const dur = result?.durationMs ?? call?.durationMs;
  const isError = result?.isError;
  const summary = call?.summary ?? (result?.filePath ? shortPath(result.filePath) : '');
  return (
    <div className={`row tool-row ${flat ? 'flat' : ''} ${selected ? 'selected' : ''} ${isError ? 'has-error' : ''}`}>
      <div className="row-gutter">
        <TimeGutter e={anchor} />
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
            {summary}
          </span>
          {result?.additions !== undefined && (
            <span className="diffstat">
              <span className="add">+{result.additions}</span> <span className="del">−{result.deletions ?? 0}</span>
            </span>
          )}
          {dur !== undefined && <span className="tool-dur">{fmtDuration(dur)}</span>}
          {isError ? <span className="tool-status err">error</span> : result ? <span className="tool-status ok">✓</span> : <span className="tool-status pending">…</span>}
          <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
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
              <OutputBlock label="stdout" text={result.stdout} />
            )}
            {result?.stderr && <OutputBlock label="stderr" text={result.stderr} tone="err" />}
            {result?.output && !result.stdout && <OutputBlock label="output" text={result.output} tone={isError ? 'err' : undefined} />}
            {result?.structuredPatch && result.structuredPatch.length > 0 && (
              <div className="tool-section">
                <div className="tool-section-label">Diff</div>
                <PatchView patches={result.structuredPatch} />
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

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: 'err' }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 1500;
  const shown = expanded || !isLong ? text : `${text.slice(0, 1500)}\n… (${text.length} chars — click to expand)`;
  return (
    <div className="tool-section">
      <button className="tool-section-label clickable" onClick={() => setExpanded(!expanded)}>
        {label} {isLong ? (expanded ? '▾' : '▸') : ''}
      </button>
      <pre className={`tool-output ${tone === 'err' ? 'err' : ''}`}>{shown}</pre>
    </div>
  );
}

function PatchView({ patches }: { patches: StructuredPatch[] }): JSX.Element {
  return (
    <div className="patch-view">
      {patches.map((p, i) => (
        <div key={i}>
          {p.newFile && <div className="patch-file mono">{p.newFile}</div>}
          {(p.hunks ?? []).map((h, j) => (
            <pre key={j} className="patch-hunk mono">
              {h.lines.map((line, k) => (
                <div key={k} className={`patch-line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}`}>
                  {line || ' '}
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
