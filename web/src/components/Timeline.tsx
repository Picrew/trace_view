import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineSpan } from '../types.js';
import { fmtDuration } from '../format.js';
import { IconFit } from './Icons.js';

const TRACK_ORDER = ['model', 'bash', 'read', 'edit', 'write', 'grep', 'glob', 'mcp', 'task', 'web', 'other'];
const TRACK_LABEL: Record<string, string> = {
  model: 'Model',
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  mcp: 'MCP',
  task: 'Agent',
  web: 'Web',
  other: 'Other',
};

// Color = meaning only: blue model, amber tools, green edits, red errors.
// Kept in sync with --model / --tool / --edit / --error in styles/tokens.css.
const C = {
  model: '#7b9be0',
  tool: '#d0a35c',
  edit: '#7fb88a',
  error: '#e07a72',
  bg: '#14161a',
  label: '#7d8592',
  axis: '#5d6571',
  hairline: 'rgba(255,255,255,0.045)',
  grid: 'rgba(255,255,255,0.035)',
};
export function trackColor(track: string): string {
  if (track === 'model') return C.model;
  if (track === 'edit' || track === 'write') return C.edit;
  return C.tool;
}

const LABEL_W = 60;
const TRACK_H = 16;
const TRACK_GAP = 3;
const AXIS_H = 18;
const MIN_SPAN_PX = 2;
/** Candidate tick steps (ms) — the first one giving ≥ ~110px spacing wins. */
const TICK_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1e3, 2e3, 5e3, 10e3, 15e3, 30e3,
  60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 48 * 3600e3,
];

/** Axis labels drop zero sub-units: "24h 0m" → "24h", "2m 0s" → "2m". */
const fmtTick = (ms: number): string => fmtDuration(ms).replace(/ 0[ms]$/, '');

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
  const cursorRef = useRef<HTMLDivElement>(null);

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

  const totalH = AXIS_H + tracks.length * (TRACK_H + TRACK_GAP);

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

  const v = useMemo(() => view ?? { start: domain.min, span: domain.max - domain.min }, [view, domain]);
  const plotW = Math.max(1, size.w - LABEL_W);
  const pxPerMs = plotW / v.span;

  const xOf = useCallback((ms: number) => LABEL_W + (ms - v.start) * pxPerMs, [v, pxPerMs]);

  // Paint order: requests (background band) → tools → errors on top.
  const ordered = useMemo(() => {
    const rank = (s: TimelineSpan) => (s.isError ? 2 : s.spanKind === 'request' ? 0 : 1);
    return [...spans].sort((a, b) => rank(a) - rank(b));
  }, [spans]);

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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, totalH);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, size.w, totalH);

    const laneY = (i: number) => AXIS_H + i * (TRACK_H + TRACK_GAP);

    // Time grid + axis labels at "nice" intervals, relative to run start.
    const step = TICK_STEPS.find((st) => st * pxPerMs >= 110) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const first = Math.ceil((v.start - domain.min) / step) * step;
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let rel = first; rel <= v.start - domain.min + v.span; rel += step) {
      const x = Math.round(xOf(domain.min + rel)) + 0.5;
      if (x < LABEL_W || x > size.w) continue;
      ctx.fillStyle = C.grid;
      ctx.fillRect(x - 0.5, AXIS_H - 4, 1, totalH - AXIS_H + 4);
      const label = rel === 0 ? '0' : fmtTick(rel);
      if (x + 4 + ctx.measureText(label).width < size.w - 2) {
        ctx.fillStyle = C.axis;
        ctx.fillText(label, x + 4, AXIS_H / 2);
      }
    }

    // Lane hairlines + labels (no filled lanes — the track stays quiet).
    tracks.forEach((track, i) => {
      const y = laneY(i);
      if (i < tracks.length - 1) {
        ctx.fillStyle = C.hairline;
        ctx.fillRect(LABEL_W, y + TRACK_H + Math.floor(TRACK_GAP / 2), size.w - LABEL_W, 1);
      }
      ctx.fillStyle = C.label;
      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      ctx.fillText(TRACK_LABEL[track] ?? track, 16, y + TRACK_H / 2);
    });
    ctx.fillStyle = C.hairline;
    ctx.fillRect(LABEL_W - 1, AXIS_H, 1, totalH - AXIS_H);

    // Spans
    const trackIndex = new Map(tracks.map((t, i) => [t, i]));
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, size.w - LABEL_W, totalH);
    ctx.clip();
    for (const s of ordered) {
      const ti = trackIndex.get(s.track);
      if (ti === undefined) continue;
      const y = laneY(ti);
      const x1 = Math.max(LABEL_W, xOf(s.startMs));
      const x2 = Math.min(size.w, xOf(s.endMs));
      if (x2 <= LABEL_W || x1 >= size.w) continue;
      const raw = Math.max(MIN_SPAN_PX, x2 - x1);
      // 1px breathing room between back-to-back spans once they're wide enough.
      const w = raw > 3 ? raw - 1 : raw;
      const hovered = hover?.span.id === s.id;
      if (s.spanKind === 'request') {
        // Model calls: a faint band with a crisp start tick, not a solid bar.
        const color = s.isError ? C.error : C.model;
        ctx.globalAlpha = hovered ? 0.32 : 0.16;
        ctx.fillStyle = color;
        roundRect(ctx, x1, y + 1, w, TRACK_H - 2, 2);
        ctx.fill();
        ctx.globalAlpha = hovered ? 1 : 0.75;
        ctx.fillRect(x1, y + 1, Math.min(1.5, w), TRACK_H - 2);
      } else {
        ctx.fillStyle = s.isError ? C.error : trackColor(s.track);
        ctx.globalAlpha = s.isError ? 0.95 : hovered ? 0.95 : 0.62;
        roundRect(ctx, x1, y + 3, w, TRACK_H - 6, 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, [ordered, tracks, size, v, domain, xOf, totalH, pxPerMs, hover]);

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

  const onCanvasMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Hover cursor line is positioned imperatively — no re-render per pixel.
    const cursor = cursorRef.current;
    if (cursor) {
      cursor.style.display = x >= LABEL_W ? 'block' : 'none';
      cursor.style.transform = `translateX(${Math.round(x)}px)`;
    }
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dms = -dx / pxPerMs;
      let start = dragRef.current.view.start + dms;
      start = Math.min(Math.max(start, domain.min), domain.min + (domain.max - domain.min) - v.span);
      setView({ start, span: dragRef.current.view.span });
      return;
    }
    const span = findSpanAt(e.clientX);
    e.currentTarget.style.cursor = span ? 'pointer' : 'default';
    if (span) {
      setHover({ x, y: e.clientY - rect.top, span });
    } else if (hover) {
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

  // Tooltip flips to the left of the cursor near the right edge.
  const TT_W = 300;
  const ttLeft = hover ? (hover.x + 14 + TT_W > size.w ? Math.max(LABEL_W, hover.x - 14 - TT_W) : hover.x + 14) : 0;

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      <div className="timeline-toolbar">
        <span className="timeline-label">Timeline</span>
        <button className="icon-btn" title="Fit entire run (double-click canvas)" onClick={() => setView(null)}>
          <IconFit size={12} />
          Fit
        </button>
        <span className="timeline-hint">Scroll to zoom · Drag to pan · Click to jump</span>
      </div>
      <div className="timeline-stage">
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onMouseMove={onCanvasMove}
          onMouseLeave={() => {
            setHover(null);
            dragRef.current = null;
            if (cursorRef.current) cursorRef.current.style.display = 'none';
          }}
          onMouseDown={(e) => {
            dragRef.current = { x: e.clientX, view: { ...v } };
            e.currentTarget.style.cursor = 'grabbing';
          }}
          onMouseUp={(e) => {
            const wasDrag = dragRef.current && Math.abs(e.clientX - dragRef.current.x) > 3;
            dragRef.current = null;
            e.currentTarget.style.cursor = 'default';
            if (wasDrag) return;
            const span = findSpanAt(e.clientX);
            if (span) onSelect(span.eventId);
          }}
          onWheel={onWheel}
          onDoubleClick={() => setView(null)}
        />
        <div className="timeline-cursor" ref={cursorRef} style={{ left: 0 }} />
        {hover && (
          <div className="timeline-tooltip" style={{ left: ttLeft, top: Math.min(hover.y + 14, totalH - 8) }}>
            <div className="tt-title">
              <span className="tt-swatch" style={{ background: hover.span.isError ? C.error : trackColor(hover.span.spanKind === 'request' ? 'model' : hover.span.track) }} />
              {hover.span.label}
            </div>
            <div className="tt-row">
              <span>{fmtAbs(hover.span.startMs)}</span>
              <span>{fmtDuration(hover.span.endMs - hover.span.startMs)}</span>
            </div>
            {hover.span.isError && <div className="tt-row err">Failed</div>}
          </div>
        )}
      </div>
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
