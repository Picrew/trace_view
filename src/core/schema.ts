/**
 * Unified Trace Schema — the single source of truth shared by all parsers and the UI.
 *
 * Design rules (see docs/trace-format-research.md):
 *  - Provider parsers (claude-code / codex / generic) normalize into these types.
 *  - Normalization NEVER drops data: every event remembers the byte location of its
 *    source line (`loc`) so the original raw JSON can be fetched on demand.
 *  - Unknown provider events become `unknown` events with `rawType` — never discarded.
 *  - Events are append-only and identified by `seq`/`id`, which stay stable for a
 *    given file revision. Live tail appends new seq values; file truncation forces
 *    a full re-parse.
 */

export type TraceProvider = 'claude-code' | 'codex' | 'generic';

/** Bump when parser output semantics change in a way consumers must know about. */
export const PARSER_VERSION = 1;

export type ToolCategory =
  | 'bash'
  | 'read'
  | 'edit'
  | 'write'
  | 'grep'
  | 'glob'
  | 'task'
  | 'web'
  | 'mcp'
  | 'other';

export type SyntheticKind =
  | 'compact-summary' // "This session is being continued from a previous conversation…"
  | 'meta' // isMeta lines, e.g. "(continuing)" / cut-off continuation nudges
  | 'continuation' // heuristic continuation injections (older Claude versions)
  | 'injected' // harness-injected context without a human origin
  | 'queue'; // queued commands replayed into the conversation

export interface EventSource {
  provider: TraceProvider;
  /** Original provider type string, e.g. "assistant" / "response_item". */
  rawType?: string;
  /** Sub-type within the provider (e.g. system subtype, payload.type). */
  rawSubtype?: string;
}

export interface EventLoc {
  /** Byte offset of the source line in the trace file. */
  offset: number;
  /** Byte length of the source line (excluding newline). */
  length: number;
}

export interface BaseEvent {
  /** Stable id within the run: `e<seq>`. */
  id: string;
  /** 0-based position in the (append-only) event stream. */
  seq: number;
  kind: TraceEventKind;
  /** ISO 8601 timestamp from the source line, when present. */
  timestamp?: string;
  /** epoch ms, convenience for the timeline. */
  timestampMs?: number;
  /** Tool duration, request span, … (estimated when source doesn't provide it). */
  durationMs?: number;
  /** Agent group: 'main' or 'agent:<…>' for sidechains / subagents. */
  agentId: string;
  /** Model request identifier (Claude: derived; Codex: turn_id). */
  turnId?: string;
  /** 0-based model request ordinal. */
  requestIndex?: number;
  model?: string;
  source: EventSource;
  /** Byte location of the originating line — used server-side to fetch raw JSON. */
  loc?: EventLoc;
  /** True when the event does not map 1:1 to a source line (derived boundaries). */
  derived?: boolean;
}

export type TraceEventKind =
  | 'user_message'
  | 'synthetic_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'error'
  | 'compaction'
  | 'file_change'
  | 'turn_boundary'
  | 'unknown';

export interface UserMessageEvent extends BaseEvent {
  kind: 'user_message';
  text: string;
  truncated?: boolean;
}

export interface SyntheticMessageEvent extends BaseEvent {
  kind: 'synthetic_message';
  text: string;
  syntheticKind: SyntheticKind;
  truncated?: boolean;
}

export interface AssistantMessageEvent extends BaseEvent {
  kind: 'assistant_message';
  text: string;
  truncated?: boolean;
  stopReason?: string;
  messageId?: string;
}

export interface ReasoningEvent extends BaseEvent {
  kind: 'reasoning';
  text: string;
  truncated?: boolean;
}

export interface ToolCallEvent extends BaseEvent {
  kind: 'tool_call';
  /** Provider-native call id (toolu_* / call_*). Links call ↔ result. */
  callId: string;
  toolName: string;
  toolCategory: ToolCategory;
  /** For MCP tools: server name extracted from mcp__<server>__<tool>. */
  mcpServer?: string;
  /** Tool input arguments as-is from the source (may be truncated for transport). */
  input?: unknown;
  /** One-line human summary, e.g. "src/service/foo.ts" or "npm test". */
  summary: string;
  truncated?: boolean;
}

export type ToolResultKind =
  | 'bash' // stdout/stderr
  | 'file-read'
  | 'edit' // structuredPatch
  | 'write' // structuredPatch
  | 'text' // plain string output
  | 'error' // error string
  | 'unknown';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk lines including +/-/space prefixes. */
  lines: string[];
}

export interface StructuredPatch {
  oldFile?: string;
  newFile?: string;
  hunks: DiffHunk[];
}

export interface ToolResultEvent extends BaseEvent {
  kind: 'tool_result';
  callId: string;
  toolName?: string;
  isError?: boolean;
  resultKind: ToolResultKind;
  /** Primary output preview (stdout, file content head, error text…). */
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  interrupted?: boolean;
  hasImage?: boolean;
  filePath?: string;
  structuredPatch?: StructuredPatch[];
  /** Line additions/deletions for edit/write results. */
  additions?: number;
  deletions?: number;
  truncated?: boolean;
}

export interface SystemEvent extends BaseEvent {
  kind: 'system';
  subtype?: string;
  text?: string;
  level?: 'info' | 'warn' | 'error';
}

export interface ErrorEvent extends BaseEvent {
  kind: 'error';
  message: string;
  truncated?: boolean;
  retryAttempt?: number;
}

export interface CompactionEvent extends BaseEvent {
  kind: 'compaction';
  text?: string;
}

export interface FileChangeEvent extends BaseEvent {
  kind: 'file_change';
  path: string;
  changeType: 'add' | 'modify' | 'delete';
  additions?: number;
  deletions?: number;
  /** Id of the tool_call event that produced this change, when known. */
  causedByEventId?: string;
}

export interface TurnBoundaryEvent extends BaseEvent {
  kind: 'turn_boundary';
  requestIndex: number;
  model?: string;
}

export interface UnknownEvent extends BaseEvent {
  kind: 'unknown';
  rawType?: string;
  /** Why it could not be classified. */
  note?: string;
}

export type TraceEvent =
  | UserMessageEvent
  | SyntheticMessageEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | SystemEvent
  | ErrorEvent
  | CompactionEvent
  | FileChangeEvent
  | TurnBoundaryEvent
  | UnknownEvent;

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from a prompt cache (claude cache_read / codex cached_input). */
  cachedInputTokens: number;
  /** Tokens written to a prompt cache (claude cache_creation / codex cache_write). */
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Number of model requests (turns). */
  modelRequests: number;
}

export interface RunStats {
  events: number;
  userMessages: number;
  syntheticMessages: number;
  assistantMessages: number;
  reasoning: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
  compactions: number;
  fileChanges: number;
  requests: number;
  /** Distinct files that appear in a change record. */
  filesChanged: number;
  /** Total Bash/shell commands executed. */
  commandsRun: number;
  byKind: Partial<Record<TraceEventKind, number>>;
  byTool: Record<string, number>;
  byToolCategory: Partial<Record<ToolCategory, number>>;
  /** Wall-clock the model was producing output (sum of request spans), ms. */
  modelTimeMs: number;
  /** Wall-clock spent inside tools (sum of call→result spans), ms. */
  toolTimeMs: number;
  agents: number;
}

export interface FileChangeSummary {
  path: string;
  changeType: 'add' | 'modify' | 'delete';
  additions: number;
  deletions: number;
  /** Events (tool_call / file_change) that touched this file. */
  eventIds: string[];
}

/** A renderable span for the timeline view. */
export interface TimelineSpan {
  id: string;
  /** Anchor event id for click-to-scroll. */
  eventId: string;
  track: 'model' | ToolCategory;
  startMs: number;
  endMs: number;
  label: string;
  spanKind: 'request' | 'tool';
  isError?: boolean;
}

export interface TraceRun {
  /** `<provider>:<sha1(filePath)>[:sessionId]` */
  id: string;
  provider: TraceProvider;
  title: string;
  /** Display name of the project/workspace (directory name). */
  project: string;
  cwd?: string;
  gitRepo?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  models: string[];
  usage: TraceUsage;
  stats: RunStats;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  mtimeMs: number;
  /** File was modified recently → likely still being written. */
  live: boolean;
  parserVersion: number;
  /** Non-fatal parse problems (bad lines, unsupported features). */
  warnings: string[];
}

/** Lightweight listing record used by the Session Library. */
export interface SessionSummary {
  id: string;
  provider: TraceProvider;
  title: string;
  project: string;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  mtimeMs: number;
  live: boolean;
  /** Present when stats were computed (after first full parse). */
  stats?: RunStats;
  usage?: TraceUsage;
  gitBranch?: string;
}

export interface ParsedRun {
  run: TraceRun;
  events: TraceEvent[];
  spans: TimelineSpan[];
  fileChanges: FileChangeSummary[];
}

/** A discovered trace source on disk. */
export interface TraceSource {
  filePath: string;
  provider: TraceProvider;
  /** For imported files: user-supplied label. */
  imported?: boolean;
}

export interface DiscoveredSession {
  source: TraceSource;
  summary: SessionSummary;
}
