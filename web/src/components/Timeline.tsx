import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineSpan } from '../types.js';
import { fmtDuration } from '../format.js';

const TRACK_ORDER = ['model', 'bash', 'read', 'edit', 'write', 'grep', 'glob', 'mcp', 'task', 'web', 'other'];
const TRACK_LABEL: Record<string, string> = {
  model: 'MODEL',
  bash: 'BASH',
  read: 'READ',
  edit: 'EDIT',
  write: 'WRITE',
  grep: 'GREP',
  glob: 'GLOB',
  mcp: 'MCP',
  task: 'AGENT',
  web: 'WEB',
  other: 'OTHER',
};
const TRACK_COLORS: Record<string, string> = {
  model: '#4c8dff',
  bash: '#d29922',
  read: '#39a0ed',
  edit: '#3fb950',
  write: '#2ea043',
  grep: '#39c5cf',
  glob: '#39c5cf',
  mcp: '#b695f8',
  task: '#f0883a',
  web: '#db61a2',
  other: '#7d8590',
};

const LABEL_W = 52;
const TRACK_H = 18;
const TRACK_GAP = 4;
const AXIS_H = 16;
const MIN_SPAN_PX = 2;

interface Hover {
  x: number;
  y: number;
  span: TimelineSpan;
}

export function Timeline({ spans, onSelect }: { spans: TimelineSpan[]; onSelect: (eventId: string) => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ start: number; span: number } | null>(null); // ms domain
  const [hover, setHover] = useState<Hover | null>(null);
  const [size, setSize] = useState({ w: 800, h: 120 });
  const dragRef = useRef<{ x: number; view: { start: number; span: number } } | null>(null);

  const tracks = useMemo(() => {
    const present = new Set<string>(spans.map((s) => s.track));
    return TRACK_ORDER.filter((t) => present.has(t));
  }, [spans]);

  const domain = useMemo(() => {
    if (spans.length === 0) return { min: 0, max: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const s of spans) {
      if (s.startMs < min) min = s.startMs;
      if (s.endMs > max) max = s.endMs;
    }
    if (max - min < 1) max = min + 1;
    return { min, max };
  }, [spans]);

  const totalH = AXIS_H + tracks.length * (TRACK_H + TRACK_GAP) + 6;

  // Resize observer
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: totalH });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: totalH });
    return () => ro.disconnect();
  }, [totalH]);

  // Reset view when the run changes.
  useEffect(() => {
    setView(null);
  }, [spans]);

  const v = view ?? { start: domain.min, span: domain.max - domain.min };
  const pxPerMs = (size.w - LABEL_W) / v.span;

  const xOf = useCallback((ms: number) => LABEL_W + (ms - v.start) * pxPerMs, [v, pxPerMs, size.w]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${totalH}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, totalH);

    // Background
    ctx.fillStyle = '#0e1218';
    ctx.fillRect(0, 0, size.w, totalH);

    // Track labels + lanes
    tracks.forEach((track, i) => {
      const y = AXIS_H + i * (TRACK_H + TRACK_GAP);
      ctx.fillStyle = '#59636e';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(TRACK_LABEL[track] ?? track, 6, y + TRACK_H / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(LABEL_W, y, size.w - LABEL_W, TRACK_H);
    });

    // Time grid + axis labels
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tickCount = 6;
    for (let i = 0; i <= tickCount; i++) {
      const ms = v.start + (v.span * i) / tickCount;
      const x = LABEL_W + ((size.w - LABEL_W) * i) / tickCount;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, AXIS_H, 1, totalH - AXIS_H);
      ctx.fillStyle = '#59636e';
      const rel = ms - domain.min;
      ctx.fillText(fmtDuration(rel), x, 2);
    }

    // Spans
    const trackIndex = new Map(tracks.map((t, i) => [t, i]));
    for (const s of spans) {
      const ti = trackIndex.get(s.track);
      if (ti === undefined) continue;
      const y = AXIS_H + ti * (TRACK_H + TRACK_GAP) + 2;
      const x1 = Math.max(LABEL_W, xOf(s.startMs));
      const x2 = Math.min(size.w, xOf(s.endMs));
      if (x2 <= LABEL_W || x1 >= size.w) continue;
      const w = Math.max(MIN_SPAN_PX, x2 - x1);
      const color = s.spanKind === 'request' ? TRACK_COLORS.model : (TRACK_COLORS[s.track] ?? TRACK_COLORS.other);
      ctx.fillStyle = s.isError ? '#f85149' : color;
      ctx.globalAlpha = s.spanKind === 'request' ? 0.55 : 0.85;
      const h = s.spanKind === 'request' ? TRACK_H - 4 : TRACK_H - 6;
      const ry = s.spanKind === 'request' ? y - 1 : y + 1;
      roundRect(ctx, x1, ry, w, h, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }, [spans, tracks, size, v, domain, xOf, totalH]);

  const findSpanAt = useCallback(
    (clientX: number): TimelineSpan | null => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = clientX - rect.left;
      if (x < LABEL_W) return null;
      const ms = v.start + (x - LABEL_W) / pxPerMs;
      // Prefer the smallest span under the cursor.
      let best: TimelineSpan | null = null;
      let bestDur = Infinity;
      for (const s of spans) {
        if (ms >= s.startMs && ms <= s.endMs) {
          const dur = s.endMs - s.startMs;
          if (dur < bestDur) {
            bestDur = dur;
            best = s;
          }
        }
      }
      return best;
    },
    [spans, v, pxPerMs],
  );

  const onCanvasMove = (e: React.MouseEvent) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dms = -dx / pxPerMs;
      let start = dragRef.current.view.start + dms;
      start = Math.min(Math.max(start, domain.min), domain.min + (domain.max - domain.min) - v.span);
      setView({ start, span: dragRef.current.view.span });
      return;
    }
    const span = findSpanAt(e.clientX);
    if (span) {
      const rect = canvasRef.current?.getBoundingClientRect();
      setHover({
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
        span,
      });
    } else {
      setHover(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const focusMs = v.start + (x - LABEL_W) / pxPerMs;
    const zoom = e.deltaY > 0 ? 1.25 : 0.8;
    let span = Math.min(v.span * zoom, domain.max - domain.min);
    span = Math.max(span, 50);
    let start = focusMs - ((x - LABEL_W) / (size.w - LABEL_W)) * span;
    start = Math.min(Math.max(start, domain.min), domain.max - span);
    setView({ start, span });
  };

  const fmtAbs = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      <div className="timeline-toolbar">
        <span className="timeline-label">Timeline</span>
        <button className="icon-btn" title="Fit entire run (double-click canvas)" onClick={() => setView(null)}>
          ⤢ Fit
        </button>
        <span className="timeline-hint">scroll = zoom · drag = pan · click = jump</span>
      </div>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        style={{ cursor: dragRef.current ? 'grabbing' : 'crosshair' }}
        onMouseMove={onCanvasMove}
        onMouseLeave={() => {
          setHover(null);
          dragRef.current = null;
        }}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, view: { ...v } };
        }}
        onMouseUp={(e) => {
          const wasDrag = dragRef.current && Math.abs(e.clientX - dragRef.current.x) > 3;
          dragRef.current = null;
          if (wasDrag) return;
          const span = findSpanAt(e.clientX);
          if (span) onSelect(span.eventId);
        }}
        onWheel={onWheel}
        onDoubleClick={() => setView(null)}
      />
      {hover && (
        <div
          className="timeline-tooltip"
          style={{
            left: Math.min(hover.x + 12, size.w - 260),
            top: Math.min(hover.y + 14, totalH + 4),
          }}
        >
          <div className="tt-title">{hover.span.label}</div>
          <div className="tt-row">
            <span>{fmtAbs(hover.span.startMs)}</span>
            <span>{fmtDuration(hover.span.endMs - hover.span.startMs)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
