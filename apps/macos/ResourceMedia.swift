import AVFoundation
import Cocoa
import AVKit
import PDFKit

enum ResourceMedia {
    static func embeddedCaptions(_ url: URL) -> ResourceExtraction? {
        guard ["mp4", "m4v", "mov"].contains(url.pathExtension.lowercased()) else { return nil }
        let asset = AVURLAsset(url: url)
        let tracks = loadMedia { try await asset.loadTracks(withMediaType: .subtitle) + asset.loadTracks(withMediaType: .text) } ?? []
        for track in tracks {
            guard let description = loadMedia({ try await track.load(.formatDescriptions) })?.first else { continue }
            let subtype = CMFormatDescriptionGetMediaSubType(description)
            guard subtype == 0x74783367 || subtype == 0x74657874 else { continue } // tx3g or text
            guard let reader = try? AVAssetReader(asset: asset) else { continue }
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
            guard reader.canAdd(output) else { continue }
            reader.add(output)
            guard reader.startReading() else { continue }
            var cues: [(ResourceLocation, String)] = []
            var processed = 0
            while processed < 10_000, let sample = output.copyNextSampleBuffer() {
                processed += 1
                let startTime = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                let duration = CMSampleBufferGetDuration(sample).seconds
                guard startTime.isFinite, startTime >= 0, startTime < 3_600_000,
                      duration.isFinite, duration > 0, duration < 3_600_000,
                      let buffer = CMSampleBufferGetDataBuffer(sample) else { continue }
                let size = min(CMBlockBufferGetDataLength(buffer), 65536)
                guard size > 2 else { continue }
                var bytes = [UInt8](repeating: 0, count: size)
                guard CMBlockBufferCopyDataBytes(buffer, atOffset: 0, dataLength: size, destination: &bytes) == noErr else { continue }
                let length = Int(bytes[0]) * 256 + Int(bytes[1])
                guard length > 0, length <= size - 2, let text = ResourceExtractors.decoded(Data(bytes[2..<(length + 2)])) else { continue }
                let location = ResourceLocation(kind: "time", start: Int(startTime * 1000), end: Int((startTime + duration) * 1000))
                cues.append((location, text))
            }
            let partial = reader.status != .completed
            reader.cancelReading()
            let result = ResourceExtractors.excerpts(cues, partialReason: partial ? "someCaptions" : nil)
            if result.status == .ready || result.status == .partial { return result }
        }
        return nil
    }

    private final class ResultBox<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Value?
        var result: Value? {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        func accept(_ result: Value) {
            lock.lock()
            stored = result
            lock.unlock()
        }
    }
    static func loadMedia<Value>(_ operation: @escaping () async throws -> Value) -> Value? {
        let result = ResultBox<Value>(), done = DispatchSemaphore(value: 0)
        let task = Task(priority: .utility) {
            if let value = try? await operation() { result.accept(value) }
            done.signal()
        }
        if done.wait(timeout: .now() + 12) != .success { task.cancel() }
        return result.result
    }
}

final class ResourcePreviewWindows: NSObject, NSWindowDelegate {
    private var windows: [NSWindow] = []
    private var players: [NSWindow: AVPlayer] = [:]

    func open(_ item: LearningResource, location: ResourceLocation?) -> Bool {
        guard !item.removed else { return false }
        if item.isLink, let address = PublicResourceWeb.address(item.origin) {
            return NSWorkspace.shared.open(address)
        }
        guard let url = try? ResourceExtractors.fileURL(item) else { return false }
        if item.format == "pdf", let bytes = try? ResourceExtractors.read(url, stamp: item.stamp, maximum: 32 * 1024 * 1024),
           let document = PDFDocument(data: bytes), !document.isLocked {
            let view = PDFView()
            view.document = document
            view.autoScales = true
            show(item.name, body: view)
            if let location, location.kind == "page", let page = document.page(at: location.start - 1) { view.go(to: page) }
            return true
        }
        if (item.format == "audio" || item.format == "video"), ["m4a", "mp3", "wav", "aac", "aif", "aiff", "mp4", "mov", "m4v"].contains(url.pathExtension.lowercased()) {
            let view = AVPlayerView()
            let player = AVPlayer(url: url)
            view.player = player
            let window = show(item.name, body: view)
            players[window] = player
            if let location, location.kind == "time" {
                player.seek(to: CMTime(value: Int64(location.start), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            return true
        }
        if ["pdf", "document", "captions"].contains(item.format) { return NSWorkspace.shared.open(url) }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return true
    }

    func openTranscript(title: String, text: String) {
        let scrollView = NSTextView.scrollableTextView()
        guard let view = scrollView.documentView as? NSTextView else { return }
        view.isEditable = false
        view.font = .systemFont(ofSize: 15)
        view.textContainerInset = NSSize(width: 24, height: 20)
        view.string = text
        show(title, body: scrollView)
    }

    @discardableResult private func show(_ title: String, body: NSView) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 620),
                              styleMask: [.titled, .resizable, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = body
        windows.append(window)
        window.center()
        window.makeKeyAndOrderFront(nil)
        return window
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        players.removeValue(forKey: window)?.pause()
        windows.removeAll { $0 === window }
    }
}
