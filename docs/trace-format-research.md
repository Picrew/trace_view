# Trace Format Research

> 研究对象:本机真实 session 文件(非猜测、非二手文档)。
> - Claude Code `~/.claude/projects/**.jsonl`,CLI version **2.1.270**
> - Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,cli_version **0.148.0-alpha.9**(新格式)与 **2025-10 旧版本**(旧格式)
>
> 本文档回答需求第 29 节的全部研究问题,并作为 parser 实现的规格依据。
> 所有结论均以 `jq` 对真实文件的统计为准。

---

## 1. Claude Code JSONL 格式

文件位置:`~/.claude/projects/<cwd 转义的目录名>/<sessionId>.jsonl`,每行一个 JSON 对象(NDJSON)。同目录可能有 `memory/` 等非 trace 文件,扫描时按 `*.jsonl` 过滤。

### 1.1 实测 type 分布(8.0MB / 2313 行的真实 session)

| type | 行数 | 说明 |
|---|---|---|
| `assistant` | 812 | 模型输出流(每个 content block 一行) |
| `user` | 455 | 真实用户输入、tool_result 回填、合成消息 |
| `attachment` | 575 | 附件/上下文注入(不进对话流) |
| `last-prompt` | 137 | 记录最近一次 prompt(用于 UI 恢复,冗余) |
| `atis-latch` | 132 | 内部状态,无 timestamp,忽略 |
| `custom-title` | 63 | 会话标题,无 timestamp,忽略 |
| `mode` | 60 | 权限模式切换,无 timestamp,忽略 |
| `system` | 41 | 系统事件(api_error / compact_boundary / stop_hook_summary) |
| `queue-operation` | 38 | 用户排队消息的 enqueue/dequeue |

### 1.2 通用字段

所有 `user`/`assistant`/`system` 行都有:

```
uuid, parentUuid, sessionId, timestamp(ISO 8601), cwd, version,
gitBranch, userType, entrypoint, slug, isSidechain
```

`parentUuid` 构成完整的对话树(forest):每个 assistant 行指向其前驱(通常是上一个 assistant 行或 user 行),tool_result 行指向发起 tool_use 的 assistant 行(`parentUuid` 同时还有 `sourceToolAssistantUUID` 显式指回)。

注意:`gitBranch` 可能为 `"HEAD"`(detached)。`atis-latch`/`custom-title`/`mode`/部分 `last-prompt` 行**没有 timestamp**。

### 1.3 user 行(三种形态)

**A. 真实用户输入**(实测 15 行):`message.content` 为 string,且带:

```json
{ "origin": {"kind": "human"}, "promptSource": "sdk", "promptId": "..." }
```

v2.1.270 中**所有**真实用户输入都带 `origin.kind="human"`。

**B. tool_result 回填**(实测 431 行):`message.content` 为数组:

```json
{ "type": "tool_result", "tool_use_id": "toolu_xxx", "content": "...", "is_error": true? }
```

行级还有 `toolUseResult`(结构化结果)和 `sourceToolAssistantUUID`(指回 tool_use 所在 assistant 行)。

`toolUseResult` 按 tool 不同形态不同(实测):

| tool | toolUseResult 形态 |
|---|---|
| Bash | `{stdout, stderr, interrupted, isImage?, noOutputExpected?}` 或错误时为 string `"Error: Exit code 1\n..."` |
| Read | `{file: <path>, type: "text"}` |
| Edit | `{filePath, oldString, newString, originalFile, replaceAll, structuredPatch, userModified}` |
| Write | `{content, filePath, originalFile, structuredPatch, type, userModified}` |

`structuredPatch` 是标准 diff hunk 数组(`{oldStart, oldLines, newStart, newLines, hunks:[...]}`),直接可用于 Files Changed 页面。

**C. 合成/synthetic 消息**(识别规则,按优先级):

1. `isCompactSummary === true`(或 content 以 `"This session is being continued from a previous conversation"` 开头)→ **compact-summary**(上下文压缩续接)
2. `isMeta === true` → **meta**(实测样本:`"Your response above was cut off mid-stre..."` 即 `(continuing)` 类续写注入)
3. `isVisibleInTranscriptOnly === true` → 只进 transcript 不进模型上下文
4. `isMeta` + `turnCompanion` → turn 伴随事件
5. 无 `origin` 且非 tool_result、非以上 → **injected**(queue 注入的命令等)。旧版本(无 origin 字段)按"非 tool_result 的 string 消息默认视为真实用户输入"处理

### 1.4 assistant 行

```json
{
  "message": {
    "id": "msg_...", "model": "claude-opus-4-8", "role": "assistant",
    "content": [ { "type": "text"|"thinking"|"tool_use", ... } ],
    "usage": {...}, "stop_reason": "tool_use"|"end_turn"|"stop_sequence",
    "stop_sequence": null, "stop_details": {...}
  }
}
```

**关键:每个 assistant 行只含一个 content block**(实测 812 行 = 250 text + 135 thinking + 431 tool_use,另有少量容器行)。同一个 API response 的多个 block 通过 `parentUuid` 链式相连。

- `tool_use` block:`{id: "toolu_xxx", name: "Bash"|"Read"|"Edit"|"Grep"|"mcp__server__tool", input: {...}}`
- `thinking` block:`{thinking: "...", signature: "..."}`
- `usage`:`{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, output_tokens_details: {thinking_tokens}, ...}`。同一 response 的多行 assistant 重复携带同一 usage(按 messageId/message.id 去重汇总)
- **没有 `requestId` 字段**(v2.1.270 实测),request boundary 需推导(见 §1.6)
- API 出错时该行有 `isApiErrorMessage: true` + 顶层 `error` 对象

### 1.5 system / attachment 行

`system` 的 `subtype`:

| subtype | 字段 | 语义 |
|---|---|---|
| `api_error` | `error`, `retryAttempt`, `maxRetries`, `retryInMs`, `source` | API 失败与重试 |
| `compact_boundary` | `compactMetadata`, `logicalParentUuid` | 上下文压缩边界 |
| `stop_hook_summary` | `hookCount`, `hookErrors`, `preventedContinuation`, `stopReason` | Stop hook 结果 |

`attachment` 的 `attachment.type`:`total_tokens_reminder`(433)、`file`、`environment`、`prompt_snapshot`、`session_context`、`model`、`mcp_instructions_delta`、`instructions`。不进对话主流,MVP 归入 SystemEvent 低权重展示。

### 1.6 Model Request Boundary 推导(无 requestId 时)

规则:**assistant 行的 parentUuid 指向 user 行 ⇒ 该 assistant 行开始一个新的 model request**;parentUuid 指向 assistant 行 ⇒ 同一 request 的后续 block。一个 request = 连续的 assistant 链(直到 stop_reason 非 tool_use)。

```text
user(origin human)          ─┐
assistant thinking           │ Request #1
assistant text               │
assistant tool_use(Read)    ─┘
user(tool_result Read)      ─┐
assistant tool_use(Bash)     │ Request #2
assistant tool_use(Edit)     │
user(tool_result Bash)       │ ...
```

### 1.7 Subagent / Sidechain

本机 2.1.270 数据中**没有** `isSidechain=true` 的行(Task tool 未使用),但字段存在于 schema 中。Parser 规则:`isSidechain=true` 的行归入独立 agent 分组(`agentId=sidechain:<parentTaskUuid>`),主链为 `agentId=main`。Codex 的 collaboration 见 §2.7。

### 1.8 会话级元数据

无 header 行,元数据从首行/各行累积:cwd、gitBranch、version、slug、first user message(标题)、custom-title(若有)、timestamp 范围、model 集合、usage 总和(按 messageId 去重)。

---

## 2. Codex rollout JSONL 格式

文件:`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl`(归档在 `~/.codex/archived_sessions/`)。

### 2.1 行结构(所有行统一)

```json
{ "timestamp": "ISO8601", "ordinal": 123, "type": "...", "payload": {...} }
```

`ordinal` 单调递增,天然的顺序/关联键。**每行都有 timestamp。**

top-level `type` 实测:`response_item`(484)、`event_msg`(430)、`turn_context`(7)、`world_state`(2)、`session_meta`(1)、`compacted`(1)。

### 2.2 session_meta(首行)

```json
{ "id": "<session uuid>", "timestamp": "...", "cwd": "...",
  "originator": "Codex Desktop"|"codex-cli rs", "cli_version": "0.148.0-alpha.9",
  "instructions": "...?", "git": {"commit_hash", "branch", "repository_url"} }
```

### 2.3 turn_context —— 请求边界与模型信息

```json
{ "cwd": "...", "model": "gpt-5.6-sol", "effort": "high", "summary": "auto",
  "turn_id": "01a04688-3245-...", "approval_policy": "...", "sandbox_policy": {...},
  "collaboration_mode": "...", "multi_agent_version": "...", ... }
```

**每个 model request 前出现一条 turn_context,`turn_id` 就是 request 边界标识。**这是 Codex 比 Claude 更好处理的地方。

### 2.4 response_item —— 对话主数据(权威源)

`payload.type` 新旧版本对比:

| payload.type | 版本 | 结构 |
|---|---|---|
| `message` | 两版 | `{role: user|assistant, content: [{type: input_text|output_text, text}], id: "msg_..."}` |
| `reasoning` | 两版 | `{summary: [{type: summary_text, text}], content?, encrypted_content?, id}` |
| `function_call` | 旧版 | `{name: "shell", arguments: "<json string>", call_id: "call_xxx"}` |
| `function_call_output` | 旧版 | `{call_id, output: "<string>"}` |
| `local_shell_call` | 旧版 | `{action: {type: "exec", command: [...]}, call_id}` |
| `custom_tool_call` | 0.148 新版 | `{name: "exec", input: "<JS code string>", call_id: "call_xxx"}` |
| `custom_tool_call_output` | 0.148 新版 | `{call_id, output: "<JSON array of content blocks>"}` |

新版把 shell 统一成 `exec` custom tool,input 是 JS 代码(`await tools.exec_command({"cmd": ...})`),真实命令需从字符串中提取(尽力而为的 display summary)。旧版 `function_call(name="shell")` 的 `arguments` 是 JSON 字符串,需二次 parse。

**call_id ↔ call_id** 是 tool_call ↔ tool_result 的关联键。

### 2.5 event_msg —— UI/遥测事件(增量流)

`payload.type` 实测:`item_completed`(267)、`token_count`(146)、`task_started`/`task_complete`、`thread_settings_applied`。

- `token_count`:`{info: {total_token_usage(累计), last_token_usage(本次 request), model_context_window}, rate_limits: {...}}`。**token 用量在这里,不在 message 上。**`last_token_usage` 有 `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`。
- `item_completed.payload.item.type`:`AgentMessage`、`UserMessage`、`Reasoning`、`McpToolCall`、`FileChange`、`WebSearch`、`ContextCompaction`。这是 UI 层事件,**与 response_item 内容重复**(tool call 既有 response_item 又有 item_completed),parser 以 response_item 为权威,item_completed 仅取补充信息:
  - `FileChange`: `{changes: {"<abs path>": {type: "add"|"modify", content}}}` —— 直接给出文件变更,无需重放 diff
  - `WebSearch` / `McpToolCall`:给 tool call 补充分类信息

### 2.6 compacted

`{message: "", replacement_history: [完整替换后的 message 数组]}` —— 压缩边界,转换为 CompactionEvent。

### 2.7 Subagent / collaboration

turn_context 中有 `collaboration_mode`、`multi_agent_version` 字段;子 agent 的 rollout 文件是独立 session 文件(独立 session id),主 agent 通过工具调用spawn。MVP:不自动拼树,以 `collaboration_mode` 存在与否 + 工具名(spawn/collab 类)做标记;V2 再做跨文件 lineage 拼接。

### 2.8 world_state

`{full: bool, state: {...}}`,运行时世界状态快照,MVP 忽略(进 Unknown 保留 raw)。

---

## 3. 映射到 Unified Trace Schema

| 统一 Event | Claude Code 来源 | Codex 来源 |
|---|---|---|
| UserMessage | user + origin.kind=human | response_item message(role=user, 首条非注入) |
| SyntheticMessage | user(isMeta/isCompactSummary/无 origin 非 tool_result) | compacted 替换、注入的 system-reminder |
| AssistantMessage | assistant(content[].type=text) | response_item message(role=assistant) |
| Reasoning | assistant(content[].type=thinking) | response_item reasoning |
| ToolCall | assistant(content[].type=tool_use) | function_call / custom_tool_call / local_shell_call |
| ToolResult | user(content[].type=tool_result) | function_call_output / custom_tool_call_output |
| SystemEvent | system(subtype≠api_error)、attachment | event_msg(task_*/thread_settings)、world_state |
| ErrorEvent | system(subtype=api_error)、assistant(isApiErrorMessage) | API error 事件 |
| CompactionEvent | system(compact_boundary)、user(isCompactSummary) | compacted |
| FileChange | toolUseResult.structuredPatch(Edit/Write) | event_msg item_completed(FileChange) |
| TurnBoundary | 推导(assistant parent=user) | turn_context(turn_id) |
| Unknown | 未识别 type | 未识别 payload.type |

**Tool 关联 ID**:Claude `tool_use.id ↔ tool_result.tool_use_id`(还有 sourceToolAssistantUUID 兜底);Codex `call_id ↔ call_id`。

**Token**:Claude 按 `message.id` 去重累加 usage;Codex 取 token_count 的 `total_token_usage`(末值)为准、`last_token_usage` 归到对应 request。

**Timestamp**:两边每条对话行都有;Claude 的 last-prompt/atis-latch/custom-title/mode 行没有 → 不生成 timeline event,仅提取元数据(custom-title → 会话标题)。

**Duration**:tool duration = result.timestamp − call.timestamp;model span = request 首 assistant 行 → 末 assistant 行;无法得到精确 API 延迟,标注为估算。

## 4. 异常与鲁棒性策略(parser 必须处理)

1. **截断/损坏行**:JSONL 最后一行可能写一半 → 逐行 try-parse,坏行转 UnknownEvent(带 rawText 摘要),不中断。
2. **文件被 rotate/重写**(truncate):live tail 时检测 size 回退 → 触发全量重解析事件。
3. **版本演化**:parser 按"识别-忽略"策略,未知字段全部保留在 `raw`;未知 type 进 Unknown,永不丢弃(需求 §24)。schema 加 `parserVersion` 字段。
4. **超长内容**:stdout/文件内容可能上 MB → API 层截断预览 + 完整内容按需拉取。
5. **Claude 旧版本**(无 origin/isMeta 字段):回退为内容启发式(continuation 前缀、`<system-reminder>` 包裹等)。

## 5. Generic adapter

手动导入的 `.jsonl`/`.ndjson`:逐行 parse,按启发式猜字段(`type`/`role`/`content`/`message`/`timestamp`),识别不了的整行进 UnknownEvent 但保留 raw。`.json`(单个对象或数组)同理。`.jsonl.zst` 暂不支持(MVP),UI 提示。

## 6. 结论:关键技术决策

- **权威数据源**:Claude 用 user/assistant/system 行;Codex 用 response_item + turn_context + token_count,忽略 event_msg 的重复流(仅取 FileChange/WebSearch 补充)。
- **Request boundary**:Claude 推导(parent 链),Codex 直读(turn_id)。
- **Live tail**:两边都是 append-only NDJSON → `fs.watch` + 增量 readline(offset 游标),Claude 的非 timestamp 行(atis-latch 等)在 tail 时同样跳过。
- **性能**:50MB 文件 ≈ 3k 行(Codex)或 ~15k 行(Claude)→ 一次性 parse 进内存完全可行;瓶颈在 UI 渲染 → 虚拟滚动 + 懒加载 tool result。
