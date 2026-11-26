import Cocoa
import WebKit

private final class BrowserWindow: NSWindow {
    var shortcut: ((String) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if modifiers == .command, let key = event.charactersIgnoringModifiers?.lowercased(), shortcut?(key) == true {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class InAppBrowserWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: BrowserWindow?
    private weak var returnWindow: NSWindow?
    private weak var webView: WKWebView?
    private weak var addressField: NSTextField?
    private weak var backButton: NSButton?
    private weak var forwardButton: NSButton?
    private weak var reloadButton: NSButton?
    private weak var externalButton: NSButton?
    private weak var activity: NSProgressIndicator?
    private weak var messagePanel: NSStackView?
    private weak var messageTitle: NSTextField?
    private weak var messageDetails: NSTextField?
    private weak var retryButton: NSButton?
    private var observations: [NSKeyValueObservation] = []
    private var english = false
    private var attemptedURL: URL?
    private var failureURL: URL?
    private var navigation: WKNavigation?
    private var loading = false

    private func text(_ chinese: String, _ english: String) -> String { self.english ? english : chinese }

    @discardableResult
    func show(url: URL? = nil, english: Bool, relativeTo parent: NSWindow?) -> Bool {
        if let url, !BrowserAddress.permits(url) { return false }
        self.english = english
        returnWindow = parent
        if window == nil { createWindow(relativeTo: parent) }
        guard let window else { return false }
        labelControls()
        if let url { load(URLRequest(url: url)) }
        window.makeKeyAndOrderFront(nil)
        if url == nil { focusAddress() }
        return true
    }

    private func createWindow(relativeTo parent: NSWindow?) {
        let screen = parent?.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let size = NSSize(width: min(1080, visible.width * 0.92), height: min(760, visible.height * 0.88))
        let window = BrowserWindow(contentRect: NSRect(origin: .zero, size: size),
                                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        window.contentMinSize = NSSize(width: min(460, size.width), height: min(320, size.height))
        let center = parent?.frame ?? visible
        let origin = NSPoint(x: max(visible.minX, min(center.midX - size.width / 2, visible.maxX - size.width)),
                             y: max(visible.minY, min(center.midY - size.height / 2, visible.maxY - window.frame.height)))
        window.setFrameOrigin(origin)
        window.shortcut = { [weak self] key in
            guard let self else { return false }
            switch key {
            case "l": self.focusAddress()
            case "r": self.reloadPage()
            case "[": self.backPage()
            case "]": self.forwardPage()
            case ".": if self.loading { self.reloadPage() }
            case "w": self.window?.performClose(nil)
            default: return false
            }
            return true
        }

        // Public pages have their own view, no application bridge, and an ephemeral data store.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false

        let back = toolButton("chevron.left", fallback: "‹", action: #selector(backPage))
        let forward = toolButton("chevron.right", fallback: "›", action: #selector(forwardPage))
        let reload = toolButton("arrow.clockwise", fallback: "↻", action: #selector(reloadPage))
        let external = toolButton("arrow.up.right.square", fallback: "↗", action: #selector(openExternal))
        let address = NSTextField()
        address.font = .systemFont(ofSize: 14)
        address.lineBreakMode = .byTruncatingMiddle
        address.usesSingleLineMode = true
        address.cell?.sendsActionOnEndEditing = false
        address.target = self
        address.action = #selector(enterAddress)
        address.setContentHuggingPriority(.defaultLow, for: .horizontal)
        address.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        address.heightAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.widthAnchor.constraint(equalToConstant: 18).isActive = true
        spinner.heightAnchor.constraint(equalToConstant: 18).isActive = true

        let toolbar = NSStackView(views: [back, forward, reload, address, spinner, external])
        toolbar.orientation = .horizontal
        toolbar.alignment = .centerY
        toolbar.spacing = 6
        toolbar.edgeInsets = NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.wantsLayer = true
        toolbar.layer?.backgroundColor = NSColor(srgbRed: 0.96, green: 0.93, blue: 0.87, alpha: 1).cgColor
        toolbar.appearance = NSAppearance(named: .aqua)

        let title = NSTextField(labelWithString: "")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        title.alignment = .center
        let details = NSTextField(wrappingLabelWithString: "")
        details.font = .systemFont(ofSize: 14)
        details.textColor = .secondaryLabelColor
        details.alignment = .center
        let retry = NSButton(title: "", target: self, action: #selector(retryPage))
        let panel = NSStackView(views: [title, details, retry])
        panel.orientation = .vertical
        panel.alignment = .centerX
        panel.spacing = 10
        panel.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        for view in [web, toolbar, divider, panel] as [NSView] { root.addSubview(view) }
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: root.topAnchor), toolbar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: root.trailingAnchor), toolbar.heightAnchor.constraint(equalToConstant: 48),
            divider.topAnchor.constraint(equalTo: toolbar.bottomAnchor), divider.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: root.trailingAnchor), divider.heightAnchor.constraint(equalToConstant: 1),
            web.topAnchor.constraint(equalTo: divider.bottomAnchor), web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor), web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            panel.centerXAnchor.constraint(equalTo: root.centerXAnchor), panel.centerYAnchor.constraint(equalTo: web.centerYAnchor),
            panel.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 28),
            panel.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -28),
            details.widthAnchor.constraint(lessThanOrEqualToConstant: 430),
        ])
        window.contentView = root
        self.window = window
        webView = web
        addressField = address
        backButton = back
        forwardButton = forward
        reloadButton = reload
        externalButton = external
        activity = spinner
        messagePanel = panel
        messageTitle = title
        messageDetails = details
        retryButton = retry
        web.isHidden = true
        retry.isHidden = true
        observations = [
            web.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.refreshControls() },
            web.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.refreshControls() },
            web.observe(\.url, options: [.new]) { [weak self] _, _ in self?.refreshControls() },
        ]
        refreshControls()
    }

    private func toolButton(_ symbol: String, fallback: String, action: Selector) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        let button = image.map { NSButton(image: $0, target: self, action: action) }
            ?? NSButton(title: fallback, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.widthAnchor.constraint(equalToConstant: 34).isActive = true
        return button
    }

    private func labelControls() {
        window?.title = text("Vibe Improve 网页浏览器", "Vibe Improve Browser")
        addressField?.placeholderString = text("输入网址", "Enter a web address")
        addressField?.setAccessibilityLabel(text("网址", "Web address"))
        retryButton?.title = text("重试", "Try again")
        label(backButton, text("后退", "Back"))
        label(forwardButton, text("前进", "Forward"))
        label(externalButton, text("在系统浏览器打开", "Open in Default Browser"))
        if attemptedURL == nil, failureURL == nil {
            messageTitle?.stringValue = text("网页浏览器", "Web Browser")
            messageDetails?.stringValue = text("输入网址后按回车。", "Enter a web address and press Return.")
        }
        refreshControls()
    }

    private func label(_ button: NSButton?, _ title: String) {
        button?.toolTip = title
        button?.setAccessibilityLabel(title)
    }

    private func refreshControls() {
        guard let webView else { return }
        backButton?.isEnabled = webView.canGoBack
        forwardButton?.isEnabled = webView.canGoForward
        reloadButton?.isEnabled = loading || attemptedURL != nil || webView.url != nil
        reloadButton?.image = NSImage(systemSymbolName: loading ? "xmark" : "arrow.clockwise", accessibilityDescription: nil)
        label(reloadButton, loading ? text("停止加载", "Stop Loading") : text("重新加载", "Reload"))
        externalButton?.isEnabled = currentAddress != nil
        if loading { activity?.startAnimation(nil) } else { activity?.stopAnimation(nil) }
        if addressField?.currentEditor() == nil, let url = currentAddress { addressField?.stringValue = url.absoluteString }
    }

    private var currentAddress: URL? {
        [failureURL, loading ? attemptedURL : nil, webView?.url, attemptedURL]
            .compactMap { $0 }.first(where: BrowserAddress.permits)
    }

    private func focusAddress() {
        guard let addressField else { return }
        window?.makeFirstResponder(addressField)
        addressField.selectText(nil)
    }

    @objc private func enterAddress() {
        guard let addressField else { return }
        guard let url = BrowserAddress.url(addressField.stringValue, assumeHTTPS: true) else {
            showMessage(text("无法打开这个地址", "Can’t Open This Address"),
                        text("请输入有效的公网 HTTP 或 HTTPS 网址。", "Enter a valid public HTTP or HTTPS address."), url: nil)
            webView?.stopLoading()
            focusAddress()
            return
        }
        window?.makeFirstResponder(webView)
        load(URLRequest(url: url))
    }

    private func beginLoad(_ url: URL?) {
        if let url, BrowserAddress.permits(url) { attemptedURL = url }
        failureURL = nil
        loading = true
        webView?.isHidden = false
        messagePanel?.isHidden = true
        refreshControls()
    }

    private func load(_ request: URLRequest) {
        guard let url = request.url, BrowserAddress.permits(url), let webView else { return }
        beginLoad(url)
        navigation = webView.load(request)
    }

    @objc private func backPage() {
        guard let webView, let item = webView.backForwardList.backItem else { return }
        beginLoad(item.url)
        navigation = webView.goBack()
    }

    @objc private func forwardPage() {
        guard let webView, let item = webView.backForwardList.forwardItem else { return }
        beginLoad(item.url)
        navigation = webView.goForward()
    }

    @objc private func reloadPage() {
        guard let webView else { return }
        if loading {
            navigation = nil
            webView.stopLoading()
            loading = false
            if webView.url == nil {
                showMessage(text("加载已停止", "Loading Stopped"), "", url: attemptedURL)
            } else { refreshControls() }
        } else if let url = failureURL ?? (webView.url == nil ? attemptedURL : nil) {
            load(URLRequest(url: url))
        } else if let url = webView.url {
            beginLoad(url)
            navigation = webView.reload()
        }
    }

    @objc private func retryPage() {
        if let failureURL { load(URLRequest(url: failureURL)) }
    }

    @objc private func openExternal() {
        if let url = currentAddress { NSWorkspace.shared.open(url) }
    }

    private func showMessage(_ title: String, _ details: String, url: URL?) {
        navigation = nil
        loading = false
        failureURL = url.flatMap { BrowserAddress.permits($0) ? $0 : nil }
        messageTitle?.stringValue = title
        messageDetails?.stringValue = details
        retryButton?.isHidden = failureURL == nil
        webView?.isHidden = true
        messagePanel?.isHidden = false
        refreshControls()
    }

    private func cannotDisplay(_ url: URL?) {
        showMessage(text("无法在 App 内显示此网页", "Can’t Display This Page"),
                    text("可重试，或点击右上角在系统浏览器中打开。", "Try again, or use the top-right button to open in your default browser."),
                    url: url ?? attemptedURL)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false, url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" {
            decisionHandler(.allow)
            return
        }
        guard BrowserAddress.permits(url) else {
            decisionHandler(.cancel)
            if action.targetFrame?.isMainFrame == true, loading {
                showMessage(text("已阻止打开此地址", "This Address Was Blocked"),
                            text("内置浏览器仅打开公网 HTTP 或 HTTPS 网址。", "The in-app browser opens public HTTP and HTTPS addresses."), url: attemptedURL)
            }
            return
        }
        if action.shouldPerformDownload {
            decisionHandler(.cancel)
            if action.targetFrame?.isMainFrame != false { cannotDisplay(url) }
            return
        }
        if action.targetFrame?.isMainFrame == true { attemptedURL = url }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, action.navigationType == .linkActivated, action.sourceFrame.isMainFrame {
            load(action.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        let attachment = disposition?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "attachment"
        guard response.canShowMIMEType, !attachment,
              !response.isForMainFrame || (response.response.url.map(BrowserAddress.permits) == true) else {
            decisionHandler(.cancel)
            if response.isForMainFrame { cannotDisplay(response.response.url) }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        self.navigation = navigation
        beginLoad(nil)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if self.navigation === navigation { beginLoad(webView.url) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard self.navigation === navigation else { return }
        self.navigation = nil
        attemptedURL = webView.url ?? attemptedURL
        loading = false
        refreshControls()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(navigation, error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(navigation, error: error)
    }

    private func navigationFailed(_ failed: WKNavigation?, error: Error) {
        guard navigation === failed, (error as NSError).code != NSURLErrorCancelled else { return }
        let url = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
        cannotDisplay(url)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { cannotDisplay(webView.url) }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func windowWillClose(_ notification: Notification) {
        let parent = returnWindow
        returnWindow = nil
        observations.removeAll()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        navigation = nil
        attemptedURL = nil
        failureURL = nil
        loading = false
        window = nil
        // Restore the learner's window after AppKit finishes closing the browser.
        DispatchQueue.main.async { [weak parent] in
            if NSApp.isActive, let parent, parent.isVisible { parent.makeKeyAndOrderFront(nil) }
        }
    }
}
