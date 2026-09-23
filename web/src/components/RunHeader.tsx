import type { FileChangeSummary, TraceRun } from '../types.js';
import { PROVIDER_LABEL, fmtBytes, fmtDuration, fmtTokens, fmtDateTime } from '../format.js';

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
          <span className={`provider-tag provider-${run.provider}`}>{PROVIDER_LABEL[run.provider] ?? run.provider}</span>
          <span className="run-title" title={run.title}>
            {run.title}
          </span>
        </div>
        <div className="run-sub">
          <span title={run.cwd ?? ''}>{run.project}</span>
          {run.gitBranch && (
            <span className="git-branch" title={run.gitRepo ?? ''}>
              ⎇ {run.gitBranch}
            </span>
          )}
          {run.models.length > 0 && <span>{run.models.join(' · ')}</span>}
          <span>
            {fmtDateTime(run.startedAt)} → {runDateTimeEnd(run)}
          </span>
        </div>
      </div>
      <div className="run-stats">
        <Stat label="Duration" value={fmtDuration(run.durationMs)} />
        <Stat label="Requests" value={String(s.requests)} />
        <Stat label="Events" value={String(s.events)} />
        <Stat label="Tools" value={String(s.toolCalls)} />
        <Stat label="Commands" value={String(s.commandsRun)} />
        <Stat label="Errors" value={String(s.errors)} cls={s.errors > 0 ? 'bad' : undefined} />
        <Stat label="Synthetic" value={String(s.syntheticMessages)} cls={s.syntheticMessages > 0 ? 'warn' : undefined} />
        <Stat label="Tokens" value={fmtTokens(u.totalTokens)} title={`in ${fmtTokens(u.inputTokens)} · out ${fmtTokens(u.outputTokens)} · cache-read ${fmtTokens(u.cachedInputTokens)} · cache-write ${fmtTokens(u.cacheWriteTokens)} · reasoning ${fmtTokens(u.reasoningTokens)}`} />
        <button className={`files-btn ${filesOpen ? 'on' : ''}`} onClick={onShowFiles} title="Files changed">
          Files ({fileChanges.length})
        </button>
      </div>
      <div className="run-fileinfo">
        {run.fileName} · {fmtBytes(run.fileSizeBytes)}
        {run.warnings.length > 0 && (
          <span className="run-warnings" title={run.warnings.join('\n')}>
            ⚠ {run.warnings.length} note{run.warnings.length > 1 ? 's' : ''}
          </span>
        )}
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
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
