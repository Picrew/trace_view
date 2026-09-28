# Trace Review v0.0.8

## 新特性:OpenCode 与 pi 轨迹支持

新增两个 provider,现在可以直接查看五种 Agent 的本地轨迹:

- **OpenCode**(`~/.local/share/opencode/storage`):三层 JSON 存储(session / message / part)自动聚合成单一轨迹。工具调用+结果、reasoning、token 用量(step-finish)、edit/write 的 unified diff(→ Files Changed ±行数)、每 step 的 patch 文件清单、子代理会话(parentID 标注)全部支持
- **pi**(`~/.pi/agent/sessions`):text / thinking / toolCall 内容块,toolResult 真实时间戳(工具时长准确),每条 assistant 消息的 token 用量,compaction 摘要,错误请求(如 504)呈现为 error 事件

**实现要点**:

- OpenCode 的多文件会话通过**投影器**(`src/core/opencode-projector.ts`)折叠成确定性虚拟 JSONL,现有解析/缓存/搜索/live tail 管线零改动复用;raw JSON 从虚拟流切片
- OpenCode 存储不含 part 级时间戳 → 在消息时间区间内插值(单工具时长无意义,run warnings 注明);pi 时间戳真实
- OpenCode live tail:session 元数据 mtime 变化 → 全量重投影 + 客户端 reset
- run 现在会展示 adapter notes(provider 版本、subagent lineage、collaboration mode 等)

**已知限制**:OpenCode 会话缓存按 session 元数据文件的 stat 失效,极端情况下(消息更新但元数据未重写)库列表可能滞后一次刷新;强制退出壳进程会留孤儿 server(与 v0.0.7 相同)。

**验证**:本机 20 个 OpenCode 会话 + 全量 pi 会话实测解析,聚合数字与存储层清点一致(434 step-start / 465 tool / 277 reasoning / 163 file change);44/44 测试。
