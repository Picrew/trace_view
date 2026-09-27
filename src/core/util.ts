import { createHash } from 'node:crypto';
import type { StructuredPatch, ToolCategory, ToolResultKind } from './schema.js';

/** Classify a provider tool name into a UI track/filter category. */
export function classifyTool(toolName: string): { category: ToolCategory; mcpServer?: string } {
  const n = toolName;
  if (n === 'Bash' || n === 'bash' || n === 'shell' || n === 'exec' || n === 'terminal' || n === 'PowerShell') {
    return { category: 'bash' };
  }
  if (n === 'Read' || n === 'read' || n === 'view' || n === 'open' || n === 'cat') return { category: 'read' };
  if (n === 'Edit' || n === 'edit' || n === 'edit_file' || n === 'apply_patch' || n === 'str_replace_editor') {
    return { category: 'edit' };
  }
  if (n === 'Write' || n === 'write' || n === 'write_file' || n === 'create_file') return { category: 'write' };
  if (n === 'Grep' || n === 'grep' || n === 'search') return { category: 'grep' };
  if (n === 'Glob' || n === 'glob' || n === 'list_files' || n === 'ls') return { category: 'glob' };
  if (n === 'Task' || n === 'task' || n === 'Agent' || n === 'spawn' || n === 'agent') return { category: 'task' };
  if (n === 'WebSearch' || n === 'websearch' || n === 'WebFetch' || n === 'webfetch' || n === 'web_search' || n === 'fetch') {
    return { category: 'web' };
  }
  if (n.startsWith('mcp__')) {
    const parts = n.split('__'); // mcp__<server>__<tool>
    return { category: 'mcp', mcpServer: parts[1] ?? n.slice(5) };
  }
  return { category: 'other' };
}

/** Build a one-line summary for a tool call from its arguments. */
export function toolSummary(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return toolName;
  if (typeof input !== 'object') return `${toolName} ${truncate(String(input), 200)}`;
  const obj = input as Record<string, unknown>;
  const preferred: Record<string, string[]> = {
    Read: ['file_path', 'filePath', 'path'],
    Write: ['file_path', 'filePath', 'path'],
    Edit: ['file_path', 'filePath', 'path'],
    Glob: ['pattern', 'path'],
    Grep: ['pattern', 'path'],
    Bash: ['command', 'cmd', 'script'],
    shell: ['command'],
    exec: ['cmd', 'command'],
    Task: ['description', 'prompt', 'subagent_type'],
    WebFetch: ['url'],
    WebSearch: ['query'],
    TodoWrite: ['todos'],
  };
  const keys = preferred[toolName] ?? ['file_path', 'filePath', 'path', 'command', 'cmd', 'url', 'query', 'pattern', 'name', 'description'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      const s = v.replace(/\s+/g, ' ').trim();
      return truncate(s, 300).text;
    }
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return truncate(v.join(' '), 300).text;
    }
  }
  const firstStr = Object.entries(obj).find(([, v]) => typeof v === 'string' && (v as string).length > 0);
  if (firstStr) return truncate(String(firstStr[1]).replace(/\s+/g, ' ').trim(), 300).text;
  const firstKey = Object.keys(obj)[0];
  return firstKey ? `${toolName} ${firstKey}` : toolName;
}

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** Safe-ish single-line squeeze for summaries. */
export function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    modelRequests: 0,
  };
}

export function emptyStats(): import('./schema.js').RunStats {
  return {
    events: 0,
    userMessages: 0,
    syntheticMessages: 0,
    assistantMessages: 0,
    reasoning: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
    compactions: 0,
    fileChanges: 0,
    requests: 0,
    filesChanged: 0,
    commandsRun: 0,
    byKind: {},
    byTool: {},
    byToolCategory: {},
    modelTimeMs: 0,
    toolTimeMs: 0,
    agents: 1,
  };
}

export function parseTimestampMs(ts: string | undefined | null): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

export function runIdFor(provider: string, filePath: string, sessionId?: string): string {
  const h = createHash('sha1').update(filePath).digest('hex').slice(0, 12);
  return sessionId ? `${provider}:${sessionId}:${h}` : `${provider}:${h}`;
}

/** Short provider-independent label for an agent id. */
export function agentLabel(agentId: string): string {
  if (agentId === 'main') return 'Main';
  if (agentId.startsWith('agent:')) return agentId.slice(6);
  return agentId;
}

/** Categorize a tool result shape (best effort, provider-agnostic). */
export function resultKindFor(toolName: string | undefined, result: unknown): ToolResultKind {
  if (typeof result === 'string') return result.startsWith('Error') ? 'error' : 'text';
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return 'bash';
    if (Array.isArray(r.structuredPatch)) return toolName === 'Write' ? 'write' : 'edit';
    if (typeof r.filePath === 'string' || typeof r.file === 'string') return 'file-read';
  }
  return 'unknown';
}

/** Count +/- lines in diff hunk lines. */
export function countPatchLines(hunks: { lines: string[] }[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff string (e.g. opencode's `state.metadata.diff`) into
 * StructuredPatch[] — one per file. Accepts `Index:`/`===` separators and
 * tolerates missing `---`/`+++` headers.
 */
export function parseUnifiedDiff(text: string): StructuredPatch[] {
  const patches: StructuredPatch[] = [];
  let cur: { oldFile?: string; newFile?: string; hunks: StructuredPatch['hunks'] } | null = null;
  let hunk: StructuredPatch['hunks'][number] | null = null;

  const flushHunk = () => {
    if (cur && hunk) cur.hunks.push(hunk);
    hunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur && cur.hunks.length > 0) patches.push(cur);
    cur = null;
  };

  const rawLines = text.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop(); // trailing newline
  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('--- ')) {
      const oldFile = line.slice(4).split('\t')[0].trim();
      flushFile();
      cur = { oldFile: oldFile === '/dev/null' ? undefined : oldFile, hunks: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur) cur.newFile = line.slice(4).split('\t')[0].trim();
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      flushHunk();
      if (!cur) cur = { hunks: [] };
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
      continue;
    }
    if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
      hunk.lines.push(line);
    }
  }
  flushFile();
  return patches;
}
