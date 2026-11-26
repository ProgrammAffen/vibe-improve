import Cocoa
import CoreFoundation
import WebKit

/// Viewport coordinates from the trusted notebook page, in CSS pixels with a top-left origin.
struct InlineBrowserPlacement {
    let frame: CGRect
    let clip: CGRect
    let viewport: CGSize

    init?(_ value: [String: Any]) {
        guard let frame = Self.rect(value["frame"]), let clip = Self.rect(value["clip"]),
              let viewport = value["viewport"] as? [String: Any], Set(viewport.keys) == ["width", "height"],
              let width = Self.number(viewport["width"], max: 8_192), width > 0,
              let height = Self.number(viewport["height"], max: 8_192), height > 0
        else { return nil }
        self.frame = frame
        self.clip = clip
        self.viewport = CGSize(width: width, height: height)
    }

    /// Keep the page at its full slot size. The container alone intersects the visible area.
    func layout(in hostBounds: CGRect, hostIsFlipped: Bool = false) -> (container: CGRect, page: CGRect)? {
        guard !hostBounds.isEmpty else { return nil }
        let visible = frame.intersection(clip).intersection(CGRect(origin: .zero, size: viewport))
        guard !visible.isEmpty else { return nil }
        let scaleX = hostBounds.width / viewport.width, scaleY = hostBounds.height / viewport.height
        let container = CGRect(x: hostBounds.minX + visible.minX * scaleX,
                               y: hostIsFlipped ? hostBounds.minY + visible.minY * scaleY : hostBounds.maxY - visible.maxY * scaleY,
                               width: visible.width * scaleX, height: visible.height * scaleY)
        let page = CGRect(x: (frame.minX - visible.minX) * scaleX,
                          y: (visible.maxY - frame.maxY) * scaleY,
                          width: frame.width * scaleX, height: frame.height * scaleY)
        return (container, page)
    }

    private static func rect(_ value: Any?) -> CGRect? {
        guard let rect = value as? [String: Any], Set(rect.keys) == ["x", "y", "width", "height"],
              let x = number(rect["x"], max: 16_777_216), let y = number(rect["y"], max: 16_777_216),
              let width = number(rect["width"], max: 8_192), width >= 0,
              let height = number(rect["height"], max: 8_192), height >= 0
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private static func number(_ value: Any?, max: CGFloat) -> CGFloat? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = CGFloat(value.doubleValue)
        return number.isFinite && abs(number) <= max ? number : nil
    }
}

@MainActor
final class InlineLessonBrowserController {
    private static let maximumLivePages = 6
    private weak var host: WKWebView?
    private let onState: (String, String) -> Void
    private let onAnnotation: ([String: Any]) -> Void
    private var pages: [String: Page] = [:]
    private var annotationSets: [String: InlinePageAnnotations.Configuration] = [:]
    private var updateOrder = 0

    init(host: WKWebView, onState: @escaping (String, String) -> Void,
         onAnnotation: @escaping ([String: Any]) -> Void = { _ in }) {
        self.host = host
        self.onState = onState
        self.onAnnotation = onAnnotation
    }

    @discardableResult
    func update(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == ["id", "url", "frame", "clip", "viewport"],
              let id = value["id"] as? String, id.utf8.count == 36, UUID(uuidString: id) != nil,
              let address = value["url"] as? String, let url = BrowserAddress.url(address),
              let placement = InlineBrowserPlacement(value), let host, let parent = host.superview
        else { return false }

        if let page = pages[id], page.source != url { pages.removeValue(forKey: id)?.dispose() }
        guard let layout = placement.layout(in: host.bounds, hostIsFlipped: host.isFlipped) else {
            pages[id]?.setVisible(false)
            return true
        }
        let containerFrame = host.convert(layout.container, to: parent)
        updateOrder += 1
        if let page = pages[id] {
            page.place(container: containerFrame, content: layout.page, order: updateOrder)
            return true
        }

        if pages.count == Self.maximumLivePages {
            guard let victim = pages.filter({ !$0.value.visible }).min(by: { $0.value.order < $1.value.order }) else { return false }
            pages.removeValue(forKey: victim.key)?.dispose()
            onState(victim.key, "loading")
        }
        let page = Page(source: url, onState: { [weak self] state in self?.onState(id, state.rawValue) },
                        onAnnotation: { [weak self] request in
            var event = request
            event["id"] = id
            self?.onAnnotation(event)
        })
        if let configuration = annotationSets[id] { page.annotations.configure(configuration) }
        pages[id] = page
        parent.addSubview(page.container, positioned: .above, relativeTo: host)
        page.place(container: containerFrame, content: layout.page, order: updateOrder)
        page.load(URLRequest(url: url))
        return true
    }

    func remove(_ id: String) {
        annotationSets.removeValue(forKey: id)
        pages.removeValue(forKey: id)?.dispose()
    }

    func clear() {
        annotationSets.removeAll()
        let removed = pages
        pages.removeAll()
        for page in removed.values { page.dispose() }
    }

    func setAnnotations(_ value: [String: Any]) -> Bool {
        guard let id = value["id"] as? String, id.utf8.count == 36, UUID(uuidString: id) != nil,
              let configuration = InlinePageAnnotations.Configuration(value)
        else { return false }
        annotationSets[id] = configuration
        pages[id]?.annotations.configure(configuration)
        return true
    }

    func beginAnnotation(_ id: String) -> Bool { pages[id]?.annotations.begin() ?? false }

    func resolveAnnotation(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == ["id", "requestId", "ok"], let id = value["id"] as? String,
              let requestId = value["requestId"] as? String,
              let ok = value["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID()
        else { return false }
        return pages[id]?.annotations.resolve(requestId: requestId, ok: ok.boolValue) ?? false
    }

    private final class ClipView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard frame.contains(point) else { return nil }
            return super.hitTest(point)
        }
    }

    private enum State: String { case loading, ready, failed }

    private final class Page: NSObject, WKNavigationDelegate, WKUIDelegate {
        let source: URL
        let container: NSView = ClipView()
        let annotations: InlinePageAnnotations
        private let browser: WKWebView
        private let onState: (State) -> Void
        private var state: State?
        private var navigation: WKNavigation?
        private var timeout: DispatchWorkItem?
        private(set) var order = 0
        private(set) var visible = false

        init(source: URL, onState: @escaping (State) -> Void, onAnnotation: @escaping ([String: Any]) -> Void) {
            self.source = source
            self.onState = onState
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            annotations = InlinePageAnnotations(configuration: configuration, onAction: onAnnotation)
            browser = WKWebView(frame: .zero, configuration: configuration)
            super.init()
            browser.navigationDelegate = self
            browser.uiDelegate = self
            container.wantsLayer = true
            container.layer?.masksToBounds = true
            container.isHidden = true
            container.addSubview(browser)
            annotations.attach(to: browser, container: container)
        }

        func place(container frame: CGRect, content: CGRect, order: Int) {
            self.order = order
            if container.frame != frame { container.frame = frame }
            if browser.frame != content { browser.frame = content }
            setVisible(true)
            annotations.layout()
        }

        func setVisible(_ visible: Bool) {
            self.visible = visible
            refreshVisibility()
        }

        private func refreshVisibility() {
            let hidden = !visible || state != .ready
            if hidden, !container.isHidden, let window = container.window,
               let focused = window.firstResponder as? NSView, focused.isDescendant(of: container) {
                window.makeFirstResponder(nil)
            }
            container.isHidden = hidden
            annotations.setVisible(!hidden)
        }

        private func setState(_ next: State) {
            if next != .loading {
                timeout?.cancel()
                timeout = nil
            }
            guard state != next else { return }
            state = next
            if next != .ready { annotations.resetDocument() }
            refreshVisibility()
            onState(next)
        }

        private func beginLoading() {
            timeout?.cancel()
            let expiry = DispatchWorkItem { [weak self] in self?.fail() }
            timeout = expiry
            setState(.loading)
            DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: expiry)
        }

        func load(_ request: URLRequest) {
            beginLoading()
            navigation = browser.load(request)
        }

        private func fail() {
            navigation = nil
            setState(.failed)
            browser.stopLoading()
        }

        func dispose() {
            timeout?.cancel()
            setVisible(false)
            browser.navigationDelegate = nil
            browser.uiDelegate = nil
            annotations.dispose()
            browser.stopLoading()
            container.removeFromSuperview()
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let isMain = action.targetFrame?.isMainFrame == true
            if let url = action.request.url, action.targetFrame?.isMainFrame == false,
               ["about:blank", "about:srcdoc"].contains(url.absoluteString) {
                decisionHandler(.allow)
                return
            }
            guard let url = action.request.url, BrowserAddress.permits(url), !action.shouldPerformDownload else {
                decisionHandler(.cancel)
                if isMain && state == .loading { fail() }
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.targetFrame == nil, action.sourceFrame.isMainFrame,
               action.navigationType == .linkActivated, !action.shouldPerformDownload,
               let url = action.request.url, BrowserAddress.permits(url) {
                load(action.request)
            }
            return nil
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let http = response.response as? HTTPURLResponse
            let disposition = http?.value(forHTTPHeaderField: "Content-Disposition")
            let attachment = disposition?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "attachment"
            let allowed = response.response.url.map(BrowserAddress.permits) == true
            guard allowed, response.canShowMIMEType, !attachment,
                  !response.isForMainFrame || (http?.statusCode ?? 0) < 400 else {
                decisionHandler(.cancel)
                if response.isForMainFrame { fail() }
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            self.navigation = navigation
            beginLoading()
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            if self.navigation === navigation { setState(.ready) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if self.navigation === navigation {
                setState(.ready)
                annotations.sendAnchors()
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if self.navigation === navigation { fail() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if self.navigation === navigation { fail() }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }

        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
            completionHandler(nil)
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }
    }
}
