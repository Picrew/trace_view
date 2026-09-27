import type { TraceProvider } from '../schema.js';
import type { TraceAdapter } from '../adapter.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GenericAdapter } from './generic.js';
import { OpencodeAdapter } from './opencode.js';
import { PiAdapter } from './pi.js';

export { ClaudeAdapter, CodexAdapter, GenericAdapter, OpencodeAdapter, PiAdapter };

const registry: Partial<Record<TraceProvider, TraceAdapter<any>>> = {
  'claude-code': new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpencodeAdapter(),
  pi: new PiAdapter(),
  generic: new GenericAdapter(),
};

export function getAdapter(id: TraceProvider): TraceAdapter<any> {
  const a = registry[id];
  if (!a) throw new Error(`Unknown adapter: ${id}`);
  return a;
}

export function allAdapters(): TraceAdapter<any>[] {
  return Object.values(registry) as TraceAdapter<any>[];
}

/** Detect which adapter fits a file, given its first parsed lines. */
export function detectAdapter(headLines: unknown[]): TraceAdapter<any> {
  // Order matters: specific providers first, generic catches the rest.
  for (const a of [registry['claude-code'], registry['codex'], registry['pi'], registry['opencode']]) {
    if (a && a.detect(headLines)) return a;
  }
  return registry.generic!;
}
