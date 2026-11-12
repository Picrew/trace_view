import { Fragment, useEffect, useRef, useState } from 'react';
import type { SearchMatch } from '../api.js';
import { fmtTime } from '../format.js';
import { Highlight } from '../highlight.js';
import { IconSearch } from './Icons.js';

export interface FilterState {
  active: Set<string>;
}

/** `group` only drives the visual dividers in the toolbar. */
export const FILTER_DEFS: Array<{ id: string; label: string; group: 'conversation' | 'tools' | 'signals' }> = [
  { id: 'user', label: 'User', group: 'conversation' },
  { id: 'assistant', label: 'Assistant', group: 'conversation' },
  { id: 'reasoning', label: 'Reasoning', group: 'conversation' },
  { id: 'tools', label: 'Tools', group: 'tools' },
  { id: 'bash', label: 'Bash', group: 'tools' },
  { id: 'read', label: 'Read', group: 'tools' },
  { id: 'edit', label: 'Edit/Write', group: 'tools' },
  { id: 'grep', label: 'Search', group: 'tools' },
  { id: 'mcp', label: 'MCP', group: 'tools' },
  { id: 'errors', label: 'Errors', group: 'signals' },
  { id: 'synthetic', label: 'Synthetic', group: 'signals' },
  { id: 'compaction', label: 'Compaction', group: 'signals' },
  { id: 'system', label: 'System', group: 'signals' },
  { id: 'requests', label: 'Requests', group: 'signals' },
];

export function FilterBar({
  filters,
  onToggle,
  search,
  onSearch,
  matches,
  matchIndex,
  onStepMatch,
  onSelectMatch,
  searching,
  total,
  shown,
}: {
  filters: FilterState;
  onToggle: (id: string) => void;
  search: string;
  onSearch: (q: string) => void;
  matches: SearchMatch[];
  matchIndex: number;
  onStepMatch: (delta: number) => void;
  /** Jump to an exact match (popover click) — sets the active index too. */
  onSelectMatch: (index: number) => void;
  searching: boolean;
  total: number;
  shown: number;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeId = matchIndex >= 0 && matchIndex < matches.length ? matches[matchIndex].eventId : null;

  // ⌘F / Ctrl+F focuses the search box (unless something editable is focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        const el = document.activeElement;
        const editable = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        e.preventDefault();
        if (!editable) inputRef.current?.focus();
        else inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the active match visible inside the popover list.
  useEffect(() => {
    const el = listRef.current?.querySelector('.search-result.active');
    // jsdom (tests) does not implement scrollIntoView.
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (search) onSearch('');
      else inputRef.current?.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onStepMatch(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowDown' && matches.length > 0) {
      e.preventDefault();
      onStepMatch(1);
    }
  };

  // The popover is anchored to focus: typing keeps it open, leaving the field
  // dismisses it. Blur fires before click on the result row — delay long
  // enough for the pointer to land, cancel if focus comes back.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const openPopover = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setPopoverOpen(true);
  };
  const scheduleClose = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setPopoverOpen(false), 180);
  };
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  return (
    <div className="filter-bar">
      <div className="filter-chips" role="toolbar" aria-label="Event filters">
        <button
          className={`filter-chip ${filters.active.size === 0 ? 'on' : ''}`}
          aria-pressed={filters.active.size === 0}
          onClick={() => onToggle('__all')}
        >
          All
        </button>
        {FILTER_DEFS.map((f, i) => (
          <Fragment key={f.id}>
            {(i === 0 || FILTER_DEFS[i - 1].group !== f.group) && <span className="filter-sep" aria-hidden="true" />}
            <button
              className={`filter-chip ${filters.active.has(f.id) ? 'on' : ''}`}
              aria-pressed={filters.active.has(f.id)}
              onClick={() => onToggle(f.id)}
            >
              {f.label}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="filter-right">
        <span className={`filter-count ${shown !== total ? 'filtered' : ''}`} title="Events shown / total">
          {shown}/{total}
        </span>
        <div className="search-box">
          <IconSearch size={13} className="field-icon" />
          <input
            ref={inputRef}
            aria-label="Search events"
            placeholder="Search events, tools, commands, paths… (⌘F)"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={onInputKey}
            onFocus={openPopover}
            onBlur={scheduleClose}
          />
          {searching && <span className="search-spinner" />}
          {search && !searching && matches.length > 0 && (
            <span className="search-nav" aria-label={`Match ${matchIndex + 1} of ${matches.length}`}>
              <button className="search-nav-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => onStepMatch(-1)}>
                ‹
              </button>
              <span className="search-nav-count">
                {matchIndex + 1}/{matches.length}
              </span>
              <button className="search-nav-btn" title="Next match (Enter)" aria-label="Next match" onClick={() => onStepMatch(1)}>
                ›
              </button>
            </span>
          )}
          {search && popoverOpen && (
            <div className="search-results" onMouseDown={openPopover}>
              <div className="search-results-header">
                {matches.length} match{matches.length === 1 ? '' : 'es'}
                {matches.length > 50 && <span className="search-results-more"> · showing first 50</span>}
              </div>
              <div className="search-results-list" ref={listRef}>
                {matches.slice(0, 50).map((m, i) => (
                  <button
                    key={m.eventId}
                    className={`search-result ${matchIndex === i ? 'active' : ''}`}
                    onClick={() => onSelectMatch(i)}
                  >
                    <span className={`kind-dot kind-${m.kind}`} />
                    <span className="search-result-meta">
                      {m.kind === 'tool_call' || m.kind === 'tool_result' ? m.toolName : m.kind.replace('_message', '').replace('_', ' ')}
                    </span>
                    <span className="search-result-snippet">
                      <Highlight text={m.snippet} query={search} />
                    </span>
                    {m.timestamp && <span className="search-result-time">{fmtTime(m.timestamp)}</span>}
                  </button>
                ))}
                {matches.length === 0 && !searching && <div className="search-empty">No matches.</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
