import type { SearchMatch } from '../api.js';
import { fmtTime } from '../format.js';

export interface FilterState {
  active: Set<string>;
}

export const FILTER_DEFS: Array<{ id: string; label: string }> = [
  { id: 'user', label: 'User' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'tools', label: 'Tools' },
  { id: 'bash', label: 'Bash' },
  { id: 'read', label: 'Read' },
  { id: 'edit', label: 'Edit/Write' },
  { id: 'grep', label: 'Search' },
  { id: 'mcp', label: 'MCP' },
  { id: 'errors', label: 'Errors' },
  { id: 'synthetic', label: 'Synthetic' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'system', label: 'System' },
  { id: 'requests', label: 'Requests' },
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
      <div className="filter-chips">
        <button className={`filter-chip ${filters.active.size === 0 ? 'on' : ''}`} onClick={() => onToggle('__all')}>
          All
        </button>
        {FILTER_DEFS.map((f) => (
          <button key={f.id} className={`filter-chip ${filters.active.has(f.id) ? 'on' : ''}`} onClick={() => onToggle(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="filter-right">
        <span className="filter-count">
          {shown}/{total}
        </span>
        <div className="search-box">
          <input
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
