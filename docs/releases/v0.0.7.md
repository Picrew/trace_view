# Trace Review v0.0.7

## 新特性:原生 Mac 应用窗口

`Trace Review.app` 不再是"后台启动器 + 浏览器页面",而是一个真正的原生应用:

- **原生窗口**:双击 .app 直接打开 AppKit 窗口(WKWebView 渲染,与 Safari 同引擎),有 Dock 图标、菜单栏、窗口位置记忆
- **零依赖不变**:窗口壳只有 ~120KB Swift,服务端仍是自包含 Node SEA 单文件二进制,无需安装 Node
- **应用与网页并存**:server 照旧只绑定 `127.0.0.1:7860`,应用运行期间任意浏览器访问同一地址即可,两边看到的是同一个 server
- **File → Open in Browser**(⌘B):一键把当前界面切到默认浏览器打开
- **⌘Q 退出应用**会停掉由它启动的 server;如果 server 是你自己在终端起的(`npm start` 等),应用退出不会动它
- 应用窗口内隐藏网页页脚的 ⏻ 按钮(退出走应用菜单);浏览器里打开时按钮保留
- 外部链接自动转交默认浏览器,不会把应用窗口导航走
- 服务进程崩溃/被停时弹出对话框,可选择一键重启
- server 日志落盘:`~/Library/Logs/Trace Review/server.log`

**实现**:`src/shell/main.swift`(AppKit + WKWebView 壳,swiftc 直接编译),打包脚本新增 step 5;bundle 布局改为 `MacOS/TraceReview`(壳)+ `Resources/trace-review`(服务)+ `Resources/web`(前端产物)。

**已知限制**:强制退出(Force Quit)壳进程会留下孤儿 server(下次启动会自动复用;可在浏览器页脚点 ⏻ 或 `pkill -f trace-review` 清掉)。
