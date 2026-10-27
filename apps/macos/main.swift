import Cocoa
import WebKit
import Network

let appRoot = Bundle.main.bundleURL.deletingLastPathComponent()
let runtimeRoot = appRoot.appendingPathComponent("Vibe Improve Runtime", isDirectory: true)
func prepareRuntime() -> RuntimeDirectory {
    do {
        let directory = try RuntimeDirectory(url: runtimeRoot)
        try directory.migratePreferences(from: appRoot.appendingPathComponent("runtime", isDirectory: true))
        return directory
    } catch {
        let alert = NSAlert()
        alert.messageText = "无法访问运行时文件夹 / Runtime folder unavailable"
        alert.informativeText = "请将应用放在可写目录后重试。 / Move the app to a writable folder and retry."
        alert.runModal()
        exit(1)
    }
}
let runtimeFiles = prepareRuntime()
let diagnosticLog = DiagnosticLog(runtimeRoot: runtimeRoot)

var savedState = (try? runtimeFiles.read("preferences.json", maximumBytes: 65_536)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
let savedDevice = savedState["deviceId"] as? String ?? ""
let deviceId: String = {
    do { return try DeviceIdentity.load(from: runtimeFiles, legacyDeviceID: savedDevice) }
    catch {
        let alert = NSAlert()
        alert.messageText = "设备标识不可用 / Device identity unavailable"
        alert.informativeText = "请检查运行时目录中的 device.json；不要删除设备标识后重复激活。 / Check device.json in the runtime folder; restore the identity before retrying."
        alert.runModal()
        exit(1)
    }
}()
var preferences = savedState["preferences"] as? [String: Any] ?? [:]
func saveState() {
    if let data = try? JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "preferences": preferences]) {
        try? runtimeFiles.write("preferences.json", data: data)
    }
}
saveState()

final class AssetServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "vibe-improve.local-assets")
    private let root: URL
    init(root: URL) { self.root = root.standardizedFileURL }
    func start(ready: @escaping (UInt16) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters, on: .any)
        listener?.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = self?.listener?.port { DispatchQueue.main.async { ready(port.rawValue) } }
            if case .failed = state { diagnosticLog.record("native.server.failed", level: "error", resultCode: "SERVICE_UNAVAILABLE") }
        }
        listener?.newConnectionHandler = { [weak self] connection in
            connection.start(queue: self?.queue ?? .global())
            self?.receive(connection, buffer: Data())
        }
        listener?.start(queue: queue)
    }
    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            var combined = buffer
            if let data { combined.append(data) }
            guard combined.count < 16384 else { connection.cancel(); return }
            if combined.range(of: Data("\r\n\r\n".utf8)) != nil {
                self?.respond(connection, request: String(decoding: combined, as: UTF8.self))
            } else if complete || error != nil { connection.cancel() }
            else { self?.receive(connection, buffer: combined) }
        }
    }
    private func respond(_ connection: NWConnection, request: String) {
        let lines = request.components(separatedBy: "\r\n")
        let pieces = (lines.first ?? "").split(separator: " ")
        guard pieces.count >= 2, ["GET", "HEAD"].contains(String(pieces[0])) else { reply(connection, code: "405 Method Not Allowed", data: Data()); return }
        let headers = lines.dropFirst().reduce(into: [String: String]()) { result, line in
            if let colon = line.firstIndex(of: ":") { result[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces) }
        }
        guard let host = headers["host"], host.hasPrefix("127.0.0.1:"), UInt16(host.dropFirst(10)) == listener?.port?.rawValue else { reply(connection, code: "403 Forbidden", data: Data()); return }
        let raw = String(pieces[1]).components(separatedBy: "?")[0]
        guard let decoded = raw.removingPercentEncoding, !decoded.contains("\0"), !decoded.contains("\\") else { reply(connection, code: "400 Bad Request", data: Data()); return }
        let stripped = decoded.hasPrefix("/vibe-improve/") ? String(decoded.dropFirst("/vibe-improve/".count)) : String(decoded.drop(while: { $0 == "/" }))
        let relative = stripped.isEmpty ? "index.html" : stripped
        let file = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), let bytes = try? Data(contentsOf: file, options: .mappedIfSafe) else { reply(connection, code: "404 Not Found", data: Data()); return }
        let types = ["html":"text/html; charset=utf-8", "js":"text/javascript; charset=utf-8", "css":"text/css; charset=utf-8", "json":"application/json", "png":"image/png", "jpg":"image/jpeg", "svg":"image/svg+xml", "mp4":"video/mp4", "otf":"font/otf", "woff2":"font/woff2"]
        var extra = ["Content-Type": types[file.pathExtension] ?? "application/octet-stream", "Accept-Ranges":"bytes"]
        var body = bytes
        var code = "200 OK"
        if let range = headers["range"], range.hasPrefix("bytes="), !range.contains(",") {
            let values = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            if values.count == 2, let first = Int(values[0]), first >= 0, first < bytes.count {
                let last = min(Int(values[1]) ?? bytes.count - 1, bytes.count - 1)
                guard last >= first else { reply(connection, code: "416 Range Not Satisfiable", data: Data()); return }
                body = bytes.subdata(in: first..<(last + 1))
                extra["Content-Range"] = "bytes \(first)-\(last)/\(bytes.count)"
                code = "206 Partial Content"
            } else { reply(connection, code: "416 Range Not Satisfiable", data: Data(), headers: ["Content-Range":"bytes */\(bytes.count)"]); return }
        }
        extra["Content-Length"] = String(body.count)
        reply(connection, code: code, data: pieces[0] == "HEAD" ? Data() : body, headers: extra)
    }
    private func reply(_ connection: NWConnection, code: String, data: Data, headers: [String: String] = [:]) {
        var fields = headers
        if fields["Content-Length"] == nil { fields["Content-Length"] = String(data.count) }
        fields["Connection"] = "close"
        fields["X-Content-Type-Options"] = "nosniff"
        fields["Cache-Control"] = "no-store"
        fields["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://*.tcloudbasegateway.com https://*.tcb-api.tencentcloudapi.com https://*.tcloudbase.com https://*.tcb.qcloud.la https://*.tencentcloudapi.com; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
        let head = "HTTP/1.1 \(code)\r\n" + fields.map { "\($0.key): \($0.value)\r\n" }.joined() + "\r\n"
        var result = Data(head.utf8); result.append(data)
        connection.send(content: result, completion: .contentProcessed { _ in connection.cancel() })
    }
}

final class Application: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: AssetServer!
    var port: UInt16 = 0
    let sessionStore = SessionCredentialStore(runtimeRoot: runtimeRoot)
    let sessionQueue = DispatchQueue(label: "vibe-improve.session")
    let projectQueue = DispatchQueue(label: "vibe-improve.projects")
    let projectStore = try? ProjectStore(runtime: runtimeFiles)
    let agentManager = try? AgentManager(runtime: runtimeFiles)
    let agentQueue = DispatchQueue(label: "vibe-improve.agents", attributes: .concurrent)
    var wakeObserver: NSObjectProtocol?
    func applicationDidBecomeActive(_ notification: Notification) { checkLicenseTime() }
    func checkLicenseTime() { webView?.evaluateJavaScript("window.dispatchEvent(new Event('vibe-clock-check'))", completionHandler: nil) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        diagnosticLog.record("native.started")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "vibeNative")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "vibeSession")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "vibeProjects")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "vibeAgents")
        let prefsData = (try? JSONSerialization.data(withJSONObject: preferences)) ?? Data("{}".utf8)
        let prefs = String(decoding: prefsData, as: UTF8.self)
        let deviceNameData = try! JSONSerialization.data(withJSONObject: Host.current().localizedName ?? ProcessInfo.processInfo.hostName, options: [.fragmentsAllowed])
        let deviceName = String(decoding: deviceNameData, as: UTF8.self)
        let script = "window.vibeNative={deviceId:'\(deviceId)',deviceName:\(deviceName),preferences:\(prefs),setPreferences:function(p){window.webkit.messageHandlers.vibeNative.postMessage({action:'preferences',value:p})},log:function(e){window.webkit.messageHandlers.vibeNative.postMessage({action:'log',value:e})},quit:function(){window.webkit.messageHandlers.vibeNative.postMessage({action:'quit'})},clock:{sample:function(){return window.webkit.messageHandlers.vibeSession.postMessage({action:'clock'})}},agents:{request:function(action,value){return window.webkit.messageHandlers.vibeAgents.postMessage({action:action,value:value||{}})}},projects:{request:function(action,value){return window.webkit.messageHandlers.vibeProjects.postMessage({action:action,value:value||{}})}},session:{read:function(){return window.webkit.messageHandlers.vibeSession.postMessage({action:'read'})},write:function(value){return window.webkit.messageHandlers.vibeSession.postMessage({action:'write',value:value})},clear:function(){return window.webkit.messageHandlers.vibeSession.postMessage({action:'clear'})}}};"
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.checkLicenseTime() }
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        let decorationHeight = NSWindow.frameRect(forContentRect: NSRect(origin: .zero, size: WindowLayout.videoSize), styleMask: style).height - WindowLayout.videoSize.height
        let size = WindowLayout.initialContentSize(available: available, decorationHeight: decorationHeight)
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: style, backing: .buffered, defer: false)
        window.title = "Vibe Improve"
        window.contentMinSize = NSSize(width: min(WindowLayout.minimumContentSize.width, size.width), height: min(WindowLayout.minimumContentSize.height, size.height))
        window.collectionBehavior = [.fullScreenPrimary]
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        makeMenus()
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else { return }
        server = AssetServer(root: root)
        do {
            try server.start { [weak self] port in
                diagnosticLog.record("native.server.ready")
                self?.port = port
                let record = try? JSONSerialization.data(withJSONObject: ["port": Int(port)])
                if let record { try? runtimeFiles.write("local-server.json", data: record) }
                self?.loadStartPage()
            }
        }
        catch { diagnosticLog.record("native.server.failed", level: "error", resultCode: "SERVICE_UNAVAILABLE"); let alert = NSAlert(); alert.messageText = "无法启动本地界面"; alert.runModal(); NSApplication.shared.terminate(nil) }
    }
    func loadStartPage() {
        guard port > 0 else { return }
        diagnosticLog.record("native.local.started")
        webView.load(URLRequest(url: LocalClientOrigin(port: port).startURL))
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        diagnosticLog.record("native.local.failed", level: "error", resultCode: "SERVICE_UNAVAILABLE")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { diagnosticLog.record("native.navigation.completed") }
    func makeMenus() {
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "退出 Vibe Improve", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem); let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
        let windowItem = NSMenuItem(); menu.addItem(windowItem); let windowMenu = NSMenu(title: "窗口"); windowItem.submenu = windowMenu
        let fullscreen = windowMenu.addItem(withTitle: "切换全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f"); fullscreen.keyEquivalentModifierMask = [.control, .command]
        NSApplication.shared.mainMenu = menu
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url, isAllowed(origin), let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if action == "quit" { NSApplication.shared.terminate(nil) }
        if action == "log", let entry = body["value"] as? [String: Any], entry.count <= 24 { diagnosticLog.receive(entry) }
        if action == "preferences", let values = body["value"] as? [String: Any], values.count <= 12 {
            var allowed: [String: Any] = [:]
            if let language = values["language"] as? String, ["zh-CN", "en"].contains(language) { allowed["language"] = language }
            if let sound = values["sound"] as? [String: Any] {
                var safe: [String: Any] = [:]
                for key in ["enabled", "effects", "motion"] { if let flag = sound[key] as? Bool { safe[key] = flag } }
                if let volume = sound["volume"] as? Double, volume.isFinite { safe["volume"] = min(100, max(0, volume)) }
                allowed["sound"] = safe
            }
            preferences = allowed
            saveState()
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        if message.name == "vibeProjects" { handleProjectMessage(message, replyHandler: replyHandler); return }
        if message.name == "vibeAgents" { handleAgentMessage(message, replyHandler: replyHandler); return }
        guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url, isAllowed(origin),
              let body = message.body as? [String: Any], body.count <= 2,
              let action = body["action"] as? String, ["read", "write", "clear", "clock"].contains(action) else {
            replyHandler(nil, "SESSION_STORAGE_UNAVAILABLE"); return
        }
        sessionQueue.async { [self] in
            do {
                var result: Any = NSNull()
                if action == "read", let record = try sessionStore.read() { result = record }
                if action == "write" { try sessionStore.write(body["value"] as Any) }
                if action == "clear" { try sessionStore.clear() }
                if action == "clock" { result = try NativeLicenseClock.sample() }
                let response = result
                DispatchQueue.main.async { replyHandler(response, nil) }
            } catch {
                let code = error is LicenseClockError ? "LICENSE_CLOCK_UNTRUSTED" : (error as? SessionStoreError) == .invalid || (error as? RuntimeFileError) == .invalid ? "SESSION_STORAGE_INVALID" : "SESSION_STORAGE_UNAVAILABLE"
                DispatchQueue.main.async { replyHandler(nil, code) }
            }
        }
    }
    private func handleProjectMessage(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url, isAllowed(origin),
              let body = message.body as? [String: Any], body.count <= 2, let action = body["action"] as? String,
              let bytes = try? JSONSerialization.data(withJSONObject: body), bytes.count <= 65_536,
              let store = projectStore else { replyHandler(nil, "PROJECT_STORAGE_UNAVAILABLE"); return }
        let value = body["value"] as? [String: Any] ?? [:]
        if action == "chooseParent" || action == "chooseProject" {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
            panel.canCreateDirectories = true
            let english = preferences["language"] as? String == "en"
            panel.title = action == "chooseParent" ? (english ? "Choose project location" : "选择项目目录") : (english ? "Open project folder" : "打开项目目录")
            panel.prompt = english ? "Choose" : "选择"
            panel.beginSheetModal(for: window) { [self] result in
                guard result == .OK, let url = panel.url else { replyHandler(NSNull(), nil); return }
                projectQueue.async {
                    do {
                        let response = action == "chooseParent" ? try store.grant(url) : try store.register(url, replacing: value["id"] as? String)
                        DispatchQueue.main.async { replyHandler(response, nil) }
                    } catch {
                        let code = (error as? ProjectError)?.rawValue ?? ProjectError.unavailable.rawValue
                        DispatchQueue.main.async { replyHandler(nil, code) }
                    }
                }
            }
            return
        }
        projectQueue.async {
            do {
                var result: Any = NSNull()
                switch action {
                case "list": result = try store.list()
                case "draft.read": result = try store.loadDraft()
                case "draft.save":
                    guard let name = value["name"] as? String else { throw ProjectError.invalid }
                    try store.saveDraft(name: name, parentToken: value["parentToken"] as? String)
                case "create":
                    guard let name = value["name"] as? String, let token = value["parentToken"] as? String, let id = value["commandId"] as? String else { throw ProjectError.invalid }
                    result = try store.create(name: name, parentToken: token, commandID: id)
                case "open":
                    guard let id = value["id"] as? String else { throw ProjectError.invalid }
                    result = try store.openProject(id: id)
                case "update":
                    guard let id = value["id"] as? String, let name = value["name"] as? String, let revision = value["expectedRevision"] as? Int else { throw ProjectError.invalid }
                    result = try store.rename(id: id, name: name, expectedRevision: revision, parentToken: value["parentToken"] as? String)
                case "remove":
                    guard let id = value["id"] as? String, let revision = value["expectedRevision"] as? Int else { throw ProjectError.invalid }
                    try store.remove(id: id, expectedRevision: revision)
                default: throw ProjectError.invalid
                }
                let response = result
                DispatchQueue.main.async { replyHandler(response, nil) }
            } catch {
                let code = (error as? ProjectError)?.rawValue ?? ProjectError.storage.rawValue
                DispatchQueue.main.async { replyHandler(nil, code) }
            }
        }
    }
    private func handleAgentMessage(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let origin=message.frameInfo.request.url, isAllowed(origin),
              let body=message.body as? [String:Any],Set(body.keys).isSubset(of:["action","value"]),let action=body["action"] as? String,
              let data=try? JSONSerialization.data(withJSONObject:body),data.count<=8192,
              let value=body["value"] as? [String:Any],let manager=agentManager else{replyHandler(nil,AgentError.invalid.rawValue);return}
        agentQueue.async {
            do {
                var result:Any=NSNull()
                switch action {
                case "probe": guard Set(value.keys)==["id"],let id=value["id"] as? String else{throw AgentError.invalid};result=try manager.probe(id)
                case "choice.read": guard Set(value.keys)==["scope"],let scope=value["scope"] as? String else{throw AgentError.invalid};result=try manager.choice(scope)
                case "choice.save": guard Set(value.keys)==["scope","choice"],let scope=value["scope"] as? String,let choice=value["choice"] as? String else{throw AgentError.invalid};try manager.save(scope,choice:choice)
                case "install.begin": guard Set(value.keys)==["id"],let id=value["id"] as? String else{throw AgentError.invalid};result=try manager.beginInstall(id)
                case "login.begin": guard Set(value.keys)==["id"],let id=value["id"] as? String else{throw AgentError.invalid};result=try manager.beginLogin(id)
                case "login.state": guard Set(value.keys)==["loginId"],let id=value["loginId"] as? String else{throw AgentError.invalid};result=try manager.loginState(id)
                case "login.cancel": guard Set(value.keys)==["loginId"],let id=value["loginId"] as? String else{throw AgentError.invalid};try manager.cancelLogin(id)
                case "login.code": guard Set(value.keys)==["loginId","code"],let id=value["loginId"] as? String,let code=value["code"] as? String else{throw AgentError.invalid};try manager.sendCode(id,code:code)
                default: throw AgentError.invalid
                }
                diagnosticLog.record("native.agent.completed")
                let response=result;DispatchQueue.main.async{replyHandler(response,nil)}
            }catch{diagnosticLog.record("native.agent.failed",level:"warn",resultCode:"SERVICE_UNAVAILABLE");let code=(error as? AgentError)?.rawValue ?? AgentError.unavailable.rawValue;DispatchQueue.main.async{replyHandler(nil,code)}}
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url=navigationAction.request.url,AgentLogin.permitsAuthURL(url){NSWorkspace.shared.open(url);decisionHandler(.cancel);return}
        if let url = navigationAction.request.url, isAllowed(url) { decisionHandler(.allow) } else { decisionHandler(.cancel) }
    }
    private func isAllowed(_ url: URL) -> Bool {
        LocalClientOrigin(port: port).permits(url)
    }
    func applicationWillTerminate(_ notification: Notification) { agentManager?.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Application()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
