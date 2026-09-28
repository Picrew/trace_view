# Trace Review v0.0.9

## 修复:库列表看不到 OpenCode / pi;应用内"切到浏览器"入口

### 修复:Provider 筛选芯片漏掉新 provider(v0.0.8 引入)

Session Library 的 provider 筛选芯片列表是写死的三个(claude-code / codex / generic),而且会话行的缩写把 OpenCode / pi 一律标成 "GX" —— v0.0.8 新增的两个 provider 在列表里**存在但不可见**。现在:

- 筛选芯片显示全部五个 provider(带各自数量、专属配色:OpenCode 蓝、pi 紫)
- 会话行缩写:CC / CX / **OC** / **PI** / GX
- 芯片列表改为动态生成 —— 以后再加 provider 永远不会被隐藏

### 新特性:应用内 "↗ Browser" 按钮

原生窗口页脚新增入口(仅 app 内显示,浏览器打开时无此按钮):点击即在**默认浏览器**打开当前视图(保留当前选中的会话深链)。菜单栏 File → Open in Browser 仍在。实现:壳注入 `window.__TRACE_REVIEW_APP__` 标记;服务端新增 `POST /api/open`(严格校验只允许打开本 server 自己的 URL)。

### 修复:app 窗口内 ⏻ Quit 按钮从未被隐藏(v0.0.7 引入)

壳注入的隐藏 CSS 之前作为**裸 CSS 字符串**传给了 WKUserScript——它只接受 JavaScript,语法错误导致静默失效。改为 JS 注入 `<style>` 后正确隐藏(退出走应用菜单 ⌘Q)。
