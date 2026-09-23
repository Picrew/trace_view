import type { FileChangeSummary } from '../types.js';
import { shortPath } from './Trajectory.js';

export function FilesPanel({
  fileChanges,
  onJump,
}: {
  fileChanges: FileChangeSummary[];
  onJump: (eventId: string) => void;
}): JSX.Element {
  if (fileChanges.length === 0) {
    return (
      <div className="files-panel">
        <div className="inspector-header">
          <span>Files Changed</span>
        </div>
        <div className="inspector-empty">No file changes detected in this run.</div>
      </div>
    );
  }
  const totalAdd = fileChanges.reduce((a, f) => a + f.additions, 0);
  const totalDel = fileChanges.reduce((a, f) => a + f.deletions, 0);
  return (
    <div className="files-panel">
      <div className="inspector-header">
        <span>
          Files Changed ({fileChanges.length}){' '}
          <span className="diffstat">
            <span className="add">+{totalAdd}</span> <span className="del">−{totalDel}</span>
          </span>
        </span>
      </div>
      <div className="files-list">
        {fileChanges.map((f) => (
          <button key={f.path} className="file-row" onClick={() => onJump(f.eventIds[0])} title={f.path}>
            <span className={`change-tag change-${f.changeType}`}>{f.changeType}</span>
            <span className="file-path mono">{shortPath(f.path)}</span>
            <span className="diffstat">
              <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
            </span>
            {f.eventIds.length > 1 && <span className="file-times">×{f.eventIds.length}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
