import { useEffect, useState } from 'react';
import type { TraceEvent, TraceRun } from '../types.js';
import { api } from '../api.js';
import { fmtDuration } from '../format.js';
import { JsonView, CopyButton } from './JsonView.js';
import { shortPath } from './Trajectory.js';

export function Inspector({
  run,
  event,
  onClose,
}: {
  run: TraceRun;
  event: TraceEvent | null;
  onClose: () => void;
}): JSX.Element {
  const [raw, setRaw] = useState<unknown>(null);
  const [rawLoading, setRawLoading] = useState(false);

  useEffect(() => {
    setRaw(null);
    if (!event) return;
    let cancelled = false;
    setRawLoading(true);
    api
      .raw(run.id, event.id)
      .then((r) => {
        if (!cancelled) setRaw(r.raw);
      })
      .catch(() => {
        if (!cancelled) setRaw(null);
      })
      .finally(() => {
        if (!cancelled) setRawLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id, event]);

  if (!event) {
    return (
      <div className="inspector">
        <div className="inspector-header">
          <span>Inspector</span>
        </div>
        <div className="inspector-empty">Select an event to inspect its metadata and raw JSON.</div>
      </div>
    );
  }

  const rows: Array<[string, string | undefined]> = [
    ['Event', event.id],
    ['Kind', event.kind],
    ['Timestamp', event.timestamp ?? '—'],
    ['Duration', event.durationMs !== undefined ? `${fmtDuration(event.durationMs)} (${event.durationMs}ms)` : undefined],
    ['Agent', event.agentId],
    ['Request', event.requestIndex !== undefined ? `#${event.requestIndex + 1}` : undefined],
    ['Turn ID', event.turnId],
    ['Model', event.model],
    ['Provider', event.source.provider],
    ['Raw type', [event.source.rawType, event.source.rawSubtype].filter(Boolean).join(' / ')],
    ['Seq', String(event.seq)],
  ];
  if (event.kind === 'tool_call') {
    rows.push(['Tool', event.toolName]);
    rows.push(['Category', event.toolCategory]);
    rows.push(['Call ID', event.callId]);
    if (event.mcpServer) rows.push(['MCP server', event.mcpServer]);
  }
  if (event.kind === 'tool_result') {
    rows.push(['Tool', event.toolName]);
    rows.push(['Call ID', event.callId]);
    rows.push(['Result kind', event.resultKind]);
    rows.push(['Error', event.isError ? 'yes' : 'no']);
    if (event.exitCode !== undefined) rows.push(['Exit code', String(event.exitCode)]);
    if (event.filePath) rows.push(['File', event.filePath]);
    if (event.additions !== undefined) rows.push(['Diff', `+${event.additions} −${event.deletions ?? 0}`]);
  }
  if (event.kind === 'synthetic_message') rows.push(['Synthetic kind', event.syntheticKind]);
  if (event.kind === 'error') rows.push(['Retry attempt', event.retryAttempt !== undefined ? String(event.retryAttempt) : undefined]);
  if (event.kind === 'file_change') rows.push(['Path', event.path]);

  return (
    <div className="inspector">
      <div className="inspector-header">
        <span className="inspector-title">
          Inspector <span className={`kind-pill kind-${event.kind}`}>{event.kind.replace('_', ' ')}</span>
        </span>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        <div className="inspector-section">
          <div className="section-title">Metadata</div>
          <table className="meta-table">
            <tbody>
              {rows
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="meta-k">{k}</td>
                    <td className="meta-v mono">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {event.kind === 'tool_call' && event.input !== undefined && (
          <div className="inspector-section">
            <div className="section-title">Tool arguments</div>
            <JsonView data={event.input} defaultOpen />
          </div>
        )}

        {event.kind === 'tool_result' && (event.output || event.stdout || event.stderr) && (
          <div className="inspector-section">
            <div className="section-title">Tool result</div>
            {event.stderr && <OutputPre label="stderr" text={event.stderr} tone="err" />}
            {event.stdout && <OutputPre label="stdout" text={event.stdout} />}
            {!event.stdout && event.output && <OutputPre label="output" text={event.output} tone={event.isError ? 'err' : undefined} />}
            {event.filePath && <div className="inspector-note mono">{shortPath(event.filePath)}</div>}
          </div>
        )}

        <div className="inspector-section">
          <div className="section-title">
            Raw JSON
            {raw !== null && <CopyButton text={JSON.stringify(raw, null, 2)} label="Copy JSON" />}
          </div>
          {rawLoading && <div className="inspector-loading">loading raw line…</div>}
          {!rawLoading && raw === null && <div className="inspector-note">Raw not available (derived or broken line).</div>}
          {raw !== null && (
            <div className="raw-json">
              <JsonView data={raw} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputPre({ label, text, tone }: { label: string; text: string; tone?: 'err' }): JSX.Element {
  return (
    <div className="inspector-output">
      <div className="inspector-output-label">{label}</div>
      <pre className={`tool-output ${tone === 'err' ? 'err' : ''}`}>{text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text}</pre>
    </div>
  );
}
