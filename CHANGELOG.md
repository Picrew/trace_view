# Changelog

All notable changes to Trace Review. 每个版本的完整发布说明见 [`docs/releases/`](docs/releases/)。

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/);`0.0.x` 阶段属于早期开发,接口与存储格式可能变动。

## [0.0.9] — 2026-09-28

### Fixed
- Session Library 的 provider 筛选芯片写死为三个,v0.0.8 新增的 OpenCode / pi 在列表里存在但不可见;芯片改为动态生成,会话行缩写补齐 `OC` / `PI`。
- 原生窗口内的 ⏻ Quit 按钮从未被隐藏(v0.0.7 引入):隐藏样式曾以裸 CSS 字符串传给 `WKUserScript`,该 API 只接受 JavaScript,语法错误导致静默失效。

### Added
- 原生窗口页脚 "↗ Browser" 按钮:在默认浏览器打开当前视图并保留会话深链。新增 `POST /api/open`,严格校验只允许打开本 server 自己的 URL。

[详情 →](docs/releases/v0.0.9.md)

## [0.0.8] — 2026-09-28

### Added
- **OpenCode provider**(`~/.local/share/opencode/storage`):session / message / part 三层 JSON 存储经投影器折叠成确定性虚拟 JSONL,现有解析 / 缓存 / 搜索 / live tail 管线零改动复用。
- **pi provider**(`~/.pi/agent/sessions`):text / thinking / toolCall 内容块、toolResult 真实时间戳、每条消息 token 用量、compaction 摘要、错误请求呈现为 error 事件。
- Run 视图展示 adapter notes(provider 版本、subagent lineage、collaboration mode)。

[详情 →](docs/releases/v0.0.8.md)

## [0.0.7] — 2026-09-28

### Added
- **macOS 原生应用窗口**:`src/shell/main.swift`(AppKit + WKWebView,~120KB)取代"后台启动器 + 浏览器页面",带 Dock 图标、菜单栏与窗口位置记忆;server 仍是自包含 Node SEA 单文件,零依赖不变。
- File → Open in Browser(⌘B);⌘Q 停掉由应用启动的 server(终端自起的 server 不受影响);server 进程崩溃时弹出重启对话框;日志落盘 `~/Library/Logs/Trace Review/server.log`。

[详情 →](docs/releases/v0.0.7.md)

## [0.0.6] — 2026-09-24

### Fixed
- 点击 Edit / Write 工具行导致整个 run 视图白屏:新版 Claude Code 的 `structuredPatch` 改为裸 hunk 数组(无 `hunks` 包装),`p.hunks.map` 抛 TypeError 卸载整棵组件树。解析器归一化两种格式,PatchView 增加防御。**v0.0.5 的 DMG 受此影响,请使用 v0.0.6。**

[详情 →](docs/releases/v0.0.6.md)

## [0.0.5] — 2026-09-24

### Fixed
- Dock 图标持续弹跳(无窗口后台服务被 macOS 视为"永远在启动中"):改用 `LSUIElement`。
- 图标白框:qlmanage 渲染 SVG 会把透明区域填成不透明白色,改用 headless Chrome 渲染真透明背景。
- 单实例:已运行时再次打开 app 只打开浏览器,不再启动第二个实例。

[详情 →](docs/releases/v0.0.5.md)

## [0.0.4] — 2026-09-24

### Fixed
- 带图片的用户消息被误判为 synthetic:content 为 `[text, image]` 数组时落入兜底分支。数组内容与纯文本现走同一套判定链,带图消息显示 🖼 标记。实测受影响会话从 6 user / 10 synthetic 修正为 11 user / 5 synthetic。

[详情 →](docs/releases/v0.0.4.md)

## [0.0.3] — 2026-09-24

### Fixed
- 图标不符合 macOS 网格规范(画满 1024×1024,应为 824×824 居中),视觉上比系统 app 大一截。
- Retina 屏图标发虚:iconset 的 `@2x` 位图此前直接复制 1x 图,现从 1024px 源图生成全部 10 个真实尺寸。

[详情 →](docs/releases/v0.0.3.md)

## [0.0.2] — 2026-09-23

### Fixed
- Live 会话视口跳动,两个根因:浏览器 scroll anchoring 与虚拟滚动冲突(禁用 `overflow-anchor`);auto-follow 过于激进(SSE batch 300ms 节流 + 显式 follow 状态与 "↓ Follow live" 按钮)。

### Changed
- 图标重做:深色 squircle + 三条 timeline lane 上的渐变上升轨迹。

[详情 →](docs/releases/v0.0.2.md)

## [0.0.1] — 2026-09-23

首个发布。自包含 macOS `.app` + DMG(Node SEA 单文件,无需安装依赖)。

### Added
- Providers:Claude Code、Codex CLI(v0 / v1 / 0.148 三代格式)、通用 `.jsonl` 手动导入。
- Session Library、Trajectory(虚拟滚动)、Request Boundaries、synthetic 识别、Canvas Timeline、Inspector、服务端全文搜索 + 14 个过滤 chip、Files Changed、Live Tail(SSE)。
- 安全基线:trace 内容视为不可信输入 — escape-first Markdown、scheme 受限链接、React-only JSON 渲染、路径穿越防护、仅绑定 `127.0.0.1`。

[详情 →](docs/releases/v0.0.1.md)

[0.0.9]: https://github.com/Picrew/trace_view/releases/tag/v0.0.9
[0.0.8]: https://github.com/Picrew/trace_view/releases/tag/v0.0.8
[0.0.7]: https://github.com/Picrew/trace_view/releases/tag/v0.0.7
[0.0.6]: https://github.com/Picrew/trace_view/releases/tag/v0.0.6
[0.0.5]: https://github.com/Picrew/trace_view/releases/tag/v0.0.5
[0.0.4]: https://github.com/Picrew/trace_view/releases/tag/v0.0.4
[0.0.3]: https://github.com/Picrew/trace_view/releases/tag/v0.0.3
[0.0.2]: https://github.com/Picrew/trace_view/releases/tag/v0.0.2
[0.0.1]: https://github.com/Picrew/trace_view/releases/tag/v0.0.1
