import { Fragment } from 'react';
import type { SearchMatch } from '../api.js';
import { fmtTime } from '../format.js';
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
  onJump,
  searching,
  total,
  shown,
}: {
  filters: FilterState;
  onToggle: (id: string) => void;
  search: string;
  onSearch: (q: string) => void;
  matches: SearchMatch[];
  onJump: (eventId: string) => void;
  searching: boolean;
  total: number;
  shown: number;
}): JSX.Element {
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
            aria-label="Search events"
            placeholder="Search events, tools, commands, paths…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
          {searching && <span className="search-spinner" />}
          {search && (
            <div className="search-results">
              <div className="search-results-header">
                {matches.length} match{matches.length === 1 ? '' : 'es'}
              </div>
              <div className="search-results-list">
                {matches.slice(0, 50).map((m) => (
                  <button key={m.eventId} className="search-result" onClick={() => onJump(m.eventId)}>
                    <span className={`kind-dot kind-${m.kind}`} />
                    <span className="search-result-meta">
                      {m.kind === 'tool_call' || m.kind === 'tool_result' ? m.toolName : m.kind.replace('_message', '').replace('_', ' ')}
                    </span>
                    <span className="search-result-snippet">{m.snippet}</span>
                    {m.timestamp && <span className="search-result-time">{fmtTime(m.timestamp)}</span>}
                  </button>
                ))}
                {matches.length === 0 && <div className="search-empty">No matches.</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
