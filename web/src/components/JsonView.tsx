import { useState } from 'react';

/**
 * Collapsible, syntax-colored JSON tree. Renders via React nodes only —
 * trace data never touches innerHTML.
 */
export function JsonView({ data, name, depth = 0, defaultOpen }: { data: unknown; name?: string; depth?: number; defaultOpen?: boolean }): JSX.Element {
  return (
    <div className="jv">
      <JsonNode data={data} name={name} depth={depth} defaultOpen={defaultOpen ?? depth < 2} />
    </div>
  );
}

function JsonNode({ data, name, depth, defaultOpen }: { data: unknown; name?: string; depth: number; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [longOpen, setLongOpen] = useState(false);
  const keyEl = name !== undefined && <span className="jv-key">&quot;{name}&quot;:</span>;

  if (data === null || typeof data !== 'object') {
    let valueEl: JSX.Element;
    if (data === null) valueEl = <span className="jv-null">null</span>;
    else if (typeof data === 'number') valueEl = <span className="jv-num">{String(data)}</span>;
    else if (typeof data === 'boolean') valueEl = <span className="jv-bool">{String(data)}</span>;
    else {
      const s = data as string;
      const display = !longOpen && s.length > 240 ? `${s.slice(0, 240)}…` : s;
      valueEl = (
        <span className="jv-str">
          &quot;{display}&quot;
          {s.length > 240 && (
            <button className="jv-more" onClick={() => setLongOpen(!longOpen)}>
              {longOpen ? ' less' : ` ${s.length} chars`}
            </button>
          )}
        </span>
      );
    }
    return (
      <div className="jv-line">
        <span className="jv-toggle-sp" />
        {keyEl}
        {valueEl}
      </div>
    );
  }

  const isArr = Array.isArray(data);
  const entries: Array<[string | number, unknown]> = isArr
    ? (data as unknown[]).map((v, i) => [i, v])
    : Object.entries(data as Record<string, unknown>);

  if (entries.length === 0) {
    return (
      <div className="jv-line">
        <span className="jv-toggle-sp" />
        {keyEl}
        <span className="jv-punc">{isArr ? '[]' : '{}'}</span>
      </div>
    );
  }

  const summary = isArr ? `${entries.length} items` : `${entries.length} keys`;
  return (
    <div className="jv-node" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <div className="jv-line">
        <button className="jv-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        {keyEl}
        <span className="jv-punc">{isArr ? '[' : '{'}</span>
        {!open && (
          <>
            <span className="jv-summary" onClick={() => setOpen(true)}>
              {' '}
              {summary}{' '}
            </span>
            <span className="jv-punc">{isArr ? ']' : '}'}</span>
          </>
        )}
      </div>
      {open && (
        <>
          <div className="jv-children">
            {entries.slice(0, 500).map(([k, v]) => (
              <JsonNode key={String(k)} data={v} name={isArr ? undefined : String(k)} depth={depth + 1} defaultOpen={depth + 1 < 2} />
            ))}
            {entries.length > 500 && <div className="jv-truncated">… {entries.length - 500} more not shown</div>}
          </div>
          <div className="jv-line">
            <span className="jv-toggle-sp" />
            <span className="jv-punc">{isArr ? ']' : '}'}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? '✓ Copied' : label}
    </button>
  );
}
