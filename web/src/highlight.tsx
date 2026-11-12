import { Fragment, type JSX } from 'react';

/**
 * Case-insensitive occurrence highlighting for the event search.
 *
 * The query is treated as a literal (not a regex): the server searches the
 * same way (`indexOf` on a lowercased haystack), so highlighting must not
 * invent matches the server would not find, and must find every occurrence
 * the user can see in a row.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `text` into matched / unmatched segments for `query` (literal, case-insensitive). */
export function splitHighlight(text: string, query: string): Array<{ s: string; hit: boolean }> {
  const q = query.trim();
  if (!q) return [{ s: text, hit: false }];
  const re = new RegExp(`(${escapeRegExp(q)})`, 'gi');
  const parts = text.split(re);
  const out: Array<{ s: string; hit: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    out.push({ s: parts[i], hit: i % 2 === 1 });
  }
  return out;
}

/** Render `text` with every occurrence of `query` wrapped in <mark>. */
export function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, query).map((p, i) =>
        p.hit ? (
          <mark key={i} className="search-hl">
            {p.s}
          </mark>
        ) : (
          <Fragment key={i}>{p.s}</Fragment>
        ),
      )}
    </>
  );
}
