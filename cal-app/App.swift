import AppKit
import Network

// MARK: - 引擎（调用 dsh-cal 命令行，输出 JSON）

struct EngineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum Engine {
    /// 启动器自己找 node，不依赖 PATH（GUI 应用的环境变量很干净）。
    static var runner: String {
        NSString(string: "~/.local/libexec/dsh-cal-run").expandingTildeInPath
    }

    static func callSync(_ args: [String], env: [String: String] = [:]) throws -> [String: Any] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [runner] + args
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in env { environment[key] = value }
        process.environment = environment

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        let debugOn = ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1"
        do {
            try process.run()
        } catch {
            throw EngineError(message: "无法启动命令：\(error.localizedDescription)")
        }

        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let text = String(data: data, encoding: .utf8) ?? ""
        let jsonLine = text
            .split(separator: "\n")
            .last(where: { $0.hasPrefix("{") })
            .map(String.init) ?? ""

        if !jsonLine.isEmpty,
           let object = try? JSONSerialization.jsonObject(with: Data(jsonLine.utf8)) as? [String: Any] {
            if debugOn {
                let head = args.joined(separator: " | ")
                let errText = (String(data: errData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                FileHandle.standardError.write(Data("RUN \(head)\n  → \(jsonLine.prefix(240))\n  ERR \(errText.prefix(200))\n".utf8))
            }
            return object
        }

        let errText = (String(data: errData, encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if debugOn {
            let head = args.joined(separator: " | ")
            let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
            FileHandle.standardError.write(Data("RUN \(head) → \(body.prefix(200))\nERR \(errText.prefix(200))\n".utf8))
        }
        throw EngineError(message: errText.isEmpty ? (text.isEmpty ? "命令没有输出，检查 node 是否还在" : text) : errText)
    }

    static func call(
        _ args: [String],
        env: [String: String] = [:],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let result = try callSync(args, env: env)
                DispatchQueue.main.async { completion(.success(result)) }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }
}

// MARK: - 本地模型进程（跟着 App 一起起、一起退）

/// 只管 ollama 这一个进程：打开 App 时拉起来并在后台预热，退出时关掉把内存还回去。
/// 预热是后台任务，界面不等它——规则那条路径任何时候都是马上出结果。
final class LocalModel {
    static let shared = LocalModel()

    enum Phase {
        case off        // 没启用，或不是 ollama
        case starting   // 正在拉起 + 加载
        case ready      // 已加载，随时能用
        case failed     // 起不来
    }

    private(set) var phase: Phase = .off
    /// 状态补充说明（失败原因 / 模型名）
    private(set) var note = ""
    /// 界面靠它刷新
    var onChange: (() -> Void)?

    private var model = ""
    private var provider = "ollama"
    private var baseURL = URL(string: "http://127.0.0.1:11434")!
    private var server: Process?
    /// 归我们管的那个 ollama pid。只有归我们管的，退出时才收掉。
    private var ownedPid: pid_t?
    private var startedByUs: Bool { ownedPid != nil }

    // MARK: 读配置

    private func readLLMConfig() -> [String: Any] {
        let path = NSString(string: "~/.config/dsh-cal/config.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object["llm"] as? [String: Any] ?? [:]
    }

    var modelName: String { model }

    // MARK: 生命周期

    func start() {
        let llm = readLLMConfig()
        let enabled = llm["enabled"] as? Bool ?? false
        provider = llm["provider"] as? String ?? "ollama"
        model = llm["model"] as? String ?? ""
        if let raw = llm["baseUrl"] as? String, let url = URL(string: raw) { baseURL = url }

        guard enabled, provider == "ollama" else {
            update(.off, note: "")
            return
        }

        update(.starting, note: "正在启动本地模型…")
        // 端口已经通：可能是上次没来得及收掉的自己，也可能是用户自己开的
        probe { [weak self] alive in
            guard let self else { return }
            if alive {
                _ = self.adoptLeftover()
                self.warm()
            } else {
                self.spawn()
                self.waitForPort(attempts: 40)   // 40 × 0.4s ≈ 16s
            }
        }
    }

    /// 退出前调用：只收我们自己起的那个进程。
    func shutdown() {
        guard let pid = ownedPid else { return }
        ownedPid = nil
        server = nil
        clearPid()
        guard kill(pid, 0) == 0 else { return }   // 已经不在了
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(2.5)
        while kill(pid, 0) == 0 && Date() < deadline { usleep(60_000) }
        if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
        log("已收掉 ollama pid=\(pid)")
    }

    /// 手动重来一次（菜单「重新加载模型」）
    func reload() {
        if phase == .ready {
            // 已经在跑的话，直接再预热一次，确保模型还在内存里
            warm()
        } else {
            start()
        }
    }

    // MARK: 内部步骤

    private func probe(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/version"))
        request.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let alive = (data?.count ?? 0) > 0
            DispatchQueue.main.async { done(alive) }
        }.resume()
    }

    private func spawn() {
        let candidates = [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/usr/bin/ollama",
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ]
        guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            update(.failed, note: "找不到 ollama 命令")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["serve"]
        var environment = ProcessInfo.processInfo.environment
        environment["OLLAMA_KV_CACHE_TYPE"] = "q8_0"   // 16G 机器上把 KV cache 压到一半
        environment["OLLAMA_KEEP_ALIVE"] = "30m"
        process.environment = environment
        if let log = serverLogHandle() {
            process.standardOutput = log
            process.standardError = log
        }
        do {
            try process.run()
            server = process
            ownedPid = process.processIdentifier
            savePid(ownedPid!)
            log("ollama serve 已启动 pid=\(process.processIdentifier)")
        } catch {
            update(.failed, note: "启动 ollama 失败：\(error.localizedDescription)")
        }
    }

    // MARK: 进程归属（记住是我们起的，免得下次收错/收不掉）

    private var pidPath: String {
        NSString(string: "~/.config/dsh-cal/ollama.pid").expandingTildeInPath
    }

    private func savePid(_ pid: pid_t) {
        try? String(pid).write(toFile: pidPath, atomically: true, encoding: .utf8)
    }

    private func clearPid() {
        try? FileManager.default.removeItem(atPath: pidPath)
    }

    /// 端口活着但没记在我们名下：看 pid 文件是不是上次留下的一只，是就接手。
    @discardableResult
    private func adoptLeftover() -> Bool {
        guard let raw = try? String(contentsOfFile: pidPath, encoding: .utf8) else {
            log("没有 pid 文件，不接手")
            return false
        }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pid = pid_t(text), pid > 0, kill(pid, 0) == 0 else {
            log("pid 文件过期（\(text)），清掉")
            clearPid()
            return false
        }
        // 认人：优先用 ps 看命令行，起不来再退到 NSRunningApplication
        guard looksLikeOllama(pid) else {
            log("pid \(pid) 不是我们起的 ollama，不动它")
            clearPid()
            return false
        }
        ownedPid = pid
        log("接手上次遗留的 ollama pid=\(pid)")
        return true
    }

    private func looksLikeOllama(_ pid: pid_t) -> Bool {
        if let out = run("/bin/ps", ["-p", "\(pid)", "-o", "command="]), !out.isEmpty {
            return out.lowercased().contains("ollama")
        }
        if let url = NSRunningApplication(processIdentifier: pid)?.executableURL {
            return url.lastPathComponent.lowercased().contains("ollama")
        }
        return false
    }

    private func run(_ path: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? (String(data: data, encoding: .utf8) ?? "") : nil
    }

    private func waitForPort(attempts: Int) {
        guard attempts > 0 else {
            update(.failed, note: "ollama 启动超时")
            return
        }
        probe { [weak self] alive in
            guard let self else { return }
            if alive {
                self.warm()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    self.waitForPort(attempts: attempts - 1)
                }
            }
        }
    }

    /// 让模型真正进内存。第一次加载 15–20 秒，之后每次调用 0.6–1 秒。
    private func warm() {
        update(.starting, note: "正在加载 \(model)…")
        Engine.call(["llm", "--warm", "--json"]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                self.update(.ready, note: "\(self.model) 已加载")
            case .success(let payload):
                self.update(.failed, note: payload["error"] as? String ?? "预热失败")
            case .failure(let error):
                self.update(.failed, note: error.localizedDescription)
            }
        }
    }

    private func update(_ phase: Phase, note: String) {
        self.phase = phase
        self.note = note
        log("模型状态 → \(phase) \(note)")
        onChange?()
    }

    // MARK: 调试日志

    private var logPath: String {
        NSString(string: "~/.config/dsh-cal/ollama.log").expandingTildeInPath
    }

    private var modelLogPath: String {
        NSString(string: "~/.config/dsh-cal/model.log").expandingTildeInPath
    }

    private func logHandle() -> FileHandle? { handle(for: modelLogPath) }

    /// 给 ollama 自己的输出用（它只认 stdout/stderr 重定向）
    private func serverLogHandle() -> FileHandle? { handle(for: logPath) }

    private func handle(for path: String) -> FileHandle? {
        let manager = FileManager.default
        if !manager.fileExists(atPath: path) {
            manager.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private func log(_ text: String) {
        // 一直写进日志文件，方便事后查「模型为什么没起来」
        let stamp = ISO8601DateFormatter().string(from: Date())
        if let handle = logHandle() {
            handle.write(Data("[\(stamp)] \(text)\n".utf8))
            try? handle.close()
        }
        guard ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1" else { return }
        FileHandle.standardError.write(Data("[model] \(text)\n".utf8))
    }
}

// MARK: - 委托

/// 输入框本体。只多一件事：外观切成深/浅时通知外面重刷一遍原文颜色
/// （属性字符串里的色是解析过的实色，不会自己跟着外观变）。
final class ComposeTextView: NSTextView {
    var onAppearanceChange: (() -> Void)?

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTextViewDelegate {
    private var window: NSWindow!
    private var calendars: [String] = []
    private var currentCalendar: String = "学习"
    private var configured = false
    private var offline = false
    /// 断网时的自动重试：系统网络路径一恢复就立刻探一次，另外每 15 秒兜一次底。
    /// 没有这套东西，一开 App 就没网的话，状态点会永远停在橙色上——写入失败才会翻牌，
    /// 而队列空的时候连写都不会发生。
    private var reconnectTimer: Timer?
    private var pathMonitor: NWPathMonitor?
    private var probing = false
    /// 上一次看到的网络路径状态。NWPathMonitor 会因为各种原因反复报「satisfied」，
    /// 不去重的话每报一次就 spawn 一个 node 进程，等于自己把自己刷爆。
    private var lastPathSatisfied: Bool?
    /// 设置页是因为「断网 + 没有缓存」才出现的：这种要等网络回来自动重读，不是让用户干瞪眼
    private var setupFromNetwork = false
    /// 换页时会被重建的提示语：设置页恢复成主界面后，把「已重新连上」补回状态栏
    private var pendingStatusNote: String?
    /// 读不到云端日程时列表里该说的话（默认那句「没有安排」在离线时会骗人）
    private var agendaNote: String?
    private var pending = 0
    /// 是否启用本地模型兜底（读 config.json 的 llm.enabled）
    private var modelEnabled = false
    /// 用户手动改过下拉框，就不再被句子里的标签覆盖
    private var manualOverride = false
    private var detectedTag: String?

    // 主界面控件
    private var input: NSTextView?
    private var placeholderLabel: NSTextField?
    private var inputCard: CardView?
    private var chipRow: NSView?
    /// 「美化」开关：把输入卡染成跟胶囊同色的渐变
    private var tintEnabled: Bool = {
        if let forced = ProcessInfo.processInfo.environment["DSH_CAL_TINT"] { return forced != "0" }
        return UserDefaults.standard.object(forKey: "tintInputCard") as? Bool ?? true
    }()
    /// 「光圈」开关：卡片外面绕一圈会转的彩色辉光
    private var glowEnabled: Bool = {
        if let forced = ProcessInfo.processInfo.environment["DSH_CAL_GLOW"] { return forced != "0" }
        return UserDefaults.standard.object(forKey: "glowInputCard") as? Bool ?? true
    }()
    /// 这一句识别出来的片段顺序（胶囊顺序），美化时按它排渐变的颜色
    private var tintKinds: [String] = []
    private var tintToggle: TintToggle?
    private var tintMenuItem: NSMenuItem?
    private var glowMenuItem: NSMenuItem?
    private var hintLabel: NSTextField?
    private var dateLabel: NSTextField?
    private var subtitle: NSTextField?
    private var listScroll: NSScrollView?
    private var listContainer: FlippedView?
    /// 远期冲突补查用的键：只有同一段预览才允许把结果贴上界面
    private var remoteConflictKey = ""
    private var statusLabel: NSTextField?
    private var picker: CalendarPicker?
    /// 常驻的玻璃外壳：从窗口出现到退出都不换，换的只是里面的内容。
    /// 这样启动/切换界面时不会出现「一瞬间只有半块玻璃」的中间态。
    private var shell: BackdropView?
    /// 内容槽：所有界面都装进这里，换页时整块淡入
    private var slot: NSView?
    private var addButton: NSButton?
    private var badge: NSTextField?
    private var dot: StatusDot?
    private var modelLabel: NSTextField?
    /// 第一次布局才把窗口居中，之后重建（比如重新检查连接）保持原位
    private var didLayoutMain = false
    /// 列表里显示的日程
    private var agenda: [AgendaItem] = []
    /// 日历名 → 颜色，给每条日程配左侧色条
    private var calendarColors: [String: NSColor] = [:]
    /// 刚写入的那条：列表刷新时闪一下，告诉用户「它真的进去了」
    private var highlightUID: String?
    /// 当前这句识别出的片段位置，用来给原文上色
    private var currentSpans: [Span] = []
    /// 预览出来的时间范围，用来和列表里的日程比冲突
    private var previewStart: Date?
    private var previewEnd: Date?
    /// 上色时会改动 textStorage，别让它再次触发解析
    private var isHighlighting = false
    /// 调用过模型之后要显示的字，nil 表示还没调用过
    private var modelUsed: String?
    /// 模型还没加载好的时候先记下这句话，加载完自动补一次
    private var pendingRefine: String?
    private var parseWork: DispatchWorkItem?

    // 配置界面控件
    private var setupEmail: NSTextField?
    private var setupPassword: NSSecureTextField?
    private var setupCalendar: NSTextField?
    private var setupStatus: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        // 一开始就用最终尺寸：以前先开 620×316 再撑到 760×720，
        // 窗口会先闪一下小尺寸的空玻璃，就是「点进去一瞬间界面不完全」的来源。
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "日历"
        // Liquid Glass 的前提：窗口本身透明，玻璃才采得到背后的桌面
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.center()
        makeShell()

        // 先把占位文字装好再让窗口露面，第一帧就是完整画面（不再整窗淡入）
        showMessage("正在读取日历…")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let force = ProcessInfo.processInfo.environment["DSH_CAL_FORCE_SETUP"], force == "1" || force == "settings" {
            if force == "settings" { openSettings() } else { buildSetup(note: "") }
            snapshotIfRequested()
            return
        }
        refreshConfig()
        startNetworkWatch()
        selfTestIfRequested()

        // 本地模型：后台拉起 + 预热，界面不等它
        LocalModel.shared.onChange = { [weak self] in self?.modelStateChanged() }
        LocalModel.shared.start()
    }

    /// 模型状态变了：刷新那行小字；如果之前有句话因为模型没就绪被搁下，现在补跑
    private func modelStateChanged() {
        updateModelLabel()
        guard LocalModel.shared.phase == .ready,
              let snapshot = pendingRefine,
              isCurrent(snapshot) else { return }
        pendingRefine = nil
        refinePreview(snapshot)
    }

    private func updateModelLabel() {
        // 状态灯的副标题统一由 updateSubtitle 拼，这里只负责让模型说明能显示在 tooltip 上
        if !LocalModel.shared.note.isEmpty {
            modelLabel?.toolTip = LocalModel.shared.note
        }
        updateSubtitle()
    }

    /// `--self-test`：程序化验证菜单里的 ⌘W / ⌘M 真的能作用到窗口上。
    private func selfTestIfRequested() {
        let args = CommandLine.arguments
        guard args.contains("--self-test") || args.contains("--test-close") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            // 从终端后台拉起的进程默认拿不到焦点，先强抢一次再测
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.runSelfTest() }
        }
    }

    private func runSelfTest() {
        var lines: [String] = ["起始：isVisible=\(window.isVisible)  isKey=\(window.isKeyWindow)"]
        lines.append("关窗即退出：shouldTerminateAfterLastWindowClosed=\(applicationShouldTerminateAfterLastWindowClosed(NSApp))")

        let minimized = NSApp.sendAction(#selector(NSWindow.performMiniaturize(_:)), to: nil, from: nil)
        // 最小化有动画，状态要等一拍才落定
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            lines.append("⌘M 最小化：发出=\(minimized)  isMiniaturized=\(self.window.isMiniaturized)")
            self.window.deminiaturize(nil)
            self.waitModelThenQuit(lines: lines, deadline: Date().addingTimeInterval(40))
        }
    }

    /// 等模型就绪（或超时/失败）后主动退出，用来验证「退出时模型进程会不会跟着收掉」。
    private func waitModelThenQuit(lines: [String], deadline: Date) {
        let phase = LocalModel.shared.phase
        if phase == .ready || phase == .failed || phase == .off || Date() > deadline {
            var out = lines
            out.append("模型：phase=\(phase)  note=\(LocalModel.shared.note)")
            out.append("模型被调用过：\(modelUsed ?? "否")")
            if CommandLine.arguments.contains("--test-close") {
                out.append("关掉窗口，看 App 和 ollama 会不会一起退…")
                print(out.joined(separator: "\n"))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.window.performClose(nil) }
            } else {
                out.append("开始退出，观察 ollama 进程是否被一并收掉…")
                print(out.joined(separator: "\n"))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.waitModelThenQuit(lines: lines, deadline: deadline)
        }
    }

    /// 关窗就退出 App（Dock 图标一起消失），同时把本地模型进程收掉。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        LocalModel.shared.shutdown()
    }

    /// 窗口关掉后再点 Dock 图标，重新打开。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    // MARK: 菜单栏

    private func buildMenu() {
        // 菜单栏上的名字跟 bundle 的显示名保持一致，避免两处各写一份、改一处忘另一处
        let appName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "DSH 日历"
        let mainMenu = NSMenu()

        // ── 应用菜单
        let appItem = NSMenuItem(title: appName, action: nil, keyEquivalent: "")
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: appName)
        appItem.submenu = appMenu

        let about = appMenu.addItem(withTitle: "关于 \(appName)", action: #selector(showAbout), keyEquivalent: "")
        about.target = self

        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self

        appMenu.addItem(.separator())
        let hide = appMenu.addItem(withTitle: "隐藏 \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hide.target = NSApp
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        hideOthers.target = NSApp
        let showAll = appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        showAll.target = NSApp

        appMenu.addItem(.separator())
        let quit = appMenu.addItem(withTitle: "退出 \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp

        // ── 文件
        let fileItem = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "文件")
        fileItem.submenu = fileMenu

        let newEvent = fileMenu.addItem(withTitle: "新建日程", action: #selector(focusInput), keyEquivalent: "n")
        newEvent.target = self
        fileMenu.addItem(.separator())
        // target 留空 → 走响应链，落到当前窗口，⌘W 才是标准的「关闭窗口」
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // ── 编辑（文本框里的剪切/复制/粘贴靠这些菜单项转发）
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu

        editMenu.addItem(withTitle: "撤销", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: NSSelectorFromString("redo:"), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: NSSelectorFromString("cut:"), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: NSSelectorFromString("copy:"), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: NSSelectorFromString("paste:"), keyEquivalent: "v")
        editMenu.addItem(withTitle: "删除", action: NSSelectorFromString("delete:"), keyEquivalent: "")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "全选", action: NSSelectorFromString("selectAll:"), keyEquivalent: "a")

        // ── 日程
        let scheduleItem = NSMenuItem(title: "日程", action: nil, keyEquivalent: "")
        mainMenu.addItem(scheduleItem)
        let scheduleMenu = NSMenu(title: "日程")
        scheduleItem.submenu = scheduleMenu

        let recheck = scheduleMenu.addItem(withTitle: "重新检查连接", action: #selector(recheckNow), keyEquivalent: "r")
        recheck.target = self
        let flush = scheduleMenu.addItem(withTitle: "立即补发离线日程", action: #selector(syncNowAction), keyEquivalent: "")
        flush.target = self
        let reload = scheduleMenu.addItem(withTitle: "重新加载模型", action: #selector(reloadModel), keyEquivalent: "r")
        reload.keyEquivalentModifierMask = [.command, .option]
        reload.target = self
        scheduleMenu.addItem(.separator())
        // 美化开关：勾上时输入卡按胶囊颜色染色
        let tintItem = scheduleMenu.addItem(withTitle: "美化输入框", action: #selector(toggleTint), keyEquivalent: "g")
        tintItem.target = self
        tintItem.state = tintEnabled ? .on : .off
        tintMenuItem = tintItem
        // 光线圈：卡片外面那圈会转的彩色辉光
        let glowItem = scheduleMenu.addItem(withTitle: "输入框光圈", action: #selector(toggleGlow), keyEquivalent: "g")
        glowItem.keyEquivalentModifierMask = [.command, .shift]
        glowItem.target = self
        glowItem.state = glowEnabled ? .on : .off
        glowMenuItem = glowItem
        scheduleMenu.addItem(.separator())
        let syntax = scheduleMenu.addItem(withTitle: "怎么说才认得", action: #selector(showHelp), keyEquivalent: "")
        syntax.target = self

        // ── 窗口
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")

        // ── 帮助
        let helpItem = NSMenuItem(title: "帮助", action: nil, keyEquivalent: "")
        mainMenu.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助")
        helpItem.submenu = helpMenu
        NSApp.helpMenu = helpMenu

        let help = helpMenu.addItem(withTitle: "日历帮助", action: #selector(showHelp), keyEquivalent: "?")
        help.target = self

        NSApp.mainMenu = mainMenu

        // 自检：`DSHCalendar --dump-menu` 打印整棵菜单树，验证快捷键有没有绑上
        if CommandLine.arguments.contains("--dump-menu") {
            dumpMainMenu()
            exit(0)
        }
    }

    private func dumpMainMenu() {
        func modifierGlyphs(_ mask: NSEvent.ModifierFlags) -> String {
            var text = ""
            if mask.contains(.control) { text += "^" }
            if mask.contains(.option) { text += "⌥" }
            if mask.contains(.shift) { text += "⇧" }
            if mask.contains(.command) { text += "⌘" }
            return text
        }

        func walk(_ menu: NSMenu, depth: Int) {
            let pad = String(repeating: "    ", count: depth)
            for item in menu.items {
                if item.isSeparatorItem {
                    print("\(pad)──────")
                    continue
                }
                var key = ""
                if !item.keyEquivalent.isEmpty {
                    key = "  \(modifierGlyphs(item.keyEquivalentModifierMask))\(item.keyEquivalent.uppercased())"
                }
                let action = item.action.map { NSStringFromSelector($0) } ?? "nil"
                print("\(pad)\(item.title)\(key)   → \(action)  target=\(item.target == nil ? "响应链" : "App")")
                if let submenu = item.submenu { walk(submenu, depth: depth + 1) }
            }
        }

        guard let main = NSApp.mainMenu else { return }
        walk(main, depth: 0)
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "日历",
            .version: "1.0",
            .credits: NSAttributedString(
                string: "说一句话就能建日程。\n时间由规则算（毫秒级、离线可用）；「做什么、在哪」交给本机模型理解，规则判不准时才问它。全都不出这台电脑。",
                attributes: [.font: NSFont.systemFont(ofSize: 11)]
            ),
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showHelp() {
        let alert = NSAlert()
        alert.messageText = "怎么说才认得"
        alert.informativeText = """
        时间：今天 / 今 / 明天 / 明 / 明早 / 明晚 / 后天 / 后 / 大后天 / 大后
              周三 / 下周一 / 下下周一 / 11月8号 / 十一月八号 / 八号
        时刻：下午三点 / 六点半 / 三点一刻 / 八点四十 / 十点零五 / 8:40 / 三点整
        区间：明早八点到八点四十   晚上11点到凌晨1点（自动跨天）
        时长：一小时 / 一个半小时 / 半小时 / 90分钟（不写默认一小时）
        全天：写 #全天 就是全天日程，不设时间（句子里就算写了钟点也按全天算）
              明天 交作业 #全天 / 明天下午三点开会 #全天 → 明天 · 全天
              只说了日期、没写钟点，也按全天算
        顺延：没说哪天、而今天这个时段已经过了 → 自动排到明天（预览里标「顺延」）
        地点：在图书馆学习（自动切开）/ 地点写图书馆 / 地点：图书馆 / @图书馆
        标签：#工作 / 标签：工作 / 加到工作日历 / 句子末尾写日历名
        重复：每天早上七点跑步 / 每周三组会 / 每周一三五健身 / 每个工作日站会 / 每月8号交房租
        提醒：提前十分钟提醒 / 提前半小时提醒（写进日历，响铃由系统日历负责）

        列表：右键任意一条可以「推迟 30 分钟 / 推迟 1 小时 / 改到明天 / 删除」，
              鼠标悬停时右侧会出现删除按钮。
        冲突：输入时若和已有日程重叠，下方会用橙色提示，但不会阻止你写入。
        美化：⌘G（或点胶囊行右端的「美化」）把输入框染成一条渐变，
              颜色顺序就跟下面那排胶囊一样：标题灰 → 时间蓝 → 地点绿 → 标签紫。
              颜色只兑两成，框里的字仍按片段上色、并且压暗/提亮过，看得清。
        光圈：⌘⇧G（或设置里「输入框光圈」）在卡片外面绕一圈彩色辉光，
              颜色同一套、慢慢转；敲字和模型在想办法时会亮一下。
        这两样都在「日历 → 设置…（⌘,）」里能开关，状态记在本机。

        识别靠本机规则：先按词表切出日期、时刻、地点、标签，再把剥掉这些片段后剩下的部分当标题。断网也能用。

        规则没认出地点时，才让本机的 qwen3 再看一眼（只补地点，时间永远由规则算）。
        模型跟着 App 一起起、一起退，不占常驻内存。
        """
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }

    @objc private func openSettings() {
        let config = readConfigFile()
        buildSetup(
            note: "改完点「保存」。密码留空就沿用钥匙串里已存的那个。",
            heading: "日历设置",
            actionTitle: "保存",
            email: config["username"] as? String ?? "",
            calendar: (config["calendar"] as? String) ?? calendarNamesSnapshot,
            noteColor: .secondaryLabelColor,
            showsAppearance: true
        )
    }

    /// 截图自检用：DSH_CAL_DEMO_DARK=1 强制暗色、DSH_CAL_DEMO_LIGHT=1 强制浅色，方便核对配色
    private func applyDemoAppearance() {
        let env = ProcessInfo.processInfo.environment
        if env["DSH_CAL_DEMO_DARK"] == "1" {
            window.appearance = NSAppearance(named: .darkAqua)
        }
        if env["DSH_CAL_DEMO_LIGHT"] == "1" {
            window.appearance = NSAppearance(named: .aqua)
        }
    }

    private var calendarNamesSnapshot: String { calendars.first ?? "学习" }

    private func readConfigFile() -> [String: Any] {
        let path = NSString(string: "~/.config/dsh-cal/config.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    // MARK: 配置

    private func refreshConfig() {
        Engine.call(["cals", "--json"]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                let list = (payload["calendars"] as? [[String: Any]]) ?? []
                let names = list.compactMap { $0["name"] as? String }
                self.calendars = names
                // 日历自己的颜色，列表里给每条日程配左侧色条
                self.calendarColors = [:]
                for entry in list {
                    guard let name = entry["name"] as? String,
                          let hex = entry["color"] as? String,
                          let color = NSColor(hexString: hex) else { continue }
                    self.calendarColors[name] = color
                }
                self.configured = true
                self.offline = payload["offline"] as? Bool ?? false
                // 启动时就断网的话，从这一刻起开始盯着，等它恢复
                if self.offline { self.startReconnectWatch() } else { self.stopReconnectWatch() }
                self.modelEnabled = (self.readConfigFile()["llm"] as? [String: Any])?["enabled"] as? Bool ?? false
                let fallback = (payload["default"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                self.currentCalendar = fallback ?? names.first ?? "学习"
                self.buildMain()
                self.refreshPending()
                if let manual = ProcessInfo.processInfo.environment["DSH_CAL_DEMO_MANUAL"], !manual.isEmpty {
                    self.manualOverride = true
                    self.selectCalendar(manual)
                }
                if let demo = ProcessInfo.processInfo.environment["DSH_CAL_DEMO_TEXT"], !demo.isEmpty {
                    self.input?.stringValue = demo
                    self.placeholderLabel?.isHidden = true
                    if ProcessInfo.processInfo.environment["DSH_CAL_DEMO_ADD"] == "1" {
                        self.addEvent()
                    } else {
                        self.parseNow()
                    }
                }
            case .success(let payload):
                let note = payload["error"] as? String ?? ""
                // 「断网 + 本机没缓存」也会落到设置页；这种等网络回来自动重读，
                // 否则用户打开 App 只看到一句连不上，网络好了也不会自己消失。
                self.setupFromNetwork = self.isNetworkNote(note)
                if self.setupFromNetwork { self.startReconnectWatch() }
                self.buildSetup(note: note)
            case .failure(let error):
                self.buildSetup(note: error.localizedDescription)
            }
            self.snapshotIfRequested()
        }
    }

    // MARK: 主界面

    private func buildMain() {
        let width: CGFloat = 760
        let height: CGFloat = 720
        let margin: CGFloat = 28
        let contentWidth = width - margin * 2

        // 内容层：玻璃在下面的 shell 里，这里只放控件，换页时整块淡入
        let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true

        // ── 顶部：日期、状态、日历
        let date = NSTextField(labelWithString: Format.bigDate())
        date.font = NSFont.systemFont(ofSize: 30, weight: .semibold)
        date.textColor = .labelColor
        date.frame = NSRect(x: margin, y: 650, width: 340, height: 40)
        root.addSubview(date)
        self.dateLabel = date

        let dot = StatusDot(frame: NSRect(x: margin, y: 629, width: 10, height: 10))
        root.addSubview(dot)
        self.dot = dot

        let subtitle = NSTextField(labelWithString: "")
        subtitle.font = NSFont.systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byTruncatingTail
        subtitle.frame = NSRect(x: margin + 18, y: 624, width: 450, height: 17)
        root.addSubview(subtitle)
        self.subtitle = subtitle

        let picker = CalendarPicker(frame: NSRect(x: 0, y: 644, width: 120, height: 28))
        picker.calendars = calendars.isEmpty ? [currentCalendar] : calendars
        picker.colors = calendarColors
        picker.current = currentCalendar
        picker.onPick = { [weak self] name in self?.calendarSelected(name) }
        picker.toolTip = "写进哪个日历。句子里写 #工作 会自动切过来，也可以在这里手动选。"
        // 宽度按最长的日历名算一次，之后切换不跳
        let capsuleWidth = picker.preferredWidth
        picker.frame = NSRect(x: width - margin - capsuleWidth, y: 644, width: capsuleWidth, height: 28)
        root.addSubview(picker)
        self.picker = picker

        // ── 输入卡：一层独立的玻璃，跟窗口底板拉开层次
        let card = CardView(
            frame: NSRect(x: margin, y: 510, width: contentWidth, height: 96),
            cornerRadius: 20
        )
        root.addSubview(card)
        self.inputCard = card
        // 从设置页切回来时卡片是新建的，把上一句的染色补上
        applyTint()

        let textWidth = contentWidth - 14 - 12 - 92
        let scroll = NSScrollView(frame: NSRect(x: 14, y: 14, width: textWidth, height: 68))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true

        let textView = ComposeTextView(frame: NSRect(x: 0, y: 0, width: textWidth, height: 68))
        textView.delegate = self
        // 系统外观切深浅时，文本里那些实色要重算一遍
        textView.onAppearanceChange = { [weak self] in
            DispatchQueue.main.async { self?.applyHighlight() }
        }
        textView.drawsBackground = false
        textView.isRichText = true
        textView.importsGraphics = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.allowsUndo = true
        textView.font = NSFont.systemFont(ofSize: 16)
        textView.textContainerInset = NSSize(width: 2, height: 6)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        scroll.documentView = textView
        card.addSubview(scroll)
        self.input = textView

        let placeholder = NSTextField(labelWithString: "说一句，例如：明天下午三点到四点 组会 @图书馆 #学习")
        placeholder.font = NSFont.systemFont(ofSize: 15)
        placeholder.textColor = .tertiaryLabelColor
        placeholder.frame = NSRect(x: 16, y: 54, width: textWidth - 20, height: 20)
        card.addSubview(placeholder)
        self.placeholderLabel = placeholder

        let add = GlassButton(frame: NSRect(x: contentWidth - 14 - 74, y: 29, width: 74, height: 34))
        add.title = "添加"
        add.target = self
        add.action = #selector(addEvent)
        add.keyEquivalent = "\r"
        add.toolTip = "写入日程（回车）"
        card.addSubview(add)
        self.addButton = add

        // ── 识别结果胶囊
        let chips = NSView(frame: NSRect(x: margin, y: 476, width: contentWidth, height: 24))
        root.addSubview(chips)
        self.chipRow = chips

        // 胶囊行右端的「美化」开关：关掉就是一块素玻璃，开着才染色
        let tint = TintToggle(frame: NSRect(x: width - margin - 54, y: 476, width: 54, height: 24))
        tint.on = tintEnabled
        tint.kinds = tintKinds
        tint.target = self
        tint.action = #selector(toggleTint)
        tint.toolTip = "把输入框染成下面这排胶囊的颜色（⌘G）"
        root.addSubview(tint)
        self.tintToggle = tint

        // ── 提示行：冲突提醒 / 写入结果
        let hint = NSTextField(labelWithString: "")
        hint.font = NSFont.systemFont(ofSize: 12)
        hint.textColor = .secondaryLabelColor
        hint.lineBreakMode = .byTruncatingTail
        hint.frame = NSRect(x: margin, y: 450, width: contentWidth, height: 18)
        root.addSubview(hint)
        self.hintLabel = hint

        let separator = NSView(frame: NSRect(x: margin, y: 436, width: contentWidth, height: 1))
        separator.wantsLayer = true
        separator.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.10).cgColor
        root.addSubview(separator)

        // ── 日程列表
        let listScroll = NSScrollView(frame: NSRect(x: margin, y: 64, width: contentWidth, height: 362))
        listScroll.drawsBackground = false
        listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.scrollerStyle = .overlay
        listScroll.borderType = .noBorder
        let container = FlippedView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 1))
        container.autoresizingMask = [.width]
        listScroll.documentView = container
        root.addSubview(listScroll)
        self.listScroll = listScroll
        self.listContainer = container

        // ── 底栏
        let status = NSTextField(labelWithString: "")
        status.font = NSFont.systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 2
        status.frame = NSRect(x: margin, y: 16, width: contentWidth - 88, height: 34)
        root.addSubview(status)
        self.statusLabel = status

        let clear = NSButton(title: "清空", target: self, action: #selector(clearAll))
        clear.frame = NSRect(x: width - margin - 68, y: 20, width: 68, height: 26)
        clear.isBordered = false
        clear.font = NSFont.systemFont(ofSize: 12)
        clear.contentTintColor = .secondaryLabelColor
        root.addSubview(clear)

        // 先定尺寸再装内容，否则从「设置」切回主界面时内容会用旧尺寸排一次
        window.setContentSize(NSSize(width: width, height: height))
        installContent(root)
        applyDemoAppearance()
        if !didLayoutMain {
            window.center()
            didLayoutMain = true
        }
        window.makeFirstResponder(textView)
        // 打开就停在输入框上，卡片直接是「正在输入」的状态
        card.focused = true
        updateBadge()
        updateModelLabel()
        refreshAgenda()
        // 从设置页自动恢复过来的话，把「已重新连上」补回新的状态栏
        if let note = pendingStatusNote {
            statusLabel?.textColor = .secondaryLabelColor
            statusLabel?.stringValue = note
            pendingStatusNote = nil
        }
    }

    /// 状态点 + 副标题：星期四 · 已连接 · 模型待命
    private func updateSubtitle() {
        var parts = [Format.weekday()]
        parts.append(offline ? "离线" : "已连接")
        if pending > 0 { parts.append("\(pending) 条待同步") }
        if let used = modelUsed {
            parts.append(used)
        } else if modelEnabled {
            parts.append(LocalModel.shared.phase == .ready ? "模型待命" : "模型预热中")
        } else {
            parts.append("仅规则")
        }

        subtitle?.stringValue = parts.joined(separator: "  ·  ")
        subtitle?.textColor = offline ? .systemOrange : .secondaryLabelColor

        var tip = offline ? "现在连不上 iCloud。日程先存本地，正在自动重试；网络一恢复就立刻补发。" : "已连上 iCloud，日程直接写进日历。"
        if pending > 0 { tip += "（本地队列里还有 \(pending) 条）" }
        subtitle?.toolTip = tip
    }

    /// 状态灯 + 副标题：在线绿灯，离线橙灯
    private func updateBadge() {
        dot?.online = !offline
        dot?.color = offline ? .systemOrange : .systemGreen
        dot?.toolTip = offline ? "连不上 iCloud，日程先存本地" : "已连上 iCloud"
        updateSubtitle()
    }

    /// 启动时把上次离线暂存的日程补发出去
    private func syncPending() {
        Engine.call(["sync", "--json"]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result, (payload["ok"] as? Bool) != nil else { return }
            let remaining = payload["remaining"] as? Int ?? 0
            let synced = payload["synced"] as? Int ?? 0
            self.pending = remaining
            if synced > 0 {
                self.offline = false
                self.statusLabel?.textColor = .secondaryLabelColor
                self.statusLabel?.stringValue = "已补发 \(synced) 条离线日程。"
            }
            // 队列空的时候 sync 根本不会碰网络，所以「补发成功」不能当作在线的证据；
            // 反过来，补发时撞上网络错误才是真的还断着。
            let problems = payload["problems"] as? [[String: Any]] ?? []
            if problems.contains(where: { $0["network"] as? Bool == true }) { self.markOffline() }
            self.updateBadge()
        }
    }

    // MARK: 联网状态

    /// 网络类错误的中文说法（对应 caldav.mjs 的 networkMessage）。
    /// 只有这几种值得等；认证失败、日历不存在再怎么重试也不会好。
    private func isNetworkNote(_ note: String) -> Bool {
        ["连不上网络", "网络连接被中断", "网络超时", "网络不可用"].contains { note.contains($0) }
    }

    /// 监听系统网络路径：Wi-Fi / 有线一恢复就立刻探一次，不用等 15 秒的轮询
    private func startNetworkWatch() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let satisfied = path.status == .satisfied
                defer { self.lastPathSatisfied = satisfied }
                // 状态没变就别再探了，真正的兜底交给 15 秒的轮询
                if let last = self.lastPathSatisfied, last == satisfied { return }
                if satisfied {
                    if ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1" {
                        FileHandle.standardError.write(Data("PROBE path satisfied\n".utf8))
                    }
                    self.probeConnection()
                } else {
                    self.markOffline()
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "dsh.cal.path"))
        pathMonitor = monitor
    }

    private func startReconnectWatch() {
        guard reconnectTimer == nil else { return }
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            if ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1" {
                FileHandle.standardError.write(Data("PROBE timer fire\n".utf8))
            }
            self?.probeConnection()
        }
        timer.tolerance = 5
        // 挂到 .common 上，拖窗口、拉菜单时也继续跑（默认模式会被这些操作挂起）
        RunLoop.main.add(timer, forMode: .common)
        reconnectTimer = timer
    }

    private func stopReconnectWatch() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
    }

    private func markOffline() {
        guard configured || setupFromNetwork else { return }
        if !offline {
            offline = true
            updateBadge()
        }
        startReconnectWatch()
    }

    private func markOnline() {
        stopReconnectWatch()
        let recovered = offline || setupFromNetwork
        offline = false
        setupFromNetwork = false
        updateBadge()
        guard recovered else { return }
        guard configured else {
            // 之前只看到「连不上网络」的设置页，现在重读一次配置，能进主界面就进
            pendingStatusNote = "已重新连上 iCloud。"
            refreshConfig()
            return
        }
        statusLabel?.textColor = .secondaryLabelColor
        statusLabel?.stringValue = "已重新连上 iCloud。"
        refreshAgenda()
        syncPending()
    }

    /// 打一次真实的 CalDAV 请求（`cals`）来判断到底通不通。
    /// 只看网卡状态不够：Wi-Fi 连着、但其实没有出口的时候，日历照样写不进去。
    private func probeConnection() {
        guard !probing, configured || setupFromNetwork else { return }
        if ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1" {
            FileHandle.standardError.write(Data("PROBE trigger\n".utf8))
        }
        probing = true
        Engine.call(["cals", "--json"]) { [weak self] result in
            guard let self else { return }
            self.probing = false
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                if payload["offline"] as? Bool == true { self.markOffline() } else { self.markOnline() }
            case .success(let payload):
                let note = payload["error"] as? String ?? ""
                if self.isNetworkNote(note) {
                    self.setupFromNetwork = true
                    self.startReconnectWatch()
                } else {
                    self.stopReconnectWatch()   // 配置或认证问题，别空转
                }
            case .failure:
                break   // 引擎自己出问题，不下结论，等下一次
            }
        }
    }

    /// 让标签胶囊切到某个日历（列表里没有就补进去）
    private func selectCalendar(_ name: String) {
        currentCalendar = name
        picker?.colors = calendarColors
        picker?.select(name)
    }

    // MARK: 首次配置界面

    private func buildSetup(
        note: String,
        heading: String = "先接上 iCloud 日历",
        actionTitle: String = "连接",
        email prefillEmail: String = "",
        calendar prefillCalendar: String = "学习",
        noteColor: NSColor = .systemRed,
        showsAppearance: Bool = false
    ) {
        // 从「设置…」打开时，底下多一块外观开关；首次连接时不需要，留白就好
        let lift: CGFloat = showsAppearance ? 100 : 0
        let height: CGFloat = 330 + lift

        let root = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: height))
        root.wantsLayer = true

        let title = makeLabel(heading, size: 19, weight: .semibold, color: .labelColor)
        title.frame = NSRect(x: 24, y: 276 + lift, width: 480, height: 26)
        root.addSubview(title)

        let desc = makeLabel(
            "密码填「App 专用密码」（appleid.apple.com → 登录与安全 → App 专用密码），它会被存进系统钥匙串，这个 App 不保存。留空表示沿用已存的密码，只改默认日历。",
            size: 12, weight: .regular, color: .secondaryLabelColor
        )
        desc.frame = NSRect(x: 24, y: 224 + lift, width: 512, height: 44)
        desc.lineBreakMode = .byWordWrapping
        desc.maximumNumberOfLines = 3
        root.addSubview(desc)

        let email = NSTextField(frame: NSRect(x: 24, y: 182 + lift, width: 512, height: 26))
        email.placeholderString = "Apple ID 邮箱"
        email.stringValue = prefillEmail
        email.font = NSFont.systemFont(ofSize: 13)
        root.addSubview(email)

        let password = NSSecureTextField(frame: NSRect(x: 24, y: 144 + lift, width: 512, height: 26))
        password.placeholderString = "App 专用密码 xxxx-xxxx-xxxx-xxxx（留空则不改）"
        password.font = NSFont.systemFont(ofSize: 13)
        root.addSubview(password)

        let calendarLabel = makeLabel("默认日历", size: 12, weight: .regular, color: .secondaryLabelColor)
        calendarLabel.frame = NSRect(x: 24, y: 110 + lift, width: 88, height: 18)
        root.addSubview(calendarLabel)

        let calendarField = NSTextField(frame: NSRect(x: 116, y: 106 + lift, width: 420, height: 26))
        calendarField.stringValue = prefillCalendar.isEmpty ? "学习" : prefillCalendar
        calendarField.font = NSFont.systemFont(ofSize: 13)
        root.addSubview(calendarField)

        let status = makeLabel(note, size: 12, weight: .regular, color: noteColor)
        status.frame = NSRect(x: 24, y: 52 + lift, width: 380, height: 34)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 2
        root.addSubview(status)

        let connect = GlassButton(frame: NSRect(x: 440, y: 52 + lift, width: 96, height: 34))
        connect.title = actionTitle
        connect.target = self
        connect.action = #selector(doConnect)
        connect.keyEquivalent = "\r"
        root.addSubview(connect)

        if showsAppearance {
            buildAppearanceSection(in: root)
        }

        setupEmail = email
        setupPassword = password
        setupCalendar = calendarField
        setupStatus = status

        window.setContentSize(NSSize(width: 560, height: height))
        window.center()
        installContent(root)
        // 首次连接可以直接开始打字；从设置进来时别抢占焦点（会把整段邮箱选中）
        if !showsAppearance { window.makeFirstResponder(email) }
        applyDemoAppearance()
    }

    /// 设置页底部的外观开关。改完立刻存进 UserDefaults，回到主界面就按新设置重建。
    private func buildAppearanceSection(in root: NSView) {
        let divider = NSBox(frame: NSRect(x: 24, y: 118, width: 512, height: 1))
        divider.boxType = .separator
        root.addSubview(divider)

        let caption = makeLabel("外观", size: 12, weight: .semibold, color: .secondaryLabelColor)
        caption.frame = NSRect(x: 24, y: 92, width: 120, height: 18)
        root.addSubview(caption)

        root.addSubview(appearanceRow(
            title: "输入框染色",
            detail: "按「标题 → 时间 → 地点 → 标签」铺一层渐变",
            on: tintEnabled,
            action: #selector(settingsTintChanged(_:)),
            y: 58
        ))
        root.addSubview(appearanceRow(
            title: "输入框光圈",
            detail: "外面绕一圈会慢慢转的彩色辉光",
            on: glowEnabled,
            action: #selector(settingsGlowChanged(_:)),
            y: 22
        ))
    }

    private func appearanceRow(
        title: String,
        detail: String,
        on: Bool,
        action: Selector,
        y: CGFloat
    ) -> NSView {
        let row = NSView(frame: NSRect(x: 24, y: y, width: 512, height: 28))

        let label = makeLabel(title, size: 13, weight: .regular, color: .labelColor)
        label.frame = NSRect(x: 0, y: 4, width: 96, height: 20)
        row.addSubview(label)

        let sub = makeLabel(detail, size: 11.5, weight: .regular, color: .secondaryLabelColor)
        sub.frame = NSRect(x: 104, y: 5, width: 350, height: 18)
        sub.lineBreakMode = .byTruncatingTail
        row.addSubview(sub)

        let toggle = SoftSwitch(frame: NSRect(x: 474, y: 2, width: 38, height: 22))
        toggle.on = on
        toggle.target = self
        toggle.action = action
        row.addSubview(toggle)

        return row
    }

    @objc private func settingsTintChanged(_ sender: SoftSwitch) {
        setTint(sender.on, note: false)
    }

    @objc private func settingsGlowChanged(_ sender: SoftSwitch) {
        setGlow(sender.on, note: false)
    }

    @objc private func doConnect() {
        guard let email = setupEmail,
              let password = setupPassword,
              let calendarField = setupCalendar,
              let status = setupStatus else { return }

        let account = email.stringValue.trimmingCharacters(in: .whitespaces)
        let secret = password.stringValue
        guard !account.isEmpty else {
            status.stringValue = "Apple ID 邮箱要填。"
            return
        }
        status.textColor = .secondaryLabelColor

        // 密码留空 = 只改设置（默认日历 / 账号），沿用钥匙串里的密码，不重新登录。
        if secret.isEmpty {
            status.stringValue = "正在保存…"
            Engine.call(["config", "--user", account, "--calendar", calendarField.stringValue, "--json"]) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let payload) where (payload["ok"] as? Bool) == true:
                    self.refreshConfig()
                case .success(let payload):
                    status.textColor = .systemRed
                    status.stringValue = payload["error"] as? String ?? "保存失败"
                case .failure(let error):
                    status.textColor = .systemRed
                    status.stringValue = error.localizedDescription
                }
            }
            return
        }

        status.stringValue = "正在连接…"

        Engine.call(
            ["login", "--user", account, "--calendar", calendarField.stringValue, "--json"],
            env: ["DSH_CAL_PASSWORD": secret]
        ) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                self.refreshConfig()
            case .success(let payload):
                status.textColor = .systemRed
                status.stringValue = payload["error"] as? String ?? "连接失败"
            case .failure(let error):
                status.textColor = .systemRed
                status.stringValue = error.localizedDescription
            }
        }
    }

    // MARK: 输入与预览

    func controlTextDidChange(_ notification: Notification) { inputChanged() }

    func textDidChange(_ notification: Notification) {
        // 上色会改 textStorage，别让它再触发一次解析
        guard !isHighlighting else { return }
        inputChanged()
    }

    func textDidBeginEditing(_ notification: Notification) {
        inputCard?.focused = true
    }

    func textDidEndEditing(_ notification: Notification) {
        inputCard?.focused = false
    }

    /// 回车即写入，不用去够按钮
    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            addEvent()
            return true
        }
        return false
    }

    private func inputChanged() {
        placeholderLabel?.isHidden = !(input?.string.isEmpty ?? true)
        parseWork?.cancel()
        // 改了文字就重新识别标签，让句子里的标签重新生效
        manualOverride = false
        // 光圈跟着呼吸一下：有反应，但不是闪烁
        inputCard?.pulseGlow()
        let work = DispatchWorkItem { [weak self] in self?.parseNow() }
        parseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    /// 只读本地队列，不碰网络
    private func refreshPending() {
        Engine.call(["pending", "--json"]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result else { return }
            self.pending = payload["count"] as? Int ?? 0
            self.updateBadge()
            if !self.offline { self.syncPending() }
        }
    }

    private func parseNow() {
        guard let input else { return }
        let snapshot = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !snapshot.isEmpty else {
            resetPreview(message: "")
            detectedTag = nil
            return
        }
        // --fast：先只跑规则，保证打字时预览立刻有反馈
        Engine.call(parseArgs(snapshot, model: false)) { [weak self] result in
            guard let self, self.isCurrent(snapshot) else { return }
            self.applyPreview(result)

            // 规则结果可疑（缺地点、标题脏、残留时间词）就让本地模型兜一次；
            // 判定统一放在解析器里（needsModel），App 这边只消费，避免两处逻辑走偏。
            if case .success(let payload) = result,
               (payload["ok"] as? Bool) == true,
               (payload["needsModel"] as? Bool) == true,
               self.modelEnabled {
                if LocalModel.shared.phase == .ready {
                    self.refinePreview(snapshot)
                } else {
                    // 模型还在加载：先记着这句，加载完自动补，不用重打
                    self.pendingRefine = snapshot
                }
            }
        }
    }

    private func parseArgs(_ snapshot: String, model: Bool) -> [String] {
        ["parse", snapshot, "--cals", calendars.joined(separator: ","), model ? "--llm" : "--fast", "--json"]
    }

    private func debug(_ text: String) {
        guard ProcessInfo.processInfo.environment["DSH_CAL_DEBUG"] == "1" else { return }
        FileHandle.standardError.write(Data("[\(text)]\n".utf8))
    }

    private func isCurrent(_ snapshot: String) -> Bool {
        input?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) == snapshot
    }

    /// 慢路径：让模型理解整句（标题 + 地点），时间仍用规则算出来的。
    private func refinePreview(_ snapshot: String) {
        let started = Date()
        // 模型在「想」的时候，光圈亮一下——它确实在做一件事
        inputCard?.pulseGlow()
        Engine.call(parseArgs(snapshot, model: true)) { [weak self] result in
            guard let self, self.isCurrent(snapshot) else { return }
            guard case .success(let payload) = result else {
                self.debug("refine 失败")
                return
            }
            if let by = payload["byModel"] as? String, !by.isEmpty {
                let seconds = Date().timeIntervalSince(started)
                self.modelUsed = String(format: "已调用模型 · %.1fs", seconds)
                self.updateModelLabel()
                self.modelLabel?.toolTip = "\(by)，负责理解句子（标题和地点）；时间永远是规则算的。"
                self.debug("refine 用上了模型 \(by)，耗时 \(Int(seconds * 1000))ms")
                // 模型可能只把标题改干净、没有地点（「…交个作业」），不能因为地点为空就丢弃结果
                self.applyPreview(.success(payload))
            } else {
                self.debug("refine 没有结果，保持规则输出")
            }
        }
    }

    private func applyPreview(_ result: Result<[String: Any], Error>) {
        switch result {
        case .success(let payload) where (payload["ok"] as? Bool) == true:
            let title = payload["title"] as? String ?? ""
            var when = payload["local"] as? String ?? ""
            // 没说哪天的句子、时间今天已经过了 → 引擎会顺延到明天，这里标一下，免得看着像算错
            if payload["rolled"] as? Bool == true { when += "（顺延）" }
            let place = payload["location"] as? String ?? ""
            let tag = payload["calendar"] as? String ?? ""

            if tag.isEmpty {
                detectedTag = nil
            } else {
                detectedTag = tag
                if !manualOverride { selectCalendar(tag) }
            }

            // 片段位置 → 给原文上色
            currentSpans = (payload["spans"] as? [[String: Any]])?.compactMap { item in
                guard let start = item["start"] as? Int,
                      let end = item["end"] as? Int,
                      let kind = item["kind"] as? String,
                      end > start else { return nil }
                return Span(start: start, end: end, kind: kind)
            } ?? []
            applyHighlight()

            // 胶囊：把「被识别成了什么」摆出来，比一行纯文本好扫
            var chips: [(text: String, kind: String)] = []
            if !title.isEmpty { chips.append((title, "title")) }
            chips.append((when, "time"))
            if let repeatInfo = payload["repeat"] as? [String: Any] {
                chips.append((Format.repeatText(repeatInfo), "repeat"))
            }
            if !place.isEmpty { chips.append((place, "location")) }
            chips.append((currentCalendar, "tag"))
            if let alarm = payload["alarmMinutes"] as? Int, alarm > 0 {
                chips.append(("提前 \(alarm) 分钟", "alarm"))
            }
            renderChips(chips)
            // 渐变的颜色和顺序，就是这排胶囊的颜色和顺序
            updateTint(chips.map { $0.kind })

            previewStart = ISO.date(payload["start"] as? String ?? "")
            previewEnd = ISO.date(payload["end"] as? String ?? "")
            checkConflict()

            statusLabel?.stringValue = ""
            statusLabel?.textColor = .secondaryLabelColor

        case .success(let payload):
            resetPreview(message: payload["error"] as? String ?? "没读懂这句话", isError: true)
        case .failure(let error):
            resetPreview(message: error.localizedDescription, isError: true)
        }
    }

    private func resetPreview(message: String, isError: Bool = false) {
        currentSpans = []
        applyHighlight()
        renderChips([])
        updateTint([])
        previewStart = nil
        previewEnd = nil
        hintLabel?.stringValue = message
        hintLabel?.textColor = isError ? .systemRed : .secondaryLabelColor
    }

    // MARK: 美化（把输入卡染成胶囊同色的渐变）

    private func updateTint(_ kinds: [String]) {
        tintKinds = kinds
        tintToggle?.kinds = kinds
        applyTint()
    }

    /// 只有开关打开、且这一句至少认出了两种片段时才染色（一种颜色就是一块纯色，不好看）
    private func applyTint() {
        let kinds = (tintEnabled && tintKinds.count > 1) ? tintKinds : []
        inputCard?.tintKinds = kinds
        inputCard?.glowEnabled = glowEnabled
        tintToggle?.on = tintEnabled
    }

    @objc private func toggleTint() {
        setTint(!tintEnabled, note: true)
    }

    @objc private func toggleGlow() {
        setGlow(!glowEnabled, note: true)
    }

    /// 两个外观开关的共同出口：存盘、改菜单勾选、应用到卡片、回一句提示
    private func setTint(_ on: Bool, note: Bool) {
        tintEnabled = on
        UserDefaults.standard.set(on, forKey: "tintInputCard")
        tintMenuItem?.state = on ? .on : .off
        applyTint()
        guard note else { return }
        hintLabel?.stringValue = on
            ? "美化已开：输入框按「标题 → 时间 → 地点 → 标签」的顺序染色"
            : "美化已关：输入框回到素玻璃"
        hintLabel?.textColor = .secondaryLabelColor
    }

    private func setGlow(_ on: Bool, note: Bool) {
        glowEnabled = on
        UserDefaults.standard.set(on, forKey: "glowInputCard")
        glowMenuItem?.state = on ? .on : .off
        inputCard?.glowEnabled = on
        guard note else { return }
        hintLabel?.stringValue = on
            ? "光圈已开：输入框外面会绕一圈跟胶囊同色的辉光"
            : "光圈已关：卡片外面恢复干净"
        hintLabel?.textColor = .secondaryLabelColor
    }

    // MARK: 原文高亮

    private func applyHighlight() {
        guard let textView = input, let storage = textView.textStorage else { return }
        // 输入法拼字时动 textStorage 会打断候选窗
        guard !textView.hasMarkedText() else { return }

        let length = storage.length
        let selected = textView.selectedRange()
        isHighlighting = true
        storage.beginEditing()
        storage.addAttribute(.font, value: NSFont.systemFont(ofSize: 16), range: NSRange(location: 0, length: length))
        storage.addAttribute(.foregroundColor, value: NSColor.labelColor, range: NSRange(location: 0, length: length))
        storage.addAttribute(.backgroundColor, value: NSColor.clear, range: NSRange(location: 0, length: length))

        // 用 ink 而不是原色：卡片染成同一套颜色之后，同色叠同色就糊了。
        // 深浅色下「往哪边偏」是反的，所以按文本框当前外观定一档。
        let appearance = textView.effectiveAppearance
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        appearance.performAsCurrentDrawingAppearance {
            for span in currentSpans {
                guard span.end <= length else { continue }
                let range = NSRange(location: span.start, length: span.end - span.start)
                let color = Theme.ink(for: span.kind, dark: dark)
                storage.addAttribute(.foregroundColor, value: color, range: range)
                storage.addAttribute(.backgroundColor, value: color.withAlphaComponent(0.14), range: range)
            }
        }
        storage.endEditing()
        isHighlighting = false

        textView.typingAttributes = [
            .font: NSFont.systemFont(ofSize: 16),
            .foregroundColor: NSColor.labelColor,
        ]
        if NSMaxRange(selected) <= storage.length { textView.selectedRange = selected }
    }

    // MARK: 识别胶囊

    private func renderChips(_ chips: [(text: String, kind: String)]) {
        guard let row = chipRow else { return }
        row.subviews.forEach { $0.removeFromSuperview() }
        var x: CGFloat = 0
        var index = 0
        // 右边要给「美化」开关留位置，胶囊别压上去
        let limit = row.bounds.width - 58
        for (text, kind) in chips {
            let chip = ChipView(text: text, kind: kind)
            let width = chip.fittingSize.width
            if x + width > limit { break }
            chip.frame = NSRect(x: x, y: 0, width: width, height: 24)
            row.addSubview(chip)
            // 从左往右依次弹出来，读起来像「一个个被认出来」
            Motion.spring(chip, delay: Double(index) * 0.035)
            index += 1
            x += width + 6
        }
    }

    // MARK: 冲突提示

    /// 用已经拉下来的列表做区间比较，不额外发请求
    private func checkConflict() {
        guard let start = previewStart, let end = previewEnd else { return }
        let hits = agenda.filter { $0.start < end && $0.end > start }

        if let first = hits.first {
            let extra = hits.count > 1 ? " 等 \(hits.count) 条" : ""
            hintLabel?.stringValue = "这个时间和「\(first.title)」重叠\(extra)"
            hintLabel?.textColor = .systemOrange
            return
        }
        guard !(input?.string.isEmpty ?? true) else { return }

        // agenda 只装了最近一周：更远的时间得单独查一次，
        // 否则「下个月 5 号」这种永远检测不到冲突，界面会安静地漏报。
        let today = Calendar.current.startOfDay(for: Date())
        let days = Calendar.current.dateComponents(
            [.day],
            from: today,
            to: Calendar.current.startOfDay(for: start)
        ).day ?? 0
        guard days > 6, days <= 90 else {
            hintLabel?.stringValue = ""
            return
        }
        let key = "\(start.timeIntervalSince1970)-\(end.timeIntervalSince1970)"
        guard key != remoteConflictKey else { return }
        remoteConflictKey = key

        Engine.call(["ls", "--days", "\(days + 1)", "--from", "today", "--json"]) { [weak self] result in
            guard let self, self.remoteConflictKey == key else { return }
            guard case .success(let payload) = result, (payload["ok"] as? Bool) == true else { return }
            let events = (payload["events"] as? [[String: Any]]) ?? []
            let found = events.compactMap { AgendaItem(json: $0) }
                .filter { $0.start < end && $0.end > start }
            guard let first = found.first else { return }
            let extra = found.count > 1 ? " 等 \(found.count) 条" : ""
            self.hintLabel?.stringValue = "这个时间和「\(first.title)」重叠\(extra)"
            self.hintLabel?.textColor = .systemOrange
        }
    }

    // MARK: 日程列表

    private func refreshAgenda() {
        Engine.call(["ls", "--days", "7", "--from", "today", "--json"]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result, (payload["ok"] as? Bool) == true else {
                // 断网时读不到云端，列表会空着。以前这里直接 return，
                // 界面就显示「接下来几天没有安排」——把断网说成了没安排。
                if self.offline {
                    self.agenda = []
                    self.agendaNote = "离线，暂时读不到云端的日程。"
                    self.renderAgenda()
                }
                return
            }
            let events = (payload["events"] as? [[String: Any]]) ?? []
            self.agendaNote = nil
            self.agenda = events.compactMap { AgendaItem(json: $0) }
            self.renderAgenda()
            self.checkConflict()
        }
    }

    private func color(for calendar: String) -> NSColor {
        if let custom = calendarColors[calendar] { return custom }
        return .systemBlue
    }

    private func renderAgenda() {
        guard let container = listContainer else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        let width = max(container.bounds.width, 400)
        var y: CGFloat = 4
        var lastDay = ""
        var order = 0

        if agenda.isEmpty {
            let empty = NSTextField(labelWithString: agendaNote ?? "接下来几天没有安排。")
            empty.font = NSFont.systemFont(ofSize: 13)
            empty.textColor = .tertiaryLabelColor
            empty.frame = NSRect(x: 2, y: 12, width: width - 4, height: 20)
            container.addSubview(empty)
            y = 44
        } else {
            for item in agenda {
                let key = Format.dayKey(item.start)
                if key != lastDay {
                    lastDay = key
                    let header = AgendaHeaderView(text: Format.dayTitle(item.start), width: width)
                    header.frame = NSRect(x: 0, y: y, width: width, height: 36)
                    container.addSubview(header)
                    y += 36
                }
                let row = AgendaRowView(item: item, tint: color(for: item.calendar), width: width)
                row.frame = NSRect(x: 0, y: y, width: width, height: 58)
                row.onDelete = { [weak self] in self?.deleteItem(item) }
                row.onShift = { [weak self] seconds in self?.shiftItem(item, by: seconds) }
                container.addSubview(row)
                Motion.fade(row, duration: 0.26, delay: Double(order) * 0.012)
                order += 1
                if item.uid == highlightUID {
                    highlightUID = nil
                    // 等这一帧画完再闪，否则动画会跟着首帧一起被吃掉
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
                        Motion.flash(row, color: self.color(for: item.calendar))
                    }
                }
                y += 58
            }
            y += 6
        }

        container.frame = NSRect(x: 0, y: 0, width: width, height: max(y, 44))
    }

    private func deleteItem(_ item: AgendaItem) {
        Engine.call(["rm", item.uid, "--json"]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                self.hintLabel?.textColor = .secondaryLabelColor
                self.hintLabel?.stringValue = "已删除「\(item.title)」"
                self.refreshAgenda()
            default:
                self.hintLabel?.textColor = .systemRed
                self.hintLabel?.stringValue = "删除失败，可能已经不在日历里了"
            }
        }
    }

    /// 就地挪动一条日程。起止一起改，否则会变成 end 早于 start 的非法区间。
    private func shiftItem(_ item: AgendaItem, by seconds: TimeInterval) {
        let start = item.start.addingTimeInterval(seconds)
        let end = item.end.addingTimeInterval(seconds)
        let formatter = ISO8601DateFormatter()

        Engine.call([
            "update", item.uid,
            "--start", formatter.string(from: start),
            "--end", formatter.string(from: end),
            "--json",
        ]) { [weak self] result in
            guard let self else { return }
            if case .success(let payload) = result, (payload["ok"] as? Bool) == true {
                self.hintLabel?.textColor = .secondaryLabelColor
                self.hintLabel?.stringValue = "已把「\(item.title)」挪到 \(Format.dayTitle(start)) \(Format.time(start))"
                self.refreshAgenda()
            } else {
                self.hintLabel?.textColor = .systemRed
                self.hintLabel?.stringValue = "改期失败，检查一下网络"
            }
        }
    }

    /// 用户手动挑了标签：之后这一句就不跟着句子里的 #标签 走了
    private func calendarSelected(_ name: String) {
        manualOverride = true
        currentCalendar = name
        picker?.colors = calendarColors
        picker?.select(name)
        parseNow()
    }

    @objc private func clearAll() {
        input?.stringValue = ""
        resetPreview(message: "")
        placeholderLabel?.isHidden = false
        statusLabel?.stringValue = ""
        statusLabel?.textColor = .secondaryLabelColor
        if let input { window.makeFirstResponder(input) }
    }

    @objc private func focusInput() {
        guard let input else { return }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        clearAll()
        window?.makeFirstResponder(input)
    }

    @objc private func recheckNow() {
        statusLabel?.textColor = .secondaryLabelColor
        statusLabel?.stringValue = "正在检查连接…"
        refreshConfig()
    }

    @objc private func syncNowAction() {
        statusLabel?.textColor = .secondaryLabelColor
        statusLabel?.stringValue = "正在补发离线日程…"
        syncPending()
    }

    @objc private func reloadModel() {
        statusLabel?.textColor = .secondaryLabelColor
        statusLabel?.stringValue = "正在重新加载本地模型…"
        LocalModel.shared.reload()
    }

    @objc private func addEvent() {
        guard let input else { return }
        let snapshot = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !snapshot.isEmpty else { return }

        addButton?.isEnabled = false
        statusLabel?.textColor = .secondaryLabelColor
        statusLabel?.stringValue = "正在写入…"

        // 提交前再解析一次：用户可能打完字立刻回车，防抖里的那次解析还没回来。
        // 这样句子里写的 #标签 一定生效，同时手动选过的标签优先级更高。
        Engine.call(parseArgs(snapshot, model: false)) { [weak self] result in
            guard let self else { return }
            var target = self.currentCalendar
            if !self.manualOverride,
               case .success(let parsed) = result,
               let tag = parsed["calendar"] as? String, !tag.isEmpty {
                target = tag
                self.selectCalendar(tag)
            }
            self.send(snapshot, calendar: target)
        }
    }

    private func send(_ snapshot: String, calendar: String) {
        // 模型还没加载好就别让它等：这次写入只用规则，避免按了回车卡十几秒
        var addArgs = ["add", snapshot, "--calendar", calendar, "--json"]
        if LocalModel.shared.phase != .ready { addArgs.insert("--fast", at: addArgs.count - 1) }
        Engine.call(addArgs) { [weak self] result in
            guard let self else { return }
            self.addButton?.isEnabled = true
            switch result {
            case .success(let payload) where (payload["ok"] as? Bool) == true:
                let title = payload["title"] as? String ?? ""
                let calendar = payload["calendar"] as? String ?? self.currentCalendar
                self.input?.stringValue = ""
                self.resetPreview(message: "")
                self.placeholderLabel?.isHidden = false
                self.highlightUID = (payload["uid"] as? String) ?? (payload["id"] as? String)
                self.refreshAgenda()
                if (payload["queued"] as? Bool) == true {
                    self.pending = payload["pending"] as? Int ?? (self.pending + 1)
                    self.markOffline()
                    self.statusLabel?.textColor = .systemOrange
                    self.statusLabel?.stringValue = "离线，已暂存本地：\(title)\n联网后自动补发到「\(calendar)」。"
                } else {
                    self.offline = false
                    self.updateBadge()
                    self.stopReconnectWatch()
                    self.statusLabel?.textColor = .secondaryLabelColor
                    self.statusLabel?.stringValue = "已添加到「\(calendar)」：\(title)"
                }
            case .success(let payload):
                self.statusLabel?.textColor = .systemRed
                self.statusLabel?.stringValue = payload["error"] as? String ?? "写入失败"
            case .failure(let error):
                self.statusLabel?.textColor = .systemRed
                self.statusLabel?.stringValue = error.localizedDescription
            }
        }
    }

    // MARK: 工具

    private func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        return label
    }

    /// 玻璃外壳只建一次，之后所有界面都换到里面的 slot 上
    private func makeShell() {
        let shell = BackdropView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 760, height: 720))
        shell.autoresizingMask = [.width, .height]
        shell.layer?.cornerRadius = Glass.windowRadius
        shell.layer?.masksToBounds = true

        let slot = NSView(frame: shell.bounds)
        slot.autoresizingMask = [.width, .height]
        slot.wantsLayer = true
        shell.addSubview(slot)

        window.contentView = shell
        self.shell = shell
        self.slot = slot
    }

    /// 换内容：新内容淡入，旧内容淡出后再摘掉 —— 中间不出现空白帧。
    /// 玻璃壳一直在下面，所以过渡时不会露出透明的空洞。
    private func installContent(_ view: NSView, fade: Bool = true) {
        guard let slot else {
            window.contentView = view
            return
        }
        let previous = slot.subviews.last

        view.frame = slot.bounds
        view.autoresizingMask = [.width, .height]
        view.wantsLayer = true

        slot.addSubview(view)

        let animated = fade && !Motion.reduced
            && ProcessInfo.processInfo.environment["DSH_CAL_NO_FADE"] != "1"
        if animated, let layer = view.layer {
            let anim = CABasicAnimation(keyPath: "opacity")
            anim.fromValue = 0
            anim.toValue = 1
            anim.duration = 0.20
            anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(anim, forKey: "contentIn")

            if let previous {
                let out = CABasicAnimation(keyPath: "opacity")
                out.fromValue = 1
                out.toValue = 0
                out.duration = 0.12
                previous.layer?.add(out, forKey: "contentOut")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                previous?.removeFromSuperview()
            }
        } else {
            for old in slot.subviews where old !== view { old.removeFromSuperview() }
        }
        window.displayIfNeeded()
    }

    private func showMessage(_ text: String) {
        window.setContentSize(NSSize(width: 760, height: 720))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 760, height: 720))
        content.wantsLayer = true

        // 头部先按主界面摆好：第一帧就有日期和大标题，切换时不会像「界面没长全」
        let date = NSTextField(labelWithString: Format.bigDate())
        date.font = NSFont.systemFont(ofSize: 30, weight: .semibold)
        date.textColor = .labelColor
        date.frame = NSRect(x: 28, y: 650, width: 340, height: 40)
        content.addSubview(date)

        let label = makeLabel(text, size: 12, weight: .regular, color: .secondaryLabelColor)
        label.frame = NSRect(x: 46, y: 624, width: 460, height: 17)
        content.addSubview(label)
        installContent(content, fade: false)
    }

    /// `--snapshot <path>`：把窗口内容渲染成 PNG，用于自检界面（无需录屏权限）。
    private func snapshotIfRequested() {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--snapshot"), index + 1 < args.count else { return }
        let path = args[index + 1]
        let demo = ProcessInfo.processInfo.environment
        let base: TimeInterval = demo["DSH_CAL_DEMO_ADD"] == "1"
            ? 4.0
            : (demo["DSH_CAL_DEMO_TEXT"]?.isEmpty == false ? 3.0 : 0.6)
        let delay = demo["DSH_CAL_SNAPSHOT_DELAY"].flatMap(Double.init) ?? base
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.renderSnapshot(to: path)
            NSApp.terminate(nil)
        }
    }

    private func renderSnapshot(to path: String) {
        guard let view = window.contentView, view.bounds.width > 1 else { return }

        // --dump-view：排查看不清/被遮住时用，直接看每个控件在哪、透不透明
        if CommandLine.arguments.contains("--dump-view") {
            dumpTree(view, depth: 0)
        }

        // 离屏渲染时，非 layer-backed 的文本会整块漏掉；截图前统一强制成图层
        forceLayers(view)

        if ProcessInfo.processInfo.environment["DSH_CAL_GLOW_DEBUG"] == "1" {
            if let card = inputCard { print(card.glowDebug()) }
            dumpSwitches(view)
        }

        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let data = rep.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    /// 自检：快照那一刻每个开关的真实状态
    private func dumpSwitches(_ view: NSView) {
        for sub in view.subviews {
            if let toggle = sub as? SoftSwitch {
                print("SoftSwitch on=\(toggle.on) frame=\(toggle.frame)")
            }
            dumpSwitches(sub)
        }
    }

    private func forceLayers(_ view: NSView) {
        view.wantsLayer = true
        for sub in view.subviews where !(sub is NSScrollView) {
            forceLayers(sub)
        }
    }

    private func dumpTree(_ view: NSView, depth: Int) {
        let pad = String(repeating: "  ", count: depth)
        let f = view.frame
        let name = String(describing: type(of: view))
        var extra = "\(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))"
        if view.alphaValue < 0.99 { extra += " alpha=\(String(format: "%.2f", view.alphaValue))" }
        if view.isHidden { extra += " hidden" }
        if view is StatusDot {
            let layers = view.layer?.sublayers ?? []
            let running = layers.filter { !($0.animationKeys() ?? []).isEmpty }.count
            // 动画只体现在 presentation 层上，顺手把当前实际透明度/缩放打出来
            let live = layers.compactMap { layer -> String? in
                guard let shown = layer.presentation(),
                      !(layer.animationKeys() ?? []).isEmpty else { return nil }
                return String(format: "op=%.2f sw=%.2f", shown.opacity, shown.value(forKeyPath: "transform.scale") as? Double ?? 1)
            }
            extra += " [dot anims=\(view.layer?.animationKeys() ?? []) rings=\(running) \(live.joined(separator: " | "))]"
        }
        if let field = view as? NSTextField, !field.stringValue.isEmpty {
            extra += " text=\"\(field.stringValue.prefix(18))\""
        }
        print("\(pad)\(name)  \(extra)")
        for sub in view.subviews { dumpTree(sub, depth: depth + 1) }
    }
}

// MARK: - 状态灯

/// 标题旁边的小圆点：在线绿、离线橙。
/// 呼吸 = 两圈从圆点扩散出去又隐去的光环（CA 层的 scale + opacity 交替），
/// 比原来只改 shadowRadius 明显得多 —— 那个在 7px 的点上几乎看不出来。
final class StatusDot: NSView {
    private let core = CALayer()
    private let rings: [CAShapeLayer] = [CAShapeLayer(), CAShapeLayer()]

    var color: NSColor = .systemGray {
        didSet { applyColor() }
    }
    /// 在线时轻轻呼吸一下，离线保持静止
    var online = false {
        didSet { applyColor() }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // 光环要露到圆点外面
        layer?.masksToBounds = false
        core.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        layer?.addSublayer(core)
        for ring in rings {
            ring.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            ring.opacity = 0
            ring.fillColor = NSColor.clear.cgColor
            layer?.addSublayer(ring)
        }
        syncLayers()
        applyColor()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        layer?.masksToBounds = false
        syncLayers()
        applyColor()
    }

    override func layout() {
        super.layout()
        syncLayers()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        syncLayers()
    }

    private func syncLayers() {
        guard bounds.width > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        core.frame = bounds
        core.cornerRadius = bounds.width / 2
        for ring in rings {
            ring.bounds = CGRect(origin: .zero, size: bounds.size)
            ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
            ring.path = CGPath(
                ellipseIn: CGRect(origin: .zero, size: bounds.size),
                transform: nil
            )
        }
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    private func applyColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            core.backgroundColor = color.cgColor
            core.shadowColor = color.cgColor
            core.shadowOffset = .zero
            core.shadowOpacity = 0.6
            core.shadowRadius = 3
            for ring in rings {
                ring.fillColor = color.cgColor
            }
            CATransaction.commit()
        }
        breathe()
    }

    private func breathe() {
        for ring in rings { ring.removeAllAnimations() }
        core.removeAnimation(forKey: "glow")

        guard online, !Motion.reduced else {
            for ring in rings { ring.opacity = 0 }
            core.opacity = 1
            return
        }

        let period: CFTimeInterval = 2.6
        let now = CACurrentMediaTime()
        for (index, ring) in rings.enumerated() {
            let spread = CABasicAnimation(keyPath: "transform.scale")
            spread.fromValue = 0.9
            spread.toValue = 3.0
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.55
            fade.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [spread, fade]
            group.duration = period
            group.repeatCount = .infinity
            group.beginTime = now + Double(index) * period / 2
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ring.add(group, forKey: "breathe")
        }

        // 圆点本身极轻微地起伏一下，跟光环同一个节奏
        let glow = CABasicAnimation(keyPath: "opacity")
        glow.fromValue = 1
        glow.toValue = 0.78
        glow.duration = period / 2
        glow.autoreverses = true
        glow.repeatCount = .infinity
        glow.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        core.add(glow, forKey: "glow")
    }
}

// MARK: - 数据与格式

/// 解析器返回的一个片段：在原文中的位置 + 类别（date/time/location/tag/repeat/alarm）
struct Span {
    let start: Int
    let end: Int
    let kind: String
}

struct AgendaItem {
    let uid: String
    let title: String
    let start: Date
    let end: Date
    let location: String?
    let calendar: String
    let allDay: Bool

    init?(json: [String: Any]) {
        guard let uid = json["uid"] as? String,
              let title = json["title"] as? String,
              let startText = json["start"] as? String, let start = ISO.date(startText),
              let endText = json["end"] as? String, let end = ISO.date(endText)
        else { return nil }
        self.uid = uid
        self.title = title
        self.start = start
        self.end = end
        self.location = json["location"] as? String
        self.calendar = json["calendar"] as? String ?? ""

        // CalDAV 返回里没有 allDay 字段，用「零点开始、正好一天」来认
        let calendar = Calendar.current
        let components = calendar.dateComponents([.hour, .minute], from: start)
        self.allDay = (json["allDay"] as? Bool)
            ?? (components.hour == 0 && components.minute == 0 && abs(end.timeIntervalSince(start) - 86400) < 60)
    }
}

enum ISO {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    static func date(_ text: String) -> Date? {
        fractional.date(from: text) ?? plain.date(from: text)
    }
}

enum Format {
    static func bigDate() -> String {
        let components = Calendar.current.dateComponents([.month, .day], from: Date())
        return "\(components.month ?? 1)月\(components.day ?? 1)日"
    }

    static func weekday() -> String {
        weekdayOf(Date())
    }

    static func weekdayOf(_ date: Date) -> String {
        let names = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
        let index = Calendar.current.component(.weekday, from: date) - 1
        return names[max(0, min(6, index))]
    }

    static func time(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }

    static func dayKey(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    static func dayTitle(_ date: Date) -> String {
        let calendar = Calendar.current
        let offset = calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: calendar.startOfDay(for: date)).day ?? 0
        let month = calendar.component(.month, from: date)
        let day = calendar.component(.day, from: date)
        switch offset {
        case 0: return "今天 · \(month)月\(day)日"
        case 1: return "明天 · \(month)月\(day)日"
        case 2: return "后天 · \(month)月\(day)日"
        default: return "\(month)月\(day)日  \(weekdayOf(date))"
        }
    }

    static func repeatText(_ info: [String: Any]) -> String {
        let freq = info["freq"] as? String ?? ""
        let byday = info["byday"] as? [String] ?? []
        let interval = info["interval"] as? Int ?? 1
        let names = ["MO": "一", "TU": "二", "WE": "三", "TH": "四", "FR": "五", "SA": "六", "SU": "日"]
        switch freq {
        case "DAILY":
            return interval > 1 ? "每 \(interval) 天" : "每天"
        case "WEEKLY":
            if interval > 1 {
                let tail = byday.isEmpty ? "" : "的" + byday.compactMap { names[$0] }.joined(separator: "、")
                return "每 \(interval) 周\(tail)"
            }
            if byday.isEmpty { return "每周" }
            if Set(byday) == Set(["MO", "TU", "WE", "TH", "FR"]) { return "每个工作日" }
            if Set(byday) == Set(["SA", "SU"]) { return "每周末" }
            return "每周" + byday.compactMap { names[$0] }.joined(separator: "、")
        case "MONTHLY":
            return "每月 \(info["bymonthday"] as? Int ?? 1) 号"
        default:
            return "重复"
        }
    }
}

enum Theme {
    static func color(for kind: String) -> NSColor {
        switch kind {
        case "location": return .systemGreen
        case "tag": return .systemPurple
        case "repeat": return .systemIndigo
        case "alarm": return .systemOrange
        case "allday": return .systemTeal
        case "title": return .secondaryLabelColor
        default: return .systemBlue   // date / time / period / duration
        }
    }

    /// 卡片上真正用来写字的那一档色。
    ///
    /// 底色被染成同一套颜色之后，原文再用原色写就会「同色叠同色」看不清，
    /// 所以文字统一往对比更强的方向偏一档：浅色底压暗、深色底提亮。
    /// 这里返回的是解析过的实色：文本存储里的颜色不会跟着外观自动重算，
    /// 换外观时由 ComposeTextView 回调重刷一遍（见 applyHighlight）。
    static func ink(for kind: String, dark: Bool) -> NSColor {
        // 标题用的是 secondaryLabelColor（本身带 alpha），压在彩色底上会发灰，单独给一档
        if kind == "title" {
            return (dark ? NSColor.white : NSColor.black).withAlphaComponent(0.82)
        }
        let pull: CGFloat = 0.40
        return srgb(color(for: kind)).blended(withFraction: pull, of: srgb(dark ? .white : .black))
            ?? color(for: kind)
    }

    /// 卡片被染的那一层「水彩」：把这个片段的颜色兑进卡片的底色里，
    /// 只留一点点色相 —— 整条渐变是背景，不是主角，字压在上面还得清楚。
    static func wash(for kind: String, dark: Bool) -> NSColor {
        let surface: (r: CGFloat, g: CGFloat, b: CGFloat) = dark
            ? (0.115, 0.115, 0.135)
            : (0.985, 0.985, 1.000)
        // 标题用的是 secondaryLabelColor，它本身带 alpha；直接混会把整段渐变弄成半透明，
        // 底色透上来就成了脏白。先按 alpha 叠到卡片底色上，再往底色里兑。
        let fg = srgb(color(for: kind))
        let a = fg.alphaComponent
        let canvas = (
            r: fg.redComponent * a + surface.r * (1 - a),
            g: fg.greenComponent * a + surface.g * (1 - a),
            b: fg.blueComponent * a + surface.b * (1 - a)
        )
        // 标题本来就是灰的，再往灰里兑就没色了，直接让它接近底色
        let keep: CGFloat = kind == "title" ? (dark ? 0.16 : 0.12) : (dark ? 0.42 : 0.38)
        return NSColor(
            srgbRed: canvas.r * keep + surface.r * (1 - keep),
            green: canvas.g * keep + surface.g * (1 - keep),
            blue: canvas.b * keep + surface.b * (1 - keep),
            alpha: 1
        )
    }

    /// 色谱圆点用的颜色：比 wash 亮得多，只用来告诉人「这条渐变是哪几种颜色」
    static func swatch(for kind: String, dark: Bool) -> NSColor {
        guard kind != "title" else {
            return NSColor(srgbRed: 0.62, green: 0.62, blue: 0.66, alpha: 1)
        }
        return srgb(color(for: kind))
    }

    private static func srgb(_ color: NSColor) -> NSColor {
        color.usingColorSpace(.sRGB) ?? color
    }
}

// MARK: - 自绘容器

/// 从底部翻过来，让子视图按「从上往下」的顺序堆
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// 窗口背景：系统毛玻璃（macOS 26 上系统会把它渲染成新的玻璃材质）。
///
/// 只当背景用，不承载内容 —— 内容作为它的兄弟视图叠在上面，
/// 这样既透得出桌面，也不会把标题、输入框挡住。
final class BackdropView: NSView {
    private var effect: NSVisualEffectView?
    private var tint: NSView?
    private var sheen: CAGradientLayer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        build()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        build()
    }

    override func layout() {
        super.layout()
        sheen?.frame = bounds
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // 窗口尺寸变了（主界面 ↔ 设置），高光层要跟着铺满
        sheen?.frame = bounds
    }

    private func build() {
        wantsLayer = true

        if ProcessInfo.processInfo.environment["DSH_CAL_FLAT"] == "1" {
            update()
            return
        }

        let effect = NSVisualEffectView(frame: bounds)
        effect.autoresizingMask = [.width, .height]
        effect.material = .underWindowBackground
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = Glass.windowRadius
        effect.layer?.masksToBounds = true
        addSubview(effect)
        self.effect = effect

        // 极淡的一层色偏：花哨壁纸上也能压住文字
        let tint = NSView(frame: bounds)
        tint.autoresizingMask = [.width, .height]
        tint.wantsLayer = true
        addSubview(tint)
        self.tint = tint

        // 顶部内高光 + 一圈细亮边，窗口才像一片有厚度的玻璃
        let sheen = CAGradientLayer()
        sheen.frame = bounds
        sheen.colors = [
            NSColor.white.withAlphaComponent(0.16).cgColor,
            NSColor.white.withAlphaComponent(0).cgColor,
        ]
        sheen.locations = [0, 0.42]
        sheen.startPoint = CGPoint(x: 0.5, y: 1)
        sheen.endPoint = CGPoint(x: 0.5, y: 0)
        tint.layer?.addSublayer(sheen)
        self.sheen = sheen

        update()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        update()
    }

    private func update() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if effect == nil {
                // 朴素模式：不透明底色
                layer?.backgroundColor = (dark ? NSColor.windowBackgroundColor : NSColor.textBackgroundColor).cgColor
            } else {
                // 玻璃模式：只加一点点色偏，保持通透
                tint?.layer?.backgroundColor = NSColor.windowBackgroundColor
                    .withAlphaComponent(dark ? 0.20 : 0.30).cgColor
                sheen?.colors = [
                    NSColor.white.withAlphaComponent(dark ? 0.20 : 0.16).cgColor,
                    NSColor.white.withAlphaComponent(0).cgColor,
                ]
            }
        }
    }
}

/// 输入卡的圆角底板：自绘的「玻璃片」——半透明底 + 顶部高光 + 亮边。
/// 不用 NSGlassEffectView 是为了可控：它内部是 SwiftUI 层，叠内容时容易被盖。
///
/// 开「美化」时，中间那层玻璃换成一条横向渐变，**颜色的顺序跟下面那排胶囊一模一样**：
/// 从左到右依次是标题（灰）→ 时间（蓝）→ 地点（绿）→ 标签（紫）。
/// 这样框里的内容跟外面的胶囊共用一套图例，不用再记第二套配色；
/// 渐变只取很淡的色相（大约两成），字压在上面仍然清楚。
final class CardView: NSView {
    private let radius: CGFloat
    private let accent: NSColor?

    /// 正在输入时描边亮起来，一眼看得出焦点在哪
    var focused = false {
        didSet {
            guard focused != oldValue else { return }
            updateLayers(animated: true)
            layer?.shadowOpacity = focused ? 0.16 : 0.10
        }
    }

    /// 渐变要用的片段类型，按胶囊的顺序传进来。空数组 = 一块干净玻璃
    var tintKinds: [String] = [] {
        didSet {
            guard tintKinds != oldValue else { return }
            updateLayers(animated: true)
        }
    }

    /// 光圈开关（设置里那个「输入框光圈」）
    var glowEnabled = false {
        didSet {
            guard glowEnabled != oldValue else { return }
            updateGlow(animated: true)
        }
    }

    /// 暗色下光圈要收一点，不然在近乎黑的底上会糊成一片
    private var glowScale: CGFloat {
        // 同样的透明度，压在亮底上比压在暗底上显眼得多，浅色这边要收一点
        effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? 1.05 : 0.92
    }

    private let wash = CAGradientLayer()     // 彩色水洗（美化）
    private let shade = CAGradientLayer()    // 顶部高光 + 底部暗部，玻璃的厚度
    private let topLine = CAShapeLayer()     // 上沿那道亮线
    private let rim = CAShapeLayer()         // 描边

    // ── 光圈：围着卡片转的一圈彩色辉光，像 Apple 智能那样
    private let glowHost = CALayer()
    private var glowRings: [GlowRing] = []
    /// 光圈向外扩出的距离：辉光需要空间，卡片本身的位置不动。
    /// 要大于最外面那道的线宽（线宽全部落在卡片外侧，见 layoutGlow）。
    private let glowPad: CGFloat = 30
    /// 由外到内的八道环。宽度递减得很密、透明度一层层往上加，
    /// 叠起来就是一条连续衰减的光晕 —— 直接画一根粗描边会像霓虹灯管，
    /// 用「多圈低透明度」硬凑出高斯模糊的那种感觉。
    private let glowSpec: [(width: CGFloat, alpha: CGFloat)] = [
        (28, 0.055), (24, 0.055), (20, 0.065), (16, 0.075),
        (12, 0.085), (9, 0.10), (6, 0.115), (3, 0.135),
    ]

    init(frame: NSRect, cornerRadius: CGFloat = 18, tint: NSColor? = nil, interactive: Bool = false) {
        self.radius = cornerRadius
        self.accent = tint
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay

        // 一点点投影，玻璃片才有「浮在背景上」的感觉
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.10
        layer?.shadowRadius = 12
        layer?.shadowOffset = CGSize(width: 0, height: -2)

        // 三层全部自裁圆角，等价于跟着卡片的形状走，省一个 mask 视图。
        // zPosition 压到负数：它们要盖在底色之上、又必须沉在文本和按钮下面。
        wash.cornerRadius = cornerRadius
        wash.masksToBounds = true
        wash.startPoint = CGPoint(x: 0, y: 0.5)
        wash.endPoint = CGPoint(x: 1, y: 0.5)
        wash.zPosition = -30
        wash.opacity = 0

        shade.cornerRadius = cornerRadius
        shade.masksToBounds = true
        shade.startPoint = CGPoint(x: 0.5, y: 1)
        shade.endPoint = CGPoint(x: 0.5, y: 0)
        shade.locations = [0, 0.34, 1]
        shade.zPosition = -20

        rim.fillColor = NSColor.clear.cgColor
        rim.lineWidth = 1
        rim.zPosition = -10

        topLine.fillColor = NSColor.clear.cgColor
        topLine.lineWidth = 1
        topLine.zPosition = -9

        layer?.addSublayer(wash)
        layer?.addSublayer(shade)
        layer?.addSublayer(rim)
        layer?.addSublayer(topLine)
        buildGlow()
        updateLayers(animated: false)
    }

    required init?(coder: NSCoder) {
        self.radius = 18
        self.accent = nil
        super.init(coder: coder)
        wantsLayer = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        // 深浅色下「压暗/提亮」的方向是反的，整层得按新外观重算
        updateLayers(animated: false)
    }

    override func layout() {
        super.layout()
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        wash.frame = bounds
        shade.frame = bounds
        // 阴影跟着圆角走，不然会是方的
        layer?.shadowPath = CGPath(
            roundedRect: rect,
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        )
        rim.path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

        let line = CGMutablePath()
        line.move(to: CGPoint(x: rect.minX + radius, y: rect.maxY - 0.5))
        line.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.maxY - 0.5))
        topLine.path = line

        layoutGlow()
    }

    // MARK: 光圈

    /// 建四道环。每道环是一个「容器 + 旋转的锥形渐变 + 形状遮罩」：
    /// 遮罩把渐变裁成一圈描边，转的是里面那层渐变，所以看到的是颜色绕着卡片跑。
    private func buildGlow() {
        glowHost.zPosition = -40
        glowHost.opacity = 0
        layer?.addSublayer(glowHost)

        for spec in glowSpec {
            let container = CALayer()
            let spin = CAGradientLayer()
            spin.type = .conic
            spin.startPoint = CGPoint(x: 0.5, y: 0.5)
            spin.endPoint = CGPoint(x: 0.5, y: 1)
            let mask = CAShapeLayer()
            mask.fillColor = NSColor.clear.cgColor
            mask.strokeColor = NSColor.white.cgColor
            mask.lineWidth = spec.width
            container.mask = mask
            container.addSublayer(spin)
            glowHost.addSublayer(container)
            glowRings.append(GlowRing(container: container, spin: spin, beam: mask, alpha: spec.alpha))
        }
    }

    private func layoutGlow() {
        let size = CGSize(width: bounds.width + glowPad * 2, height: bounds.height + glowPad * 2)
        // 不跟着卡片移动，只改尺寸
        glowHost.frame = CGRect(origin: CGPoint(x: -glowPad, y: -glowPad), size: size)

        let cardRect = CGRect(x: glowPad, y: glowPad, width: bounds.width, height: bounds.height)

        // 转的是整块方形渐变，边长至少要盖住对角线，转起来才不会露出角
        let side = ceil(hypot(size.width, size.height)) + 2
        for ring in glowRings {
            ring.container.frame = glowHost.bounds
            ring.beam.frame = glowHost.bounds

            // 描边的中线往外挪半个线宽：这样整条线都落在卡片外面，
            // 光晕不会渗进卡片、把里面那层染色搅浑（浅色下尤其明显）。
            let half = ring.beam.lineWidth / 2
            ring.beam.path = CGPath(
                roundedRect: cardRect.insetBy(dx: -half, dy: -half),
                cornerWidth: radius + half,
                cornerHeight: radius + half,
                transform: nil
            )

            ring.spin.frame = CGRect(
                x: (size.width - side) / 2,
                y: (size.height - side) / 2,
                width: side,
                height: side
            )
        }
    }

    /// 换配色 / 开关 / 深浅色都要重算：颜色、亮度、转速
    private func updateGlow(animated: Bool) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let colors = GlowPalette.conic(dark: dark).map(\.cgColor)
            for ring in glowRings {
                ring.spin.colors = colors
                ring.spin.locations = GlowPalette.stops
                ring.container.opacity = Float(min(1, ring.alpha * glowScale))
            }

            let target: Float = glowEnabled ? 1 : 0
            if animated, !Motion.reduced {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = glowHost.presentation()?.opacity ?? glowHost.opacity
                fade.toValue = target
                fade.duration = 0.34
                fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                glowHost.opacity = target
                glowHost.add(fade, forKey: "glowFade")
            } else {
                glowHost.opacity = target
            }
        }
        spinGlow()
    }

    /// 让颜色绕圈跑。减弱动态效果时停住，只留一圈静止的彩边。
    private func spinGlow() {
        let running = glowEnabled && !Motion.reduced
        for ring in glowRings {
            if running {
                // 正在转就别重开，否则每敲一个字相位就跳一下
                guard ring.spin.animation(forKey: "spin") == nil else { continue }
                let spin = CABasicAnimation(keyPath: "transform.rotation.z")
                spin.fromValue = 0
                spin.toValue = CGFloat.pi * 2
                spin.duration = 9
                spin.repeatCount = .infinity
                spin.timingFunction = CAMediaTimingFunction(name: .linear)
                ring.spin.add(spin, forKey: "spin")
            } else {
                ring.spin.removeAnimation(forKey: "spin")
            }
        }
    }

    /// 自检用：光圈到底转没转，只有看「呈现层」的真实角度才知道
    /// （快照走 cacheDisplay，拿到的是模型值，永远是 0）
    func glowDebug() -> String {
        guard let ring = glowRings.first else { return "no rings" }
        let angle = (ring.spin.presentation()?.value(forKeyPath: "transform.rotation.z") as? CGFloat) ?? -1
        let opacity = glowHost.presentation()?.opacity ?? -1
        return String(
            format: "glow=%@ rings=%d hostOpacity=%.2f ringOpacity=%.2f angle=%.3f spin=%@",
            glowEnabled ? "on" : "off",
            glowRings.count,
            opacity,
            ring.container.opacity,
            angle,
            ring.spin.animation(forKey: "spin") == nil ? "none" : "running"
        )
    }

    /// 敲字 / 模型开始想的时候亮一下：不是常亮的灯，是「有反应」的那种呼吸
    func pulseGlow() {
        guard glowEnabled, !Motion.reduced else { return }
        for ring in glowRings {
            let base = ring.container.opacity
            guard base > 0 else { continue }
            let flash = CABasicAnimation(keyPath: "opacity")
            flash.fromValue = base
            flash.toValue = min(1, base * 2.1 + 0.04)
            flash.duration = 0.3
            flash.autoreverses = true
            flash.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            ring.container.add(flash, forKey: "pulse")
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

            // 玻璃本体：极淡的一层白，靠下面的背景透出来
            NSColor.white.withAlphaComponent(dark ? 0.075 : 0.42).setFill()
            path.fill()

            if let accent {
                accent.withAlphaComponent(dark ? 0.06 : 0.10).setFill()
                path.fill()
            }
        }
    }

    /// 按当前外观重排所有图层。颜色变化用 CA 过渡 —— 一边打字一边换配色时不会「啪」地跳
    private func updateLayers(animated: Bool) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

            var colors = tintKinds.map { Theme.wash(for: $0, dark: dark).cgColor }
            if colors.count == 1 { colors.append(colors[0]) }
            let locations: [NSNumber] = colors.count > 1
                ? (0..<colors.count).map { NSNumber(value: Double($0) / Double(colors.count - 1)) }
                : [0, 1]

            let sameShape = (wash.colors as? [CGColor])?.count == colors.count
            if animated, sameShape, !Motion.reduced, !colors.isEmpty {
                let fade = CABasicAnimation(keyPath: "colors")
                fade.fromValue = wash.presentation()?.colors ?? wash.colors
                fade.toValue = colors
                fade.duration = 0.26
                fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                wash.colors = colors
                wash.add(fade, forKey: "colors")
            } else {
                wash.colors = colors
            }
            wash.locations = locations

            // 没颜色就整层淡出，退回一块干净玻璃
            let target: Float = colors.isEmpty ? 0 : 0.88
            if animated, !Motion.reduced {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = wash.presentation()?.opacity ?? wash.opacity
                fade.toValue = target
                fade.duration = 0.24
                wash.opacity = target
                wash.add(fade, forKey: "opacity")
            } else {
                wash.opacity = target
            }

            // 顶部高光 + 底部暗部合成一层：上亮下暗，卡片才有厚度
            shade.colors = [
                NSColor.white.withAlphaComponent(dark ? 0.05 : 0.26).cgColor,
                NSColor.clear.cgColor,
                NSColor.black.withAlphaComponent(dark ? 0.08 : 0.03).cgColor,
            ]

            // 边：浅色下要压一点灰才看得见边界，暗色下用亮边当折光；
            // 聚焦时换成强调色，焦点一眼可见
            if focused {
                rim.strokeColor = NSColor.controlAccentColor.withAlphaComponent(dark ? 0.45 : 0.34).cgColor
                rim.lineWidth = 1.2
            } else if dark {
                rim.strokeColor = NSColor.white.withAlphaComponent(0.16).cgColor
                rim.lineWidth = 1
            } else {
                rim.strokeColor = NSColor.black.withAlphaComponent(0.08).cgColor
                rim.lineWidth = 1
            }
            topLine.strokeColor = NSColor.white.withAlphaComponent(dark ? 0.18 : 0.85).cgColor

            // 染色时投影也跟着偏一点色，像有一层彩光从卡片里漏出来
            if let last = tintKinds.last {
                layer?.shadowColor = Theme.color(for: last)
                    .blended(withFraction: 0.35, of: .black)?.cgColor ?? NSColor.black.cgColor
            } else {
                layer?.shadowColor = NSColor.black.cgColor
            }

            // 圈的颜色跟深浅色走，一起在这里重算
            updateGlow(animated: false)
        }
    }
}

/// 光圈里的一环：容器负责遮罩，里面那层锥形渐变负责转
private struct GlowRing {
    let container: CALayer
    let spin: CAGradientLayer
    let beam: CAShapeLayer
    let alpha: CGFloat
}

/// 光圈的配色：跟下面那排胶囊同一套，首尾同色所以转起来无缝
enum GlowPalette {
    static let stops: [NSNumber] = [0, 0.25, 0.5, 0.75, 1]

    static func conic(dark: Bool) -> [NSColor] {
        var colors = ["title", "time", "location", "tag"].map { color(for: $0, dark: dark) }
        colors.append(colors[0])
        return colors
    }

    private static func color(for kind: String, dark: Bool) -> NSColor {
        // 标题那档原本是灰的，当光看太闷；提成银灰，四段亮度才拉得平
        if kind == "title" {
            return NSColor(
                srgbRed: dark ? 0.80 : 0.66,
                green: dark ? 0.82 : 0.70,
                blue: dark ? 0.90 : 0.76,
                alpha: 1
            )
        }
        let base = Theme.color(for: kind).usingColorSpace(.sRGB) ?? .white
        return base.blended(withFraction: dark ? 0.16 : 0.04, of: .white) ?? base
    }
}

/// 动效工具：统一节奏，并且尊重系统的「减弱动态效果」
enum Motion {
    static var reduced: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// 有弹性的一下：用来做胶囊出现、按钮回弹。
    /// 透明度用 CA 动画做、model 值始终留在 1 —— 否则离屏渲染/截图时可能停在透明上。
    static func spring(_ view: NSView, from scale: CGFloat = 0.94, duration: TimeInterval = 0.34, delay: TimeInterval = 0) {
        guard !reduced else { view.alphaValue = 1; return }
        view.wantsLayer = true
        view.alphaValue = 1
        guard let layer = view.layer else { return }

        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = scale
        pop.toValue = 1
        pop.damping = 14
        pop.stiffness = 210
        pop.mass = 1
        pop.duration = pop.settlingDuration
        pop.beginTime = CACurrentMediaTime() + delay
        pop.fillMode = .backwards
        layer.add(pop, forKey: "pop")

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.2
        fade.beginTime = CACurrentMediaTime() + delay
        fade.fillMode = .backwards
        layer.add(fade, forKey: "fadeIn")
    }

    /// 轻微的淡入上浮：窗口出现、列表刷新
    static func fade(_ view: NSView, duration: TimeInterval = 0.22, delay: TimeInterval = 0, offset: CGFloat = 0) {
        view.alphaValue = 1
        guard !reduced else { return }

        if offset != 0 {
            let start = view.frame.origin
            view.setFrameOrigin(NSPoint(x: start.x, y: start.y - offset))
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                view.animator().setFrameOrigin(start)
            }
        }

        guard let layer = view.layer else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = duration
        fade.beginTime = CACurrentMediaTime() + delay
        fade.fillMode = .backwards
        layer.add(fade, forKey: "fadeIn")
    }

    /// 写入成功后闪一下：告诉用户「这条真的进了日历」
    static func flash(_ view: NSView, color: NSColor, radius: CGFloat = 10) {
        view.wantsLayer = true
        view.layer?.cornerRadius = radius
        guard let layer = view.layer else { return }
        let pulse = CABasicAnimation(keyPath: "backgroundColor")
        pulse.fromValue = color.withAlphaComponent(0.24).cgColor
        pulse.toValue = NSColor.clear.cgColor
        pulse.duration = reduced ? 0.01 : 1.1
        pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(pulse, forKey: "flash")
    }
}

/// 玻璃胶囊按钮：系统圆角按钮放在玻璃上太「实」，自己画一个更贴。
final class GlassButton: NSButton {
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        isBordered = false
        wantsLayer = true
        focusRingType = .none
        font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        // 按下去略微缩一下，松开弹回来
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.09
            context.allowsImplicitAnimation = true
            layer?.setAffineTransform(CGAffineTransform(scaleX: 0.965, y: 0.965))
        }
        super.mouseDown(with: event)
        pressed = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Motion.reduced ? 0 : 0.28
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            context.allowsImplicitAnimation = true
            layer?.setAffineTransform(.identity)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)

        effectiveAppearance.performAsCurrentDrawingAppearance {
            let base = NSColor.controlAccentColor
            let alpha: CGFloat = pressed ? 0.82 : (hovering ? 1.0 : 0.92)
            base.withAlphaComponent(alpha).setFill()
            path.fill()

            // 顶部一层白色高光，玻璃的「厚度」就是从这来的
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            let gloss = NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: rect.height / 2, yRadius: rect.height / 2)
            NSColor.white.withAlphaComponent(pressed ? 0.06 : (hovering ? 0.22 : 0.16)).setFill()
            gloss.fill()
            NSGraphicsContext.restoreGraphicsState()

            // 一圈更亮的描边
            base.blended(withFraction: 0.45, of: .white)?.withAlphaComponent(0.55).setStroke()
            path.lineWidth = 1
            path.stroke()
        }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let text = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: (bounds.width - text.width) / 2, y: (bounds.height - text.height) / 2),
            withAttributes: attributes
        )
    }
}

enum Glass {
    /// 窗口本身的圆角（macOS 26 窗口约 12）
    static let windowRadius: CGFloat = 12
}

/// 顶部的「标签选择」：一颗液态玻璃胶囊 —— 半透明底 + 一层日历色 + 顶部高光 + 细亮边，
/// 点开是带色点的日历列表。系统 NSPopUpButton 放在玻璃上太「实」，跟整块界面不是一路。
final class CalendarPicker: NSView {
    var calendars: [String] = [] {
        didSet { update() }
    }
    var colors: [String: NSColor] = [:] {
        didSet { update() }
    }
    var current: String = "" {
        didSet {
            label.stringValue = current
            update()
            pop()
        }
    }
    var onPick: ((String) -> Void)?

    private let tintLayer = CALayer()
    private let glossLayer = CAGradientLayer()
    private let chevronLayer = CAShapeLayer()
    private let dotLayer = CALayer()
    private let label = NSTextField(labelWithString: "")
    private var tracking: NSTrackingArea?

    private let font = NSFont.systemFont(ofSize: 12, weight: .medium)
    private let padH: CGFloat = 13
    private let dotSize: CGFloat = 7
    /// 左右内边距 + 色点 + 间距 + 箭头，算宽高时共用
    private let chrome: CGFloat = 13 + 7 + 7 + 13 + 9 + 4

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        // 胶囊浮在玻璃上，给一点极淡的投影
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.12
        layer?.shadowRadius = 7
        layer?.shadowOffset = CGSize(width: 0, height: -1)

        // 每一层都用「圆角 = 半高」自裁，等价于胶囊形，省掉共享 mask 的麻烦
        tintLayer.masksToBounds = true
        glossLayer.masksToBounds = true
        glossLayer.startPoint = CGPoint(x: 0.5, y: 1)
        glossLayer.endPoint = CGPoint(x: 0.5, y: 0.34)
        glossLayer.locations = [0, 1]

        chevronLayer.fillColor = NSColor.clear.cgColor
        chevronLayer.lineWidth = 1.6
        chevronLayer.lineCap = .round
        chevronLayer.lineJoin = .round

        dotLayer.cornerRadius = 3.5

        label.font = font
        label.textColor = .labelColor
        label.lineBreakMode = .byTruncatingTail
        label.alignment = .left

        layer?.addSublayer(tintLayer)
        layer?.addSublayer(glossLayer)
        layer?.addSublayer(dotLayer)
        layer?.addSublayer(chevronLayer)
        // 文字最后加，才会盖在色块和高光上面
        addSubview(label)

        syncLayers()
        update()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// 按最长的日历名算一次宽度，之后切换日历不会左右跳
    var preferredWidth: CGFloat {
        let names = calendars.isEmpty ? [current] : calendars
        let widest = names
            .map { ($0 as NSString).size(withAttributes: [.font: font]).width }
            .max() ?? 40
        return max(96, ceil(widest) + chrome)
    }

    func select(_ name: String) {
        if !calendars.contains(name) { calendars.append(name) }
        if current == name { update() } else { current = name }
    }

    override func layout() {
        super.layout()
        syncLayers()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        syncLayers()
    }

    private func syncLayers() {
        guard bounds.width > 0 else { return }
        let radius = bounds.height / 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        let capsule = NSBezierPath(
            roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
            xRadius: radius,
            yRadius: radius
        )
        layer?.shadowPath = capsule.cgPath

        tintLayer.frame = bounds
        tintLayer.cornerRadius = radius
        glossLayer.frame = bounds
        glossLayer.cornerRadius = radius

        dotLayer.frame = CGRect(
            x: padH,
            y: (bounds.height - dotSize) / 2,
            width: dotSize,
            height: dotSize
        )

        label.frame = NSRect(
            x: padH + dotSize + 7,
            y: (bounds.height - 16) / 2,
            width: max(10, bounds.width - (padH + dotSize + 7) - (padH + 13)),
            height: 16
        )

        let cx = bounds.width - padH - 4.5
        let cy = bounds.height / 2
        let chevron = NSBezierPath()
        chevron.move(to: NSPoint(x: cx - 4, y: cy + 2.5))
        chevron.line(to: NSPoint(x: cx, y: cy - 2))
        chevron.line(to: NSPoint(x: cx + 4, y: cy + 2.5))
        chevronLayer.frame = bounds
        chevronLayer.path = chevron.cgPath

        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        update()
    }

    private func update() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let accent = colors[current] ?? .controlAccentColor

            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.cornerRadius = bounds.height / 2
            layer?.borderWidth = 1
            // 底下是玻璃，胶囊自己只留很薄一层，靠日历色和边线撑出形
            layer?.backgroundColor = NSColor.white
                .withAlphaComponent(dark ? 0.06 : 0.20).cgColor
            layer?.borderColor = (dark
                ? NSColor.white.withAlphaComponent(0.20)
                : NSColor.black.withAlphaComponent(0.07)).cgColor
            tintLayer.backgroundColor = accent.withAlphaComponent(dark ? 0.20 : 0.13).cgColor
            glossLayer.colors = [
                NSColor.white.withAlphaComponent(dark ? 0.16 : 0.55).cgColor,
                NSColor.white.withAlphaComponent(0).cgColor,
            ]
            dotLayer.backgroundColor = accent.cgColor
            chevronLayer.strokeColor = NSColor.secondaryLabelColor
                .withAlphaComponent(dark ? 0.9 : 0.75).cgColor

            if let gradient = layer?.sublayers?.first(where: { $0.name == "sheen" }) as? CAGradientLayer {
                gradient.colors = [
                    NSColor.white.withAlphaComponent(0).cgColor,
                    NSColor.white.withAlphaComponent(dark ? 0.22 : 0.45).cgColor,
                    NSColor.white.withAlphaComponent(0).cgColor,
                ]
            }
            CATransaction.commit()
        }
    }

    // MARK: 悬停 / 点击

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
            owner: self
        )
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        guard !Motion.reduced else { return }
        animate { context in
            context.duration = 0.18
            context.allowsImplicitAnimation = true
            self.layer?.backgroundColor = NSColor.white.withAlphaComponent(
                self.isDark ? 0.12 : 0.34
            ).cgColor
            self.layer?.borderColor = NSColor.white.withAlphaComponent(
                self.isDark ? 0.30 : 0.85
            ).cgColor
        }
        focusRing(visible: true)
    }

    override func mouseExited(with event: NSEvent) {
        update()
        focusRing(visible: false)
    }

    override func mouseDown(with event: NSEvent) {
        // 按下去微微缩一下，像按在一颗有弹性的水滴上
        animate { context in
            context.duration = 0.09
            context.allowsImplicitAnimation = true
            self.layer?.setAffineTransform(CGAffineTransform(scaleX: 0.96, y: 0.96))
        }
        makeMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: -5), in: self)
        animate { context in
            context.duration = 0.30
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            context.allowsImplicitAnimation = true
            self.layer?.setAffineTransform(.identity)
        }
    }

    /// 悬停时从左边扫过一道高光，这是「液态」最省力也最灵的一笔
    private func focusRing(visible: Bool) {
        guard !Motion.reduced else { return }
        if !visible {
            layer?.sublayers?.first(where: { $0.name == "sheen" })?.removeFromSuperlayer()
            return
        }
        guard layer?.sublayers?.contains(where: { $0.name == "sheen" }) != true else { return }

        let sheen = CAGradientLayer()
        sheen.name = "sheen"
        sheen.frame = CGRect(x: -bounds.width, y: 0, width: bounds.width, height: bounds.height)
        sheen.cornerRadius = bounds.height / 2
        sheen.masksToBounds = true
        sheen.startPoint = CGPoint(x: 0, y: 0.5)
        sheen.endPoint = CGPoint(x: 1, y: 0.5)
        sheen.colors = [
            NSColor.white.withAlphaComponent(0).cgColor,
            NSColor.white.withAlphaComponent(isDark ? 0.22 : 0.45).cgColor,
            NSColor.white.withAlphaComponent(0).cgColor,
        ]
        layer?.insertSublayer(sheen, above: glossLayer)

        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -bounds.width / 2
        sweep.toValue = bounds.width * 1.5
        sweep.duration = 0.62
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sheen.add(sweep, forKey: "sweep")
        sheen.position = CGPoint(x: bounds.width * 1.5, y: bounds.midY)
    }

    private var isDark: Bool {
        effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    private func animate(_ block: (NSAnimationContext) -> Void) {
        NSAnimationContext.runAnimationGroup { context in
            if Motion.reduced { context.duration = 0 }
            block(context)
        }
    }

    private func makeMenu() -> NSMenu {
        let list = NSMenu()
        list.autoenablesItems = false
        for name in (calendars.isEmpty ? [current] : calendars) {
            let item = NSMenuItem(title: name, action: #selector(pick(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = name
            item.state = (name == current) ? .on : .off
            item.image = swatch(colors[name] ?? .controlAccentColor)
            list.addItem(item)
        }
        return list
    }

    @objc private func pick(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        select(name)
        onPick?(name)
    }

    private func swatch(_ color: NSColor) -> NSImage {
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }

    private func pop() {
        guard !Motion.reduced, let layer else { return }
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.93
        pop.toValue = 1
        pop.damping = 15
        pop.stiffness = 240
        pop.duration = pop.settlingDuration
        layer.add(pop, forKey: "pop")
    }
}


/// 设置页用的小开关。
///
/// 不用 NSSwitch：它在这个 App 的离屏截图里永远画成「关」（状态是 on，画出来是 off），
/// 没法自检；自绘一个也让设置页跟别的手绘控件是一套长相。
final class SoftSwitch: NSControl {
    private let track = CALayer()
    private let knob = CALayer()

    var on = false {
        didSet {
            guard on != oldValue else { return }
            updateColors()
            moveKnob(animated: true)
        }
    }

    private var hovering = false {
        didSet { needsDisplay = true }
    }

    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        focusRingType = .none

        track.cornerRadius = frame.height / 2
        knob.cornerRadius = (frame.height - 5) / 2
        knob.shadowColor = NSColor.black.cgColor
        knob.shadowOpacity = 0.22
        knob.shadowRadius = 2
        knob.shadowOffset = CGSize(width: 0, height: -1)
        layer?.addSublayer(track)
        layer?.addSublayer(knob)
        updateColors()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { NSSize(width: 38, height: 22) }

    override func layout() {
        super.layout()
        track.frame = bounds
        track.cornerRadius = bounds.height / 2
        let inset: CGFloat = 2.5
        let size = bounds.height - inset * 2
        knob.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        knob.cornerRadius = size / 2
        moveKnob(animated: false)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func mouseDown(with event: NSEvent) {
        on.toggle()
        sendAction(action, to: target)
    }

    /// 空格 / 回车也能拨，键盘走一遍设置不用摸鼠标
    override func keyDown(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " " {
            on.toggle()
            sendAction(action, to: target)
            return
        }
        super.keyDown(with: event)
    }

    override var acceptsFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        needsDisplay = true
        return super.resignFirstResponder()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard window?.firstResponder === self else { return }
        // 键盘焦点：外面套一圈淡淡的强调色，跟系统开关的焦点环意思一样
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: -2.5, dy: -2.5), xRadius: bounds.height / 2 + 2.5, yRadius: bounds.height / 2 + 2.5)
            NSColor.controlAccentColor.withAlphaComponent(0.45).setStroke()
            ring.lineWidth = 2
            ring.stroke()
        }
    }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            track.backgroundColor = on
                ? NSColor.controlAccentColor.cgColor
                : (dark
                    ? NSColor.white.withAlphaComponent(0.16).cgColor
                    : NSColor.black.withAlphaComponent(0.12).cgColor)
            track.opacity = hovering ? 1 : 0.95
            knob.backgroundColor = NSColor.white.withAlphaComponent(dark ? 0.96 : 1).cgColor
        }
    }

    private func moveKnob(animated: Bool) {
        let inset: CGFloat = 2.5
        let size = bounds.height - inset * 2
        let x = on ? bounds.width - inset - size / 2 : inset + size / 2
        let end = CGPoint(x: x, y: bounds.height / 2)

        guard animated, !Motion.reduced else {
            knob.position = end
            return
        }
        let slide = CABasicAnimation(keyPath: "position.x")
        slide.fromValue = knob.presentation()?.position.x ?? knob.position.x
        slide.toValue = end.x
        slide.duration = 0.18
        slide.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        knob.position = end
        knob.add(slide, forKey: "slide")
    }
}

/// 胶囊行右端的小开关：一颗渐变圆点 + 「美化」两个字。
/// 点一下把输入卡染成跟胶囊同色的渐变，再点回到素玻璃。
final class TintToggle: NSButton {
    var kinds: [String] = [] { didSet { needsDisplay = true } }
    var on = true { didSet { needsDisplay = true } }
    private var hovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?
    private let text = "美化"
    private let labelFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)

    override init(frame: NSRect) {
        super.init(frame: frame)
        isBordered = false
        wantsLayer = true
        focusRingType = .none
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            // 还没输入时也给一条「标准色谱」，让人知道这个开关是干嘛的
            let ramp = kinds.isEmpty ? ["title", "time", "location", "tag"] : kinds

            let dotRect = NSRect(x: 1, y: (bounds.height - 12) / 2, width: 12, height: 12)
            let dot = NSBezierPath(ovalIn: dotRect)
            if on {
                // 圆点用原色而不是染色后的淡色：它是个「色谱」，得看得出来是哪几种颜色
                let colors = ramp.map { Theme.swatch(for: $0, dark: dark) }
                let pair = colors.count > 1 ? colors : [colors[0], colors[0]]
                NSGradient(colors: pair)?.draw(in: dot, angle: 0)
            }
            if on {
                NSColor.white.withAlphaComponent(dark ? 0.34 : 0.80).setStroke()
            } else {
                NSColor.secondaryLabelColor.withAlphaComponent(0.35).setStroke()
            }
            dot.lineWidth = 1
            dot.stroke()

            // 关掉时划一道斜线，比只变灰更明确
            if !on {
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: dotRect.minX + 2.5, y: dotRect.maxY - 2.5))
                slash.line(to: NSPoint(x: dotRect.maxX - 2.5, y: dotRect.minY + 2.5))
                NSColor.secondaryLabelColor.withAlphaComponent(0.45).setStroke()
                slash.lineWidth = 1
                slash.stroke()
            }

            let color: NSColor = on
                ? (hovering ? .labelColor : .secondaryLabelColor)
                : (hovering ? .labelColor : .secondaryLabelColor.withAlphaComponent(0.7))
            let attributes: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: color]
            let size = (text as NSString).size(withAttributes: attributes)
            (text as NSString).draw(
                at: NSPoint(x: 18, y: (bounds.height - size.height) / 2),
                withAttributes: attributes
            )
        }
    }
}

/// 识别结果的小药丸：时间一色、地点一色、标签一色。
/// 自绘成玻璃片：彩色半透明底 + 上沿高光 + 同色描边。
final class ChipView: NSView {
    private let text: String
    private let font = NSFont.systemFont(ofSize: 12, weight: .medium)
    private let color: NSColor
    private let textWidth: CGFloat
    private let isTitle: Bool

    init(text: String, kind: String) {
        self.text = text
        self.color = Theme.color(for: kind)
        self.isTitle = (kind == "title")
        let measured = (text as NSString).size(withAttributes: [.font: font]).width
        self.textWidth = min(ceil(measured) + 1, 280)

        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var fittingSize: NSSize {
        NSSize(width: textWidth + 24, height: 24)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)

            color.withAlphaComponent(dark ? 0.20 : 0.15).setFill()
            path.fill()

            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            if let gloss = NSGradient(colors: [
                NSColor.white.withAlphaComponent(dark ? 0.14 : 0.42),
                NSColor.white.withAlphaComponent(0),
            ]) {
                gloss.draw(
                    from: NSPoint(x: rect.minX, y: rect.maxY),
                    to: NSPoint(x: rect.minX, y: rect.midY),
                    options: []
                )
            }
            NSGraphicsContext.restoreGraphicsState()

            color.withAlphaComponent(isTitle ? 0.28 : 0.45).setStroke()
            path.lineWidth = 1
            path.stroke()

            // 文字自己画：NSTextField 的 cell 内边距会把中文挤成「…」
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            let size = (text as NSString).size(withAttributes: attributes)
            (text as NSString).draw(
                at: NSPoint(x: 12, y: (bounds.height - size.height) / 2),
                withAttributes: attributes
            )
        }
    }
}

/// 列表里的日期分组标题
final class AgendaHeaderView: NSView {
    init(text: String, width: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 36))
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 2, y: 12, width: width - 4, height: 16)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// 一条日程。悬停时浮出删除按钮，进行中的那条带一层淡色底。
final class AgendaRowView: NSView {
    let item: AgendaItem
    var onDelete: (() -> Void)?
    /// 挪动多少秒（推迟 30 分钟、改到明天）
    var onShift: ((TimeInterval) -> Void)?

    private let bar = NSView()
    private let startLabel = NSTextField(labelWithString: "")
    private let endLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let metaLabel = NSTextField(labelWithString: "")
    private let deleteButton = NSButton()
    private var tracking: NSTrackingArea?
    private var hovered = false { didSet { updateHover() } }
    private let isNow: Bool

    init(item: AgendaItem, tint: NSColor, width: CGFloat) {
        self.item = item
        let now = Date()
        self.isNow = item.start <= now && item.end > now
        let passed = item.end <= now
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 58))
        wantsLayer = true
        layer?.cornerRadius = 10

        bar.wantsLayer = true
        bar.layer?.cornerRadius = 1.5
        bar.layer?.backgroundColor = (passed ? tint.withAlphaComponent(0.35) : tint).cgColor
        bar.frame = NSRect(x: 2, y: 13, width: 3, height: 32)
        addSubview(bar)

        startLabel.stringValue = item.allDay ? "全天" : Format.time(item.start)
        startLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        startLabel.textColor = passed ? .tertiaryLabelColor : .labelColor
        startLabel.frame = NSRect(x: 16, y: 28, width: 54, height: 18)
        addSubview(startLabel)

        endLabel.stringValue = item.allDay ? "" : Format.time(item.end)
        endLabel.font = NSFont.systemFont(ofSize: 11)
        endLabel.textColor = .tertiaryLabelColor
        endLabel.frame = NSRect(x: 16, y: 13, width: 54, height: 15)
        addSubview(endLabel)

        titleLabel.stringValue = item.title
        titleLabel.font = NSFont.systemFont(ofSize: 14, weight: isNow ? .semibold : .regular)
        titleLabel.textColor = passed ? .secondaryLabelColor : .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.frame = NSRect(x: 78, y: 28, width: width - 78 - 42, height: 18)
        addSubview(titleLabel)

        var meta: [String] = []
        if let place = item.location, !place.isEmpty { meta.append(place) }
        if !item.calendar.isEmpty { meta.append(item.calendar) }
        metaLabel.stringValue = meta.joined(separator: " · ")
        metaLabel.font = NSFont.systemFont(ofSize: 11.5)
        metaLabel.textColor = .tertiaryLabelColor
        metaLabel.lineBreakMode = .byTruncatingTail
        metaLabel.frame = NSRect(x: 78, y: 13, width: width - 78 - 42, height: 15)
        addSubview(metaLabel)

        deleteButton.isBordered = false
        deleteButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "删除")
        deleteButton.imagePosition = .imageOnly
        deleteButton.contentTintColor = .tertiaryLabelColor
        deleteButton.target = self
        deleteButton.action = #selector(removeSelf)
        deleteButton.toolTip = "删除这条日程"
        deleteButton.frame = NSRect(x: width - 32, y: 17, width: 24, height: 24)
        deleteButton.alphaValue = 0
        addSubview(deleteButton)

        layer?.backgroundColor = rowBackground().cgColor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self
        )
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    private func updateHover() {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            deleteButton.animator().alphaValue = hovered ? 1 : 0
        }
        // 悬停时整行淡淡亮一下，比只冒出删除按钮更有反馈
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.16)
        layer?.backgroundColor = rowBackground().cgColor
        CATransaction.commit()
    }

    private func rowBackground() -> NSColor {
        if hovered { return .labelColor.withAlphaComponent(0.06) }
        if isNow { return .controlAccentColor.withAlphaComponent(0.09) }
        return .clear
    }

    @objc private func removeSelf() { onDelete?() }

    /// 右键菜单：常见的改期动作比拉一个完整编辑器快得多
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()

        let later30 = NSMenuItem(title: "推迟 30 分钟", action: #selector(shift30), keyEquivalent: "")
        later30.target = self
        menu.addItem(later30)

        let later60 = NSMenuItem(title: "推迟 1 小时", action: #selector(shift60), keyEquivalent: "")
        later60.target = self
        menu.addItem(later60)

        let tomorrow = NSMenuItem(title: "改到明天同一时间", action: #selector(shiftDay), keyEquivalent: "")
        tomorrow.target = self
        menu.addItem(tomorrow)

        menu.addItem(.separator())
        let remove = NSMenuItem(title: "删除这条日程", action: #selector(removeSelf), keyEquivalent: "")
        remove.target = self
        menu.addItem(remove)

        return menu
    }

    @objc private func shift30() { onShift?(1800) }
    @objc private func shift60() { onShift?(3600) }
    @objc private func shiftDay() { onShift?(86400) }
}

// MARK: - 小工具

extension NSTextView {
    /// 旧代码里到处是 `input?.stringValue`，让 NSTextView 也能直接这么写
    var stringValue: String {
        get { string }
        set { string = newValue }
    }
}

extension NSColor {
    /// iCloud 的日历颜色是 #RRGGBB 或 #RRGGBBAA
    convenience init?(hexString: String) {
        var text = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 8 { text = String(text.prefix(6)) }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
