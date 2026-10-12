import type { FileChangeSummary, TraceRun } from '../types.js';
import { PROVIDER_LABEL, fmtBytes, fmtDuration, fmtTokens, fmtDateTime } from '../format.js';
import { IconBranch } from './Icons.js';

export function RunHeader({
  run,
  fileChanges,
  onShowFiles,
  filesOpen,
}: {
  run: TraceRun;
  fileChanges: FileChangeSummary[];
  onShowFiles: () => void;
  filesOpen: boolean;
}): JSX.Element {
  const u = run.usage;
  const s = run.stats;
  return (
    <div className="run-header">
      <div className="run-header-main">
        <div className="run-title-line">
          {run.live && <span className="live-badge">LIVE</span>}
          <h1 className="run-title" title={run.title}>
            {run.title}
          </h1>
        </div>
        <div className="run-sub">
          <span className="run-provider">{PROVIDER_LABEL[run.provider] ?? run.provider}</span>
          <span title={run.cwd ?? ''}>{run.project}</span>
          {run.gitBranch && (
            <span className="git-branch" title={run.gitRepo ?? ''}>
              <IconBranch size={12} />
              {run.gitBranch}
            </span>
          )}
          {run.notes?.map((n) => (
            <span key={n} className="run-note">
              {n}
            </span>
          ))}
          {run.models.length > 0 && <span className="run-models">{run.models.join(' · ')}</span>}
          <span className="run-range">
            {fmtDateTime(run.startedAt)} → {runDateTimeEnd(run)}
          </span>
        </div>
      </div>
      <div className="run-stats">
        {/* Primary: how long, how many model calls, how much work, did anything fail. */}
        <div className="stat-group primary">
          <Stat label="Duration" value={fmtDuration(run.durationMs)} />
          <Stat label="Requests" value={String(s.requests)} />
          <Stat label="Tools" value={String(s.toolCalls)} />
          <Stat label="Errors" value={String(s.errors)} cls={s.errors > 0 ? 'bad' : 'zero'} />
        </div>
        <div className="stat-group secondary">
          <Stat label="Events" value={String(s.events)} />
          <Stat label="Commands" value={String(s.commandsRun)} />
          <Stat label="Synthetic" value={String(s.syntheticMessages)} cls={s.syntheticMessages > 0 ? 'warn' : 'zero'} />
          <Stat label="Tokens" value={fmtTokens(u.totalTokens)} title={`in ${fmtTokens(u.inputTokens)} · out ${fmtTokens(u.outputTokens)} · cache-read ${fmtTokens(u.cachedInputTokens)} · cache-write ${fmtTokens(u.cacheWriteTokens)} · reasoning ${fmtTokens(u.reasoningTokens)}`} />
        </div>
        <div className="run-stats-right">
          <span className="run-fileinfo" title={run.filePath}>
            {run.fileName} · {fmtBytes(run.fileSizeBytes)}
          </span>
          {run.warnings.length > 0 && (
            <span className="run-warnings" title={run.warnings.join('\n')}>
              ⚠ {run.warnings.length} note{run.warnings.length > 1 ? 's' : ''}
            </span>
          )}
          <button className={`files-btn ${filesOpen ? 'on' : ''}`} onClick={onShowFiles} title="Files changed" aria-pressed={filesOpen}>
            Files ({fileChanges.length})
          </button>
        </div>
      </div>
    </div>
  );
}

function runDateTimeEnd(run: TraceRun): string {
  if (!run.endedAt) return '—';
  const d = new Date(run.endedAt);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function Stat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }): JSX.Element {
  return (
    <div className={`stat ${cls ?? ''}`} title={title ?? `${label}: ${value}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
