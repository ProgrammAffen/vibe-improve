import AppKit
import CoreFoundation
import WebKit

/// Positions browser annotations in a native overlay above the untrusted page.
@MainActor
final class InlinePageAnnotations: NSObject, WKScriptMessageHandler {
    private static let handlerName = "vibeAnnotationGeometry"
    private static let world = WKContentWorld.world(name: "app.vibeimprove.inline-annotations")

    struct Anchor: Equatable {
        let url: String
        let quote: String
        let prefix: String
        let suffix: String

        init?(_ json: [String: Any]) {
            guard Set(json.keys) == ["url", "quote", "prefix", "suffix"],
                  let address = InlinePageAnnotations.string(json["url"], limit: 2_048),
                  let url = InlinePageAnnotations.documentAddress(address),
                  let quote = InlinePageAnnotations.string(json["quote"], limit: 1_000),
                  !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let prefix = InlinePageAnnotations.string(json["prefix"], limit: 120),
                  let suffix = InlinePageAnnotations.string(json["suffix"], limit: 120) else { return nil }
            self.url = url
            self.quote = quote
            self.prefix = prefix
            self.suffix = suffix
        }

        var json: [String: String] { ["url": url, "quote": quote, "prefix": prefix, "suffix": suffix] }
    }

    struct Note: Equatable {
        let id: String
        let anchor: Anchor
        var text: String

        init(id: String, anchor: Anchor, text: String) {
            self.id = id
            self.anchor = anchor
            self.text = text
        }

        init?(_ json: [String: Any]) {
            guard Set(json.keys) == ["id", "anchor", "text"],
                  let id = InlinePageAnnotations.string(json["id"], limit: 128),
                  id.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"#, options: .regularExpression) != nil,
                  let anchorValue = json["anchor"] as? [String: Any], let anchor = Anchor(anchorValue),
                  let text = InlinePageAnnotations.string(json["text"], limit: 100_000) else { return nil }
            self.init(id: id, anchor: anchor, text: text)
        }

        var json: [String: Any] { ["id": id, "anchor": anchor.json, "text": text] }
    }

    struct Configuration: Equatable {
        let language: String
        var notes: [String: Note]

        init(language: String, notes: [String: Note]) {
            self.language = language
            self.notes = notes
        }

        init?(_ value: [String: Any]) {
            guard Set(value.keys) == ["id", "language", "notes"], let language = value["language"] as? String,
                  ["zh-CN", "en"].contains(language), let list = value["notes"] as? [[String: Any]],
                  list.count <= 2_000 else { return nil }
            var notes: [String: Note] = [:]
            var characters = 0
            for json in list {
                guard let note = Note(json), notes[note.id] == nil else { return nil }
                characters += note.text.utf16.count + note.anchor.quote.utf16.count + note.anchor.url.utf16.count
                guard characters <= 2_097_152 else { return nil }
                notes[note.id] = note
            }
            self.init(language: language, notes: notes)
        }
    }

    private struct Geometry {
        let url: String
        let viewport: CGSize
        let selection: (Anchor, [CGRect])?
        let markers: [String: [CGRect]]

        init?(_ json: [String: Any], url: String) {
            guard let viewport = json["viewport"] as? [String: Any],
                  let width = InlinePageAnnotations.number(viewport["width"], limit: 16_384), width > 0,
                  let height = InlinePageAnnotations.number(viewport["height"], limit: 16_384), height > 0,
                  let list = json["markers"] as? [[String: Any]], list.count <= 100 else { return nil }
            self.viewport = CGSize(width: width, height: height)
            self.url = url

            if let value = json["selection"] as? [String: Any],
               var anchor = value["anchor"] as? [String: Any] {
                anchor["url"] = url
                if let anchor = Anchor(anchor) { selection = (anchor, Self.rects(value["rects"])) }
                else { selection = nil }
            } else { selection = nil }

            var markers: [String: [CGRect]] = [:]
            for marker in list {
                guard let id = marker["id"] as? String, id.utf8.count <= 128 else { continue }
                markers[id] = Self.rects(marker["rects"])
            }
            self.markers = markers
        }

        private static func rects(_ value: Any?) -> [CGRect] {
            guard let items = value as? [[String: Any]], items.count <= 12 else { return [] }
            return items.compactMap {
                guard let x = InlinePageAnnotations.number($0["x"], limit: 65_536),
                      let y = InlinePageAnnotations.number($0["y"], limit: 65_536),
                      let width = InlinePageAnnotations.number($0["width"], limit: 65_536), width > 0,
                      let height = InlinePageAnnotations.number($0["height"], limit: 65_536), height > 0 else { return nil }
                return CGRect(x: x, y: y, width: width, height: height)
            }
        }
    }

    private final class Overlay: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? {
            let hit = super.hitTest(point)
            return hit === self ? nil : hit
        }
    }

    private struct Pending {
        let requestId: String
        let action: String
        let note: Note
    }

    private weak var browser: WKWebView?
    private let onAction: ([String: Any]) -> Void
    private var configuration = Configuration(language: "zh-CN", notes: [:])
    private var geometry: Geometry?
    private var pending: Pending?
    private var draft: Note?
    private let overlay = Overlay()
    private let underlines = CAShapeLayer()
    private let selectionButton = NSButton()
    private var markers: [String: NSButton] = [:]
    private var popover: NSPopover?
    private weak var editor: AnnotationEditor?
    private var visible = false

    init(configuration: WKWebViewConfiguration, onAction: @escaping ([String: Any]) -> Void) {
        self.onAction = onAction
        super.init()
        configuration.userContentController.add(self, contentWorld: Self.world, name: Self.handlerName)
        configuration.userContentController.addUserScript(WKUserScript(source: Self.script,
            injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: Self.world))
        overlay.wantsLayer = true
        underlines.fillColor = NSColor(srgbRed: 0.77, green: 0.49, blue: 0.14, alpha: 0.7).cgColor
        overlay.layer?.addSublayer(underlines)
        configureButton(selectionButton, action: #selector(addNote))
        overlay.addSubview(selectionButton)
    }

    func attach(to browser: WKWebView, container: NSView) {
        self.browser = browser
        container.addSubview(overlay, positioned: .above, relativeTo: browser)
    }

    func configure(_ value: Configuration) {
        let changed = configuration.notes.mapValues(\.anchor) != value.notes.mapValues(\.anchor)
        configuration = value
        if changed { sendAnchors() }
        layout()
    }

    func sendAnchors() {
        guard let browser, let url = browser.url.flatMap({ Self.documentAddress($0.absoluteString) }) else { return }
        let anchors = configuration.notes.values.filter { $0.anchor.url == url }.map {
            ["id": $0.id, "anchor": $0.anchor.json] as [String: Any]
        }
        // Only the site's own quote and surrounding text are forwarded to the isolated world.
        browser.callAsyncJavaScript("window.vibeInlineAnnotationLayout?.setAnchors(url, anchors)",
            arguments: ["url": url, "anchors": anchors], in: nil, in: Self.world, completionHandler: nil)
    }

    func resetDocument() {
        geometry = nil
        closeEditor(keepDraft: true)
        layout()
    }

    func setVisible(_ available: Bool) {
        guard visible != available else { return }
        visible = available
        if !available { closeEditor(keepDraft: true) }
        layout()
    }

    func dispose() {
        closeEditor()
        browser?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: Self.world)
        overlay.removeFromSuperview()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, message.webView === browser, message.frameInfo.isMainFrame,
              let value = message.body as? [String: Any], let url = value["url"] as? String,
              let pageURL = browser?.url.flatMap({ Self.documentAddress($0.absoluteString) }), pageURL == url
        else { return }
        if value["kind"] as? String == "document" {
            resetDocument()
            sendAnchors()
        } else if value["kind"] as? String == "geometry", let next = Geometry(value, url: pageURL) {
            geometry = next
            layout()
        }
    }

    func layout() {
        guard let container = overlay.superview, let browser else { return }
        overlay.frame = container.bounds
        overlay.isHidden = !visible
        guard visible, let geometry, browser.url.flatMap({ Self.documentAddress($0.absoluteString) }) == geometry.url else {
            underlines.path = nil
            selectionButton.isHidden = true
            removeMarkers(except: [])
            return
        }
        let addTitle = localized("记笔记", "Add note")
        selectionButton.title = addTitle
        selectionButton.setAccessibilityLabel(addTitle)
        let scaleX = browser.frame.width / geometry.viewport.width, scaleY = browser.frame.height / geometry.viewport.height
        func positions(_ rects: [CGRect]) -> [CGRect] {
            rects.map { CGRect(x: browser.frame.minX + $0.minX * scaleX, y: browser.frame.maxY - $0.maxY * scaleY,
                               width: $0.width * scaleX, height: $0.height * scaleY) }
        }
        var occupied: [CGRect] = []
        place(selectionButton, rects: positions(geometry.selection?.1 ?? []),
              size: CGSize(width: configuration.language == "en" ? 82 : 70, height: 28), occupied: &occupied)

        let active = Set(geometry.markers.keys.filter { configuration.notes[$0]?.anchor.url == geometry.url })
        removeMarkers(except: active)
        let marks = CGMutablePath()
        for id in active.sorted() {
            let rects = positions(geometry.markers[id] ?? [])
            for rect in rects {
                marks.addRect(CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: min(rect.height, 2)))
            }
            place(marker(for: id), rects: rects, size: CGSize(width: 29, height: 28), occupied: &occupied)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        underlines.frame = overlay.bounds
        underlines.path = marks
        CATransaction.commit()
    }

    private func configureButton(_ button: NSButton, action: Selector) {
        button.target = self
        button.action = action
        button.isBordered = false
        button.isHidden = true
        button.wantsLayer = true
        button.layer?.backgroundColor = NSColor(srgbRed: 0.97, green: 0.91, blue: 0.72, alpha: 1).cgColor
        button.layer?.borderColor = NSColor(srgbRed: 0.45, green: 0.36, blue: 0.22, alpha: 1).cgColor
        button.layer?.borderWidth = 1
        button.layer?.cornerRadius = 6
        button.contentTintColor = NSColor(srgbRed: 0.25, green: 0.20, blue: 0.12, alpha: 1)
        button.font = .systemFont(ofSize: 12, weight: .semibold)
    }

    private func marker(for id: String) -> NSButton {
        if let button = markers[id] { return button }
        let button = NSButton()
        button.identifier = NSUserInterfaceItemIdentifier(id)
        let name = localized("查看网页笔记", "Open webpage note")
        button.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: name)
        if button.image == nil { button.title = "✎" }
        button.setAccessibilityLabel(name)
        configureButton(button, action: #selector(openNote(_:)))
        overlay.addSubview(button)
        markers[id] = button
        return button
    }

    private func removeMarkers(except ids: Set<String>) {
        for id in markers.keys.filter({ !ids.contains($0) }) {
            markers.removeValue(forKey: id)?.removeFromSuperview()
        }
    }

    private func place(_ button: NSButton, rects: [CGRect], size: CGSize, occupied: inout [CGRect]) {
        let bounds = overlay.bounds.insetBy(dx: 3, dy: 3)
        guard bounds.width >= size.width, bounds.height >= size.height else { button.isHidden = true; return }
        for rect in rects {
            let visibleText = rect.intersection(bounds)
            guard !visibleText.isEmpty else { continue }
            let x = min(max(bounds.minX, visibleText.maxX + 4), bounds.maxX - size.width)
            for row in [visibleText.midY - size.height / 2, visibleText.maxY + 4, visibleText.minY - size.height - 4] {
                let y = min(max(bounds.minY, row), bounds.maxY - size.height)
                let frame = CGRect(origin: CGPoint(x: x, y: y), size: size)
                guard !occupied.contains(where: { $0.intersects(frame) }) else { continue }
                button.frame = frame
                button.isHidden = false
                occupied.append(frame)
                return
            }
        }
        button.isHidden = true
    }

    @objc private func addNote() { _ = begin() }

    func begin() -> Bool {
        guard visible, !selectionButton.isHidden, let anchor = geometry?.selection?.0,
              browser?.url.flatMap({ Self.documentAddress($0.absoluteString) }) == anchor.url else { return false }
        let note = draft.flatMap { $0.anchor == anchor && configuration.notes[$0.id] == nil ? $0 : nil }
            ?? Note(id: UUID().uuidString.lowercased(), anchor: anchor, text: "")
        return open(note, from: selectionButton)
    }

    @objc private func openNote(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let note = configuration.notes[id] else { return }
        _ = open(draft?.id == id ? (draft ?? note) : note, from: sender)
    }

    private func open(_ note: Note, from button: NSButton) -> Bool {
        guard visible, pending == nil, button.window != nil else { return false }
        if popover?.isShown == true { return true }
        let editor = AnnotationEditor(note: note, existing: configuration.notes[note.id] != nil, language: configuration.language)
        editor.onClose = { [weak self] in self?.closeEditor() }
        editor.onAction = { [weak self] action, note in self?.request(action: action, note: note) }
        let popover = NSPopover()
        _ = editor.view // Resolve the editor's preferred size before presenting it.
        popover.contentViewController = editor
        popover.contentSize = editor.preferredContentSize
        popover.behavior = .applicationDefined
        self.editor = editor
        self.popover = popover
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        editor.view.window?.makeFirstResponder(editor.input)
        return popover.isShown
    }

    private func request(action: String, note: Note) {
        guard pending == nil else { return }
        let requestId = UUID().uuidString.lowercased()
        pending = Pending(requestId: requestId, action: action, note: note)
        editor?.setPending(true)
        onAction(["requestId": requestId, "action": action, "note": note.json])
    }

    func resolve(requestId: String, ok: Bool) -> Bool {
        guard let pending, pending.requestId == requestId else { return false }
        self.pending = nil
        if ok {
            if draft?.id == pending.note.id { draft = nil }
            if pending.action == "delete" { configuration.notes.removeValue(forKey: pending.note.id) }
            else { configuration.notes[pending.note.id] = pending.note }
            closeEditor()
            sendAnchors()
            layout()
        } else {
            editor?.setPending(false, error: true)
        }
        return true
    }

    private func closeEditor(keepDraft: Bool = false) {
        if let editing = editor?.currentNote {
            if keepDraft && editing.text != (configuration.notes[editing.id]?.text ?? "") { draft = editing }
            else if draft?.id == editing.id { draft = nil }
        }
        popover?.close()
        popover = nil
        editor = nil
    }

    private func localized(_ chinese: String, _ english: String) -> String {
        configuration.language == "zh-CN" ? chinese : english
    }

    nonisolated fileprivate static func string(_ value: Any?, limit: Int) -> String? {
        guard let value = value as? String, value.utf16.count <= limit, !value.contains("\0") else { return nil }
        return value
    }

    nonisolated private static func documentAddress(_ address: String) -> String? {
        guard address.utf16.count <= 2_048, let url = BrowserAddress.url(address),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.fragment = nil
        return parts.string
    }

    nonisolated private static func number(_ input: Any?, limit: CGFloat) -> CGFloat? {
        guard let value = input as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = CGFloat(value.doubleValue)
        return number.isFinite && abs(number) <= limit ? number : nil
    }
}

@MainActor
private final class AnnotationEditor: NSViewController, NSTextViewDelegate {
    private static let editorSize = NSSize(width: 340, height: 274)
    private let original: InlinePageAnnotations.Note
    private let existing: Bool
    private let chinese: Bool
    private let scroll = NSTextView.scrollableTextView()
    var input: NSTextView { scroll.documentView as! NSTextView }
    private let saveButton = NSButton()
    private let deleteButton = NSButton()
    private let closeButton = NSButton()
    private let status = NSTextField(labelWithString: "")
    var onAction: ((String, InlinePageAnnotations.Note) -> Void)?
    var onClose: (() -> Void)?

    init(note: InlinePageAnnotations.Note, existing: Bool, language: String) {
        original = note
        self.existing = existing
        chinese = language == "zh-CN"
        super.init(nibName: nil, bundle: nil)
        preferredContentSize = Self.editorSize
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let content = NSView(frame: NSRect(origin: .zero, size: Self.editorSize))
        content.wantsLayer = true
        content.appearance = NSAppearance(named: .aqua)
        content.layer?.backgroundColor = NSColor(srgbRed: 0.98, green: 0.95, blue: 0.87, alpha: 1).cgColor

        let title = NSTextField(labelWithString: text("网页笔记", "Webpage note"))
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let quote = NSTextField(wrappingLabelWithString: original.anchor.quote)
        quote.font = .systemFont(ofSize: 12)
        quote.textColor = .secondaryLabelColor
        quote.maximumNumberOfLines = 3
        quote.lineBreakMode = .byTruncatingTail

        scroll.borderType = .bezelBorder
        scroll.autohidesScrollers = true
        input.isRichText = false
        input.isAutomaticQuoteSubstitutionEnabled = false
        input.isAutomaticDashSubstitutionEnabled = false
        input.textContainerInset = NSSize(width: 7, height: 7)
        input.font = .systemFont(ofSize: 13)
        input.string = original.text
        input.setAccessibilityLabel(text("笔记内容", "Note text"))
        input.delegate = self

        configure(saveButton, text("保存", "Save"), action: #selector(save))
        saveButton.keyEquivalent = "\r"
        saveButton.keyEquivalentModifierMask = [.command]
        configure(closeButton, text("关闭", "Close"), action: #selector(close))
        closeButton.keyEquivalent = "\u{1b}"
        configure(deleteButton, text("删除", "Delete"), action: #selector(deleteNote))
        deleteButton.isHidden = !existing
        status.font = .systemFont(ofSize: 11)
        status.textColor = .systemRed
        status.lineBreakMode = .byTruncatingTail

        let buttons = NSStackView(views: [deleteButton, status, closeButton, saveButton])
        buttons.spacing = 6
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [title, quote, scroll, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        // Popovers may derive their size from the controller's fitting size. Keep the
        // note field wide even if the selected quotation and controls are very short.
        let preferredWidth = content.widthAnchor.constraint(equalToConstant: Self.editorSize.width)
        let preferredHeight = content.heightAnchor.constraint(equalToConstant: Self.editorSize.height)
        preferredWidth.priority = .defaultHigh
        preferredHeight.priority = .defaultHigh
        NSLayoutConstraint.activate([
            preferredWidth, preferredHeight,
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
            quote.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 100),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        view = content
        updateSave()
    }

    func textDidChange(_ notification: Notification) { updateSave() }

    var currentNote: InlinePageAnnotations.Note {
        var note = original
        note.text = input.string
        return note
    }

    func setPending(_ pending: Bool, error: Bool = false) {
        input.isEditable = !pending
        deleteButton.isEnabled = !pending
        closeButton.isEnabled = !pending
        status.stringValue = error ? text("保存失败，请重试", "Could not save. Retry.") : ""
        updateSave()
    }

    private func configure(_ button: NSButton, _ title: String, action: Selector) {
        button.title = title
        button.bezelStyle = .rounded
        button.target = self
        button.action = action
    }

    private func updateSave() {
        let valid = !input.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && InlinePageAnnotations.string(input.string, limit: 100_000) != nil
        saveButton.isEnabled = input.isEditable && valid
    }

    @objc private func save() {
        guard saveButton.isEnabled else { return }
        onAction?("save", currentNote)
    }

    @objc private func close() { onClose?() }

    @objc private func deleteNote() { onAction?("delete", original) }

    private func text(_ chineseText: String, _ englishText: String) -> String { chinese ? chineseText : englishText }
}

extension InlinePageAnnotations {
    /// Reads shared DOM text from an isolated world. All controls and edits remain native.
    private static let script = #"""
    (() => {
      const receiver = window.webkit.messageHandlers.vibeAnnotationGeometry;
      const skip = "script,style,noscript,template,select,textarea,input,button,[hidden],[contenteditable]:not([contenteditable='false'])";
      const maximumText = 400000;
      let index, selection, anchors = [], resolved = [], pendingFrame = 0, pendingIndex = 0;
      let currentURL = "";

      function address() {
        const url = new URL(location.href);
        url.hash = "";
        return url.href;
      }

      function checkDocument() {
        const next = address();
        if (next === currentURL) return;
        currentURL = next;
        anchors = [];
        resolved = [];
        selection = undefined;
        index = undefined;
        receiver.postMessage({ kind: "document", url: currentURL });
      }

      function firstAfter(items, before) {
        let start = 0, end = items.length;
        while (start < end) {
          const middle = (start + end) >> 1;
          if (before(items[middle])) start = middle + 1;
          else end = middle;
        }
        return start;
      }

      function textIndex() {
        if (index || !document.body) return index;
        const text = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: node => node.data.length && node.parentElement && !node.parentElement.closest(skip)
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        const entries = [], fragments = [], byNode = new Map();
        let node, rawLength = 0;
        while (entries.length < 25000 && rawLength < maximumText && (node = text.nextNode())) {
          const content = node.data.slice(0, maximumText - rawLength);
          const item = { node, start: rawLength, end: rawLength + content.length };
          entries.push(item);
          byNode.set(node, item);
          fragments.push(content);
          rawLength = item.end;
        }

        const raw = fragments.join("");
        const words = [], pieces = [];
        let length = 0;
        for (const match of raw.matchAll(/\S+/g)) {
          if (length) length += 1;
          words.push({ start: length, end: length + match[0].length, rawStart: match.index });
          pieces.push(match[0]);
          length += match[0].length;
        }
        return index = { entries, byNode, words, rawLength, text: pieces.join(" ") };
      }

      function rawOffset(documentIndex, node, offset) {
        const item = documentIndex.byNode.get(node);
        if (item) return offset <= item.end - item.start ? item.start + offset : -1;
        if (node.nodeType === Node.TEXT_NODE) return -1;
        const boundary = document.createRange();
        boundary.setStart(node, offset);
        boundary.collapse(true);
        const next = firstAfter(documentIndex.entries, item => boundary.comparePoint(item.node, 0) < 0);
        return documentIndex.entries[next]?.start ?? documentIndex.rawLength;
      }

      function anchorFor(range) {
        const data = textIndex();
        if (!data || !data.words.length || range.collapsed) return;
        const startElement = range.startContainer.parentElement, endElement = range.endContainer.parentElement;
        if (!startElement || !endElement || startElement.closest(skip) || endElement.closest(skip)) return;
        const start = rawOffset(data, range.startContainer, range.startOffset);
        const end = rawOffset(data, range.endContainer, range.endOffset);
        if (start < 0 || end <= start || end - start > 6000) return;

        const first = firstAfter(data.words, word => word.rawStart + word.end - word.start <= start);
        const last = firstAfter(data.words, word => word.rawStart < end) - 1;
        if (first > last) return;
        const firstWord = data.words[first], lastWord = data.words[last];
        const from = firstWord.start + Math.max(0, start - firstWord.rawStart);
        const to = Math.min(lastWord.end, lastWord.start + end - lastWord.rawStart);
        const quote = data.text.slice(from, to);
        if (!quote.length || quote.length > 1000 || quote.includes("\0")) return;
        const prefix = data.text.slice(Math.max(0, from - 120), from).replace(/^[\uDC00-\uDFFF]/, "");
        const suffix = data.text.slice(to, to + 120).replace(/[\uD800-\uDBFF]$/, "");
        return { quote, prefix, suffix };
      }

      function restoredRange(data, from, length) {
        const to = from + length;
        const firstWord = data.words[firstAfter(data.words, word => word.end <= from)];
        const lastWord = data.words[firstAfter(data.words, word => word.start < to) - 1];
        if (!firstWord || !lastWord) return;
        const start = firstWord.rawStart + from - firstWord.start;
        const end = lastWord.rawStart + to - lastWord.start;
        const first = data.entries[firstAfter(data.entries, item => item.end <= start)];
        const last = data.entries[firstAfter(data.entries, item => item.end < end)];
        if (!first || !last || !first.node.isConnected || !last.node.isConnected) return;
        const range = document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        const rect = range.getBoundingClientRect();
        if (rect.width && rect.height) return range;
      }

      function matches(data, quote) {
        const positions = [];
        let start = 0, position;
        while ((position = data.text.indexOf(quote, start)) >= 0) {
          if (positions.length === 64) return [];
          positions.push(position);
          start = position + 1;
        }
        return positions;
      }

      function restore() {
        resolved = [];
        if (!anchors.length) return;
        const data = textIndex();
        if (!data) return;
        const seen = new Map();
        for (const { id, anchor: { quote, prefix, suffix } } of anchors) {
          if (!seen.has(quote)) seen.set(quote, matches(data, quote));
          const positions = seen.get(quote);
          const candidates = positions.length < 2 ? positions : positions.filter(position =>
            data.text.slice(Math.max(0, position - prefix.length), position) === prefix &&
            data.text.slice(position + quote.length, position + quote.length + suffix.length) === suffix);
          let located;
          for (const position of candidates) {
            const range = restoredRange(data, position, quote.length);
            if (!range) continue;
            if (located) { located = undefined; break; }
            located = range;
          }
          if (located) resolved.push({ id, range: located });
        }
      }

      function viewport() {
        const view = window.visualViewport;
        return {
          x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0,
          width: view?.width ?? innerWidth, height: view?.height ?? innerHeight
        };
      }

      function boxes(range, view) {
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) return [];
        const result = [];
        for (const rect of range.getClientRects()) {
          const x = rect.left - view.x, y = rect.top - view.y;
          if (x < view.width && y < view.height && x + rect.width > 0 && y + rect.height > 0 &&
              rect.width > 0 && rect.height > 0) {
            const left = Math.max(x, 0), top = Math.max(y, 0);
            result.push({ x: left, y: top, width: Math.min(x + rect.width, view.width) - left,
              height: Math.min(y + rect.height, view.height) - top });
            if (result.length === 12) break;
          }
        }
        return result;
      }

      function report() {
        pendingFrame = 0;
        checkDocument();
        const view = viewport();
        if (view.width <= 0 || view.height <= 0) return;
        const markers = [];
        for (const { id, range } of resolved) {
          const rects = boxes(range, view);
          if (rects.length) markers.push({ id, rects });
          if (markers.length === 100) break;
        }
        const selected = selection ? { anchor: selection.anchor, rects: boxes(selection.range, view) } : null;
        receiver.postMessage({ kind: "geometry", url: currentURL,
          viewport: { width: view.width, height: view.height }, selection: selected, markers });
      }

      function reflow() {
        if (!pendingFrame) pendingFrame = requestAnimationFrame(report);
      }

      function selected(event) {
        if (!event.isTrusted) return;
        checkDocument();
        const value = getSelection();
        const range = value?.rangeCount && !value.isCollapsed ? value.getRangeAt(0).cloneRange() : undefined;
        const anchor = range && anchorFor(range);
        selection = anchor ? { anchor, range } : undefined;
        reflow();
      }

      window.vibeInlineAnnotationLayout = {
        setAnchors(url, next) {
          checkDocument();
          if (url !== currentURL) return;
          anchors = next;
          restore();
          reflow();
        }
      };
      window.addEventListener("pointerup", selected, { capture: true, passive: true });
      window.addEventListener("keyup", selected, { capture: true, passive: true });
      window.addEventListener("popstate", reflow);
      window.addEventListener("hashchange", reflow);
      window.addEventListener("scroll", reflow, { capture: true, passive: true });
      window.addEventListener("resize", reflow);
      window.visualViewport?.addEventListener("resize", reflow);
      window.visualViewport?.addEventListener("scroll", reflow);
      new MutationObserver(() => {
        index = undefined;
        if (pendingIndex) return;
        pendingIndex = setTimeout(() => {
          pendingIndex = 0;
          checkDocument();
          restore();
          reflow();
        }, 250);
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      checkDocument();
    })();
    """#
}
