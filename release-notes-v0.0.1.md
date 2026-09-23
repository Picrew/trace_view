# Trace Review v0.0.1 — First Release

本地优先的 **Agent Run Inspector**:查看、搜索、调试和 review Coding Agent 的完整运行轨迹。不是聊天记录查看器 —— 它准确呈现 Agent "实际上是怎么运行的"。

## 安装(macOS Apple Silicon)

下载 `Trace-Review-0.0.1-arm64.dmg`,把 **Trace Review.app** 拖入 Applications。

- 自包含 Node 运行时(单文件二进制),**无需安装任何依赖**
- 首次打开若被 Gatekeeper 拦截(ad-hoc 签名):右键 → 打开,或执行
  `xattr -d com.apple.quarantine "/Applications/Trace Review.app"`
- 双击启动后自动打开浏览器(http://127.0.0.1:7860),自动发现本地会话
- 完全本地运行,无 telemetry、无上传

其他平台 / 从源码:`npm install && npm run build && npm start`(Node ≥ 20.11)。

## 功能

- **Providers**:Claude Code(`~/.claude/projects`,CLI 2.1.x 实测格式)、Codex CLI(`~/.codex/sessions`,v0 / v1 / 0.148 三代格式)、通用 `.jsonl` 手动导入
- **Session Library**:自动扫描(实测 900+ 会话)、provider 过滤、日期分组、live 会话标记
- **Trajectory**:虚拟滚动轨迹视图 —— user / assistant / reasoning / tool call+result / system / error / compaction / unknown,连续工具调用自动聚合,工具行可展开(参数 / stdout / stderr / diff)
- **Request Boundaries**:每个 model request 一条分隔线(模型 + 耗时),看清一个 run 被拆成多少次真实请求
- **Synthetic 识别**:`(continuing)`、compact-summary、isMeta、injected 全部标出 —— 研究 harness 行为的关键
- **Timeline**:Canvas 多 track(Model / Bash / Read / Edit / MCP…),zoom / pan / hover / 点击跳转
- **Inspector**:点击任意事件 → 元数据、工具详情、按需加载的原始 JSON(可折叠树)
- **Search / Filters**:服务端全文搜索 + 14 个过滤 chip
- **Files Changed**:文件变更列表(±行数),点击跳回产生修改的 trace event
- **Live Tail**:正在运行的会话实时追加(SSE),truncate/rotate 自动重载
- **Security**:trace 内容视为不可信输入 —— escape-first Markdown、scheme 受限链接、React-only JSON 渲染、路径穿越防护、仅绑定 127.0.0.1

## 性能(实测)

| 指标 | 值 |
|---|---|
| 437MB trace 冷打开 | 1.9s |
| 热打开 | 10ms |
| 搜索 | 2ms |
| 单元 + UI + live-tail 测试 | 33/33 |
| 真实浏览器 e2e(含打包产物) | 9/9 |

SHA256 校验文件见附件 `.dmg.sha256`。
