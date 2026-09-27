//
//  main.swift
//  Trace Review — native macOS shell
//
//  A thin AppKit + WKWebView window around the trace-review server (bundled
//  as a self-contained Node SEA binary at Contents/Resources/trace-review).
//  The server still binds 127.0.0.1:7860, so the same UI stays reachable
//  from any browser while the app runs (File → Open in Browser).
//
//  Built by scripts/package-macos.sh:
//    swiftc -O -o TraceReview src/shell/main.swift
//
//  Dev override: TRACE_REVIEW_BIN=<path> points the shell at another server
//  binary instead of the bundled one (for testing without a .app bundle).
//

import AppKit
@preconcurrency import WebKit

// MARK: - Constants

private let kPort: UInt16 = 7860
private let kBaseURL = URL(string: "http://127.0.0.1:\(kPort)")!
private let kHealthURL = URL(string: "http://127.0.0.1:\(kPort)/api/health")!
private let kHealthPollInterval: TimeInterval = 0.25
private let kHealthDeadline: TimeInterval = 20

private func sidecarURL() -> URL? {
    if let override = ProcessInfo.processInfo.environment["TRACE_REVIEW_BIN"] {
        return URL(fileURLWithPath: override)
    }
    return Bundle.main.resourceURL?.appendingPathComponent("trace-review")
}

/// WKWebView sometimes rejects `navigator.clipboard.writeText` (no user-gesture
/// attribution across the embedding boundary). Fall back to a hidden-textarea
/// execCommand copy, which WKWebView honors on user interaction.
private let clipboardFallbackJS = """
(function () {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    return orig(text).catch(function () {
      var ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      } finally {
        ta.remove();
      }
    });
  };
})();
"""

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadingView: NSView?
    private var loadingLabel: NSTextField?

    /// The server process this shell spawned (nil when reusing an external
    /// one, e.g. started via `npm start` — we never kill those).
    private var server: Process?
    /// Set while quitting / deliberately stopping so terminationHandler
    /// doesn't bring up the "server stopped" dialog.
    private var intentionalStop = false
    /// Bumped whenever a startup/restart attempt is superseded (server died,
    /// start failed, another attempt started); pending health-poll callbacks
    /// compare against it before acting.
    private var session = 0

    // MARK: NSApplicationDelegate

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        makeWindow()
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // SIGTERM only the server we spawned; cli.ts shuts down gracefully.
        // An external server (npm start / another binary) keeps running —
        // a browser tab might be using it.
        if let p = server {
            intentionalStop = true
            session += 1
            p.terminate()
        }
        return .terminateNow
    }

    // MARK: Startup

    private func start() {
        session += 1
        setStatus("Checking for a running server…")
        probeHealth { [weak self] up in
            DispatchQueue.main.async {
                guard let self else { return }
                if up {
                    self.server = nil // reuse the already-running server
                    self.loadUI(reload: false)
                    return
                }
                self.setStatus("Starting local server…")
                if self.spawnServer() {
                    self.awaitHealth(
                        onReady: { self.loadUI(reload: false) },
                        onTimeout: { self.startFailed("Server did not become ready in time.") })
                }
                // spawnServer() shows its own dialog on failure
            }
        }
    }

    private func spawnServer() -> Bool {
        guard let bin = sidecarURL() else {
            startFailedDialog("Server binary not found (Contents/Resources/trace-review).")
            return false
        }
        guard FileManager.default.isExecutableFile(atPath: bin.path) else {
            startFailedDialog("Server binary is not executable: \(bin.path)")
            return false
        }
        let p = Process()
        p.executableURL = bin
        p.arguments = ["--port", String(kPort), "--no-open"]
        if let log = openServerLog() {
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] exited in
            DispatchQueue.main.async { self?.serverDidExit(exited) }
        }
        do {
            try p.run()
        } catch {
            startFailedDialog("Could not launch the server process: \(error.localizedDescription)")
            return false
        }
        server = p
        return true
    }

    /// The server process we own exited while the app is running — either it
    /// crashed or the user stopped it (e.g. the web UI's power button from a
    /// browser tab). Offer restart.
    private func serverDidExit(_ exited: Process) {
        guard exited === server, !intentionalStop else { return }
        server = nil
        session += 1 // cancel any pending health polling

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Local server stopped"
        alert.informativeText = """
            The trace-review server exited (status \(exited.terminationStatus)).
            Log: ~/Library/Logs/Trace Review/server.log

            Restart the server, or quit the app?
            """
        alert.addButton(withTitle: "Restart")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            restart()
        } else {
            NSApp.terminate(nil)
        }
    }

    private func restart() {
        session += 1
        setStatus("Restarting local server…")
        if spawnServer() {
            awaitHealth(
                onReady: { self.loadUI(reload: true) },
                onTimeout: { self.startFailed("Server did not become ready in time.") })
        }
    }

    private func startFailed(_ reason: String) {
        session += 1
        // Stop a half-started server so a retry begins from a clean slate.
        // Clearing `server` first makes its terminationHandler a no-op.
        if let p = server {
            server = nil
            p.terminate()
        }
        startFailedDialog(reason)
    }

    private func startFailedDialog(_ reason: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Could not start trace-review"
        alert.informativeText = """
            \(reason)

            Port \(kPort) may be in use by another program, or the server hit an error.
            Log: ~/Library/Logs/Trace Review/server.log
            """
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            start()
        } else {
            NSApp.terminate(nil)
        }
    }

    // MARK: Health checks

    private func probeHealth(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: kHealthURL)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
                && data.flatMap { String(data: $0, encoding: .utf8) }?.contains("trace-review") == true
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private func awaitHealth(onReady: @escaping () -> Void, onTimeout: @escaping () -> Void) {
        let s = session
        let deadline = Date().addingTimeInterval(kHealthDeadline)
        func step() {
            probeHealth { [weak self] up in
                guard let self, self.session == s else { return } // superseded attempt
                if up { onReady(); return }
                if Date() > deadline { onTimeout(); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + kHealthPollInterval) { step() }
            }
        }
        step()
    }

    // MARK: Server log

    private func openServerLog() -> FileHandle? {
        let fm = FileManager.default
        guard let logs = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
        let dir = logs.appendingPathComponent("Logs/Trace Review", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("server.log")
        if !fm.fileExists(atPath: file.path) {
            fm.createFile(atPath: file.path, contents: nil)
        }
        guard let fh = try? FileHandle(forWritingTo: file) else { return nil }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: Data("\n---- \(Date()) — shell launched ----\n".utf8))
        return fh
    }

    // MARK: Window / web view

    private func loadUI(reload: Bool) {
        guard let wv = webView else { return }
        loadingView?.removeFromSuperview()
        loadingView = nil
        loadingLabel = nil
        if reload, wv.url != nil {
            wv.reload()
        } else {
            wv.load(URLRequest(url: kBaseURL))
        }
        window?.makeKeyAndOrderFront(nil)
    }

    /// Show (or update) the dark splash overlay with a status line.
    private func setStatus(_ text: String) {
        if loadingView == nil, let content = window?.contentView {
            let v = makeOverlay()
            v.frame = content.bounds
            content.addSubview(v)
            loadingView = v
            loadingLabel = v.subviews.compactMap { $0 as? NSTextField }.first
        }
        loadingLabel?.stringValue = text
    }

    private func makeOverlay() -> NSView {
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        v.autoresizingMask = [.width, .height]
        v.wantsLayer = true
        v.layer?.backgroundColor = NSColor(srgbRed: 11 / 255, green: 14 / 255, blue: 22 / 255, alpha: 1).cgColor

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)

        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = NSColor(white: 0.78, alpha: 1)
        label.translatesAutoresizingMaskIntoConstraints = false

        v.addSubview(spinner)
        v.addSubview(label)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            spinner.bottomAnchor.constraint(equalTo: v.centerYAnchor, constant: 24),
            label.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            label.topAnchor.constraint(equalTo: v.centerYAnchor, constant: 24),
        ])
        return v
    }

    private func makeWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 840))

        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        // In the app, quitting lives in the application menu — hide the web
        // UI's power button (browser tabs keep it).
        ucc.addUserScript(WKUserScript(
            source: ".quit-btn{display:none!important}",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(
            source: clipboardFallbackJS,
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController = ucc

        let wv = WKWebView(frame: content.bounds, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.allowsMagnification = true
        content.addSubview(wv)
        webView = wv

        let w = NSWindow(contentRect: content.frame,
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Trace Review"
        w.minSize = NSSize(width: 960, height: 600)
        if !w.setFrameUsingName("TraceReviewMainWindow") { w.center() }
        _ = w.setFrameAutosaveName("TraceReviewMainWindow")
        w.isReleasedWhenClosed = false // kept alive for Dock re-open
        w.contentView = content
        window = w
        w.makeKeyAndOrderFront(nil)
    }

    // MARK: Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Trace Review",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Trace Review",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Show All",
                        action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Trace Review",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Open in Browser",
                         action: #selector(openInBrowser(_:)), keyEquivalent: "b")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Window",
                         action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload Page",
                         action: #selector(reloadPage(_:)), keyEquivalent: "r")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize",
                        action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom",
                        action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        winMenu.addItem(withTitle: "Bring All to Front",
                        action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        main.addItem(winItem)

        NSApplication.shared.mainMenu = main
    }

    // MARK: Menu actions

    @objc private func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(kBaseURL)
    }

    @objc private func reloadPage(_ sender: Any?) {
        guard let wv = webView, wv.url != nil else { return }
        wv.reload()
    }
}

// MARK: - WKNavigationDelegate

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if scheme == "http" || scheme == "https" {
            let host = url.host ?? ""
            if host == "127.0.0.1" || host == "localhost" {
                decisionHandler(.allow) // the app itself
            } else {
                NSWorkspace.shared.open(url) // external links → default browser
                decisionHandler(.cancel)
            }
        } else {
            decisionHandler(.allow) // blob:/data:/about: navigations
        }
    }
}

// MARK: - main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
