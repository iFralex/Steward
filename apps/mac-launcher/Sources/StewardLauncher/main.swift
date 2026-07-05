import AppKit
import Carbon
import WebKit

private let defaultURL = "http://127.0.0.1:4317"
private let ollamaURL = URL(string: "http://127.0.0.1:11434")!
private let modelGatewayURL = URL(string: "http://127.0.0.1:4000")!
private let hostURL = URL(string: "http://127.0.0.1:4317")!
private let webDevURL = URL(string: "http://127.0.0.1:5173")!
private let llmWikiAPIURL = URL(string: "http://127.0.0.1:19828/api/v1")!
private let defaultHotKey = "Command+Shift+Space"

final class LauncherDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var statusItem: NSStatusItem?
    private var hotKeyRef: EventHotKeyRef?
    private var childProcesses: [Process] = []
    private let appURL: URL
    private let repoRoot: URL?
    private let explicitURL: Bool
    private let shouldStartServices: Bool
    private let resourcesRoot: URL?
    private let servicesRoot: URL?
    private let bundledNode: URL?

    override init() {
        let env = ProcessInfo.processInfo.environment
        let fromEnv = (env["STEWARD_LAUNCHER_URL"] ?? env["LLM_WIKI_LAUNCHER_URL"])?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fromArg = CommandLine.arguments.dropFirst().first?.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicit = [fromArg, fromEnv].contains { value in
            value?.isEmpty == false
        }
        let rawURL = [fromArg, fromEnv, defaultURL].compactMap { value in
            value?.isEmpty == false ? value : nil
        }.first ?? defaultURL
        self.appURL = URL(string: rawURL) ?? URL(string: defaultURL)!
        self.explicitURL = explicit
        self.shouldStartServices = (env["STEWARD_LAUNCHER_START_SERVICES"] ?? env["LLM_WIKI_LAUNCHER_START_SERVICES"]) != "0"
        self.repoRoot = findRepoRoot()
        let resources = Bundle.main.resourceURL
        let services = resources?.appendingPathComponent("services")
        let node = resources?.appendingPathComponent("node/bin/node")
        let bundledHost = services?.appendingPathComponent("host/index.js").path
        self.resourcesRoot = resources
        self.servicesRoot = bundledHost.map { FileManager.default.fileExists(atPath: $0) } == true ? services : nil
        self.bundledNode = node.map { FileManager.default.fileExists(atPath: $0.path) } == true ? node : nil
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        makeMainMenu()
        makeStatusItem()
        makeWindow()
        registerGlobalHotKey()
        showWindow()
        bootstrap()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }
        for process in childProcesses where process.isRunning {
            process.terminate()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    @objc private func showFromMenu() {
        showWindow()
    }

    @objc private func reloadFromMenu() {
        webView?.reload()
    }

    @objc private func quitFromMenu() {
        NSApp.terminate(nil)
    }

    func toggleWindow() {
        guard let window else { return }
        if window.isVisible && NSApp.isActive {
            window.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
            return
        }
        showWindow()
    }

    /** Minimal main menu: shown while the app is .regular (window visible).
     *  Without it the menu bar is empty and Cmd+C/V/Q are dead in the WebView. */
    private func makeMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Hide Steward", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Quit Steward", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    private func makeStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.title = "LW"
        item.button?.toolTip = "Steward (\(defaultHotKey))"

        let menu = NSMenu()
        menu.addItem(menuItem("Show Steward", #selector(showFromMenu)))
        menu.addItem(menuItem("Reload", #selector(reloadFromMenu), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit", #selector(quitFromMenu), keyEquivalent: "q"))
        item.menu = menu

        statusItem = item
    }

    private func menuItem(_ title: String, _ action: Selector, keyEquivalent: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        return item
    }

    private func makeWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.autoresizingMask = [.width, .height]

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Steward"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = webView
        window.delegate = self

        self.webView = webView
        self.window = window
        loadStatus("Starting Steward...")
    }

    private func showWindow() {
        if webView?.url == nil {
            loadStatus("Starting Steward...")
        }
        // Regular while the window is up: an accessory app owns no menu bar
        // (and Cmd+C/V would be dead). Back to accessory on close/hide.
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func bootstrap() {
        guard shouldStartServices else {
            load(appURL)
            return
        }
        if let servicesRoot, let resourcesRoot, let bundledNode {
            bootstrapBundled(servicesRoot: servicesRoot, resourcesRoot: resourcesRoot, node: bundledNode)
            return
        }
        guard let repoRoot else {
            loadStatus("Could not find the Steward repository root. Set STEWARD_REPO_ROOT or launch from the repo.")
            load(appURL, after: 2)
            return
        }

        let hasWebBuild = FileManager.default.fileExists(
            atPath: repoRoot.appendingPathComponent("apps/web/dist/index.html").path
        )
        let targetURL = explicitURL ? appURL : (hasWebBuild ? hostURL : webDevURL)

        Task {
            await ensureOllama()

            let gatewayIsUp = await isReachable(modelGatewayURL.appendingPathComponent("health"))
            if !gatewayIsUp {
                await MainActor.run {
                    loadStatus("Starting model gateway on 127.0.0.1:4000...")
                    startProcess(["npm", "run", "dev", "-w", "@steward/llm-gateway"], in: repoRoot, logName: "llm-gateway")
                }
                _ = await waitUntilReachable(modelGatewayURL.appendingPathComponent("health"), timeoutSeconds: 20)
            }

            let hostIsUp = await isReachable(hostURL.appendingPathComponent("health"))
            if !hostIsUp {
                await MainActor.run {
                    loadStatus("Starting host on 127.0.0.1:4317...")
                    startProcess(["npm", "run", "dev", "-w", "@steward/host"], in: repoRoot, logName: "host")
                }
                _ = await waitUntilReachable(hostURL.appendingPathComponent("health"), timeoutSeconds: 20)
            }

            if targetURL == webDevURL {
                let webIsUp = await isReachable(webDevURL)
                if !webIsUp {
                    await MainActor.run {
                        loadStatus("Starting web UI on 127.0.0.1:5173...")
                        startProcess(["npm", "run", "dev", "-w", "@steward/web", "--", "--host", "127.0.0.1"], in: repoRoot, logName: "web")
                    }
                    _ = await waitUntilReachable(webDevURL, timeoutSeconds: 30)
                }
            }

            await MainActor.run {
                load(targetURL)
            }
        }
    }

    private func bootstrapBundled(servicesRoot: URL, resourcesRoot: URL, node: URL) {
        let targetURL = explicitURL ? appURL : hostURL

        Task {
            await ensureOllama()

            let gatewayIsUp = await isReachable(modelGatewayURL.appendingPathComponent("health"))
            if !gatewayIsUp {
                await MainActor.run {
                    loadStatus("Starting model gateway on 127.0.0.1:4000...")
                    startProcess([node.path, servicesRoot.appendingPathComponent("llm-gateway/gateway.js").path], in: resourcesRoot, logName: "llm-gateway")
                }
                _ = await waitUntilReachable(modelGatewayURL.appendingPathComponent("health"), timeoutSeconds: 20)
            }

            if (ProcessInfo.processInfo.environment["STEWARD_SCHEDULER"] ?? ProcessInfo.processInfo.environment["LLM_WIKI_SCHEDULER"]) != "0" {
                await MainActor.run {
                    startProcess([node.path, servicesRoot.appendingPathComponent("scheduler/index.js").path], in: resourcesRoot, logName: "scheduler")
                }
            }

            let llmWikiAPIHealthURL = llmWikiAPIURL.appendingPathComponent("health")
            let llmWikiAPIIsUp = await isReachable(llmWikiAPIHealthURL)
            if !llmWikiAPIIsUp {
                await MainActor.run {
                    loadStatus("Starting LLM Wiki API in background...")
                    startBundledLLMWiki(resourcesRoot: resourcesRoot)
                }
                _ = await waitUntilReachable(llmWikiAPIHealthURL, timeoutSeconds: 30)
            }

            let hostIsUp = await isReachable(hostURL.appendingPathComponent("health"))
            if !hostIsUp {
                await MainActor.run {
                    loadStatus("Starting host on 127.0.0.1:4317...")
                    startProcess([node.path, servicesRoot.appendingPathComponent("host/index.js").path], in: resourcesRoot, logName: "host")
                }
                _ = await waitUntilReachable(hostURL.appendingPathComponent("health"), timeoutSeconds: 20)
            }

            await MainActor.run {
                load(targetURL)
            }
        }
    }

    private func startBundledLLMWiki(resourcesRoot: URL) {
        let executableCandidates = [
            resourcesRoot.appendingPathComponent("llm-wiki/LLM Wiki.app/Contents/MacOS/llm-wiki"),
            resourcesRoot.appendingPathComponent("llm-wiki/LLM Wiki.app/Contents/MacOS/LLM Wiki"),
        ]
        guard let executable = executableCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            NSLog("Bundled LLM Wiki executable not found in \(resourcesRoot.appendingPathComponent("llm-wiki").path)")
            return
        }
        startProcess([executable.path, "--background"], in: executable.deletingLastPathComponent(), logName: "llm-wiki")
    }

    private func ensureOllama() async {
        let ollamaIsUp = await isReachable(ollamaURL)
        if !ollamaIsUp {
            await MainActor.run {
                loadStatus("Starting Ollama on 127.0.0.1:11434...")
                startProcess(["ollama", "serve"], in: repoRoot ?? URL(fileURLWithPath: NSHomeDirectory()), logName: "ollama")
            }
            let started = await waitUntilReachable(ollamaURL, timeoutSeconds: 20)
            if !started {
                await MainActor.run {
                    loadStatus("Ollama is not reachable. Install Ollama or start it manually; embeddings will be unavailable.")
                }
                NSLog("Ollama is not reachable on \(ollamaURL.absoluteString)")
            }
        }

        let hasEmbeddingModel = await ollamaHasModel("bge-m3")
        if !hasEmbeddingModel {
            await MainActor.run {
                loadStatus("Ollama is running, but bge-m3 is missing. Run: ollama pull bge-m3")
            }
            NSLog("Ollama model bge-m3 is missing. Run: ollama pull bge-m3")
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    private func startProcess(_ command: [String], in directory: URL, logName: String) {
        guard let executable = command.first else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + command.dropFirst()
        process.currentDirectoryURL = directory
        process.environment = processEnvironment()
        let log = logFile(named: logName)
        process.standardOutput = log
        process.standardError = log
        do {
            try process.run()
            childProcesses.append(process)
        } catch {
            NSLog("Failed to start \(command.joined(separator: " ")): \(error.localizedDescription)")
        }
    }

    private func logFile(named name: String) -> FileHandle? {
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Steward", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let url = logs.appendingPathComponent("\(name).log")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else {
            return nil
        }
        _ = try? handle.seekToEnd()
        return handle
    }

    private func processEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let defaultPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let existing = env["PATH"], !existing.isEmpty {
            env["PATH"] = "\(defaultPath):\(existing)"
        } else {
            env["PATH"] = defaultPath
        }
        if let resourcesRoot, let servicesRoot, let bundledNode {
            env["NODE_ENV"] = "production"
            env["LLM_WIKI_BACKGROUND_MODE"] = "1"
            env["LLM_WIKI_BUNDLED_SERVICES"] = "1"
            env["LLM_WIKI_ROOT"] = resourcesRoot.path
            env["LLM_WIKI_APP_PATH"] = Bundle.main.bundleURL.path
            env["LLM_WIKI_NODE"] = bundledNode.path
            env["NODE_PATH"] = resourcesRoot.appendingPathComponent("node_modules").path
            env["HOST_STATIC_DIR"] = resourcesRoot.appendingPathComponent("web").path
            env["LLM_WIKI_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/llm-wiki.js").path
            env["MAIL_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/mail.js").path
            env["CALENDAR_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/calendar.js").path
            env["CONTACTS_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/contacts.js").path
            env["ACTION_CENTER_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/action-center.js").path
            env["SHELL_MCP_ENTRY"] = servicesRoot.appendingPathComponent("mcp/shell.js").path
            env["MAIL_MIRROR_CLI"] = servicesRoot.appendingPathComponent("cli/mail-mirror.js").path
            env["MAIL_PROMOTER_CLI"] = servicesRoot.appendingPathComponent("cli/mail-promoter.js").path
            env["ACTION_CENTER_CLI"] = servicesRoot.appendingPathComponent("cli/action-center.js").path
            env["WRITE_OPS_CLI"] = servicesRoot.appendingPathComponent("cli/write-ops.js").path
            env["CALENDAR_MCP_CLI"] = servicesRoot.appendingPathComponent("cli/calendar.js").path
            env["CONTACTS_MCP_CLI"] = servicesRoot.appendingPathComponent("cli/contacts.js").path
            env["SCHED_LOG"] = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Logs/Steward/scheduler.jsonl").path
            loadUserConfig(into: &env)
        }
        return env
    }

    private func load(_ url: URL, after delay: TimeInterval = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.webView?.load(URLRequest(url: url))
        }
    }

    private func loadStatus(_ message: String) {
        let html = """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { margin: 0; height: 100vh; display: grid; place-items: center; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2937; background: #f8fafc; }
            main { text-align: center; line-height: 1.5; }
            strong { display: block; font-size: 16px; margin-bottom: 6px; }
          </style>
        </head>
        <body><main><strong>Steward</strong>\(escapeHTML(message))</main></body>
        </html>
        """
        webView?.loadHTMLString(html, baseURL: nil)
    }

    private func registerGlobalHotKey() {
        let hotKeyID = EventHotKeyID(signature: fourCharCode("LMLA"), id: 1)
        let modifiers = UInt32(cmdKey | shiftKey)
        let keyCode = UInt32(kVK_Space)
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            NSLog("Failed to register global hotkey \(defaultHotKey): \(status)")
        }

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                var hotKeyID = EventHotKeyID()
                GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )
                guard hotKeyID.signature == fourCharCode("LMLA"), let userData else {
                    return noErr
                }
                let delegate = Unmanaged<LauncherDelegate>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async {
                    delegate.toggleWindow()
                }
                return noErr
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            nil
        )
    }
}

private func fourCharCode(_ string: String) -> FourCharCode {
    var result: FourCharCode = 0
    for scalar in string.unicodeScalars.prefix(4) {
        result = (result << 8) + FourCharCode(scalar.value)
    }
    return result
}

private func findRepoRoot() -> URL? {
    let env = ProcessInfo.processInfo.environment
    let candidates = [
        env["STEWARD_REPO_ROOT"] ?? env["LLM_WIKI_REPO_ROOT"],
        env["npm_package_json"].flatMap { URL(fileURLWithPath: $0).deletingLastPathComponent().path },
        FileManager.default.currentDirectoryPath,
    ].compactMap { $0 }.map { URL(fileURLWithPath: $0) }

    for candidate in candidates {
        if let root = findRepoRoot(from: candidate) {
            return root
        }
    }
    return nil
}

private func findRepoRoot(from start: URL) -> URL? {
    var current = start.standardizedFileURL
    let fileManager = FileManager.default
    while true {
        let packageJSON = current.appendingPathComponent("package.json").path
        let hostDir = current.appendingPathComponent("apps/host").path
        let webDir = current.appendingPathComponent("apps/web").path
        if fileManager.fileExists(atPath: packageJSON),
           fileManager.fileExists(atPath: hostDir),
           fileManager.fileExists(atPath: webDir) {
            return current
        }

        let parent = current.deletingLastPathComponent()
        if parent.path == current.path {
            return nil
        }
        current = parent
    }
}

private func isReachable(_ url: URL) async -> Bool {
    var request = URLRequest(url: url)
    request.timeoutInterval = 1.5
    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            return false
        }
        return (200..<500).contains(http.statusCode)
    } catch {
        return false
    }
}

private func waitUntilReachable(_ url: URL, timeoutSeconds: TimeInterval) async -> Bool {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        if await isReachable(url) {
            return true
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
    }
    return false
}

private func ollamaHasModel(_ name: String) async -> Bool {
    guard await isReachable(ollamaURL) else {
        return false
    }
    var request = URLRequest(url: ollamaURL.appendingPathComponent("api/tags"))
    request.timeoutInterval = 2
    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return false
        }
        let parsed = try JSONSerialization.jsonObject(with: data)
        guard
            let object = parsed as? [String: Any],
            let models = object["models"] as? [[String: Any]]
        else {
            return false
        }
        return models.contains { model in
            guard let modelName = model["name"] as? String else {
                return false
            }
            return modelName == name || modelName.hasPrefix("\(name):")
        }
    } catch {
        return false
    }
}

private func escapeHTML(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

private func loadUserConfig(into env: inout [String: String]) {
    // Prefer the new Steward path; fall back to the legacy "LLM Wiki" location so
    // an existing install keeps its keys/overrides after the rename.
    let home = FileManager.default.homeDirectoryForCurrentUser
    let config = home.appendingPathComponent("Library/Application Support/Steward/config.env")
    let legacy = home.appendingPathComponent("Library/Application Support/LLM Wiki/config.env")
    let loaded = (try? String(contentsOf: config, encoding: .utf8))
        ?? (try? String(contentsOf: legacy, encoding: .utf8))
    guard let text = loaded else {
        return
    }
    for rawLine in text.split(whereSeparator: \.isNewline) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") {
            continue
        }
        guard let eq = line.firstIndex(of: "=") else {
            continue
        }
        let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
        var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
        if value.count >= 2,
           let first = value.first,
           let last = value.last,
           (first == "\"" || first == "'"),
           first == last {
            value = String(value.dropFirst().dropLast())
        }
        if !key.isEmpty {
            env[key] = value
        }
    }
}

let app = NSApplication.shared
let delegate = LauncherDelegate()
app.delegate = delegate
app.run()
