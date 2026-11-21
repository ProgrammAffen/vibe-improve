import Foundation
import NaturalLanguage
import PDFKit
import Vision
import Darwin

enum ResourceExtractors {
    static func format(_ fileExtension: String) -> String {
        switch fileExtension.lowercased() {
        case "pdf": return "pdf"
        case "docx", "md", "markdown", "txt", "rtf", "csv", "tsv", "text": return "document"
        case "srt", "vtt": return "captions"
        case "m4a", "mp3", "wav", "aac", "aif", "aiff", "flac", "ogg": return "audio"
        case "mp4", "m4v", "mov", "webm", "mkv", "avi": return "video"
        default: return "file"
        }
    }

    static func extract(_ item: LearningResource) -> ResourceExtraction {
        if item.isLink {
            guard let url = PublicResourceWeb.address(item.origin) else { return failure("invalidLink") }
            return PublicResourceWeb.fetch(url)
        }
        guard let url = try? fileURL(item) else { return failure("moved") }
        do {
            switch item.format {
            case "pdf":
                return try pdf(data: read(url, stamp: item.stamp, maximum: 32 * 1024 * 1024))
            case "document":
                return try document(url, stamp: item.stamp)
            case "captions":
                return captions(try read(url, stamp: item.stamp, maximum: 1024 * 1024))
            case "audio", "video":
                if let data = item.captions { return captions(data) }
                if let embedded = ResourceMedia.embeddedCaptions(url) { return embedded }
                return ResourceExtraction(status: .attachment, reason: "captionsNeeded")
            default:
                return ResourceExtraction(status: .attachment, reason: "unsupported")
            }
        } catch ResourceError.limit {
            return ResourceExtraction(status: .attachment, reason: "fileTooLarge")
        } catch {
            return failure("readFailed")
        }
    }

    static func failure(_ reason: String) -> ResourceExtraction { ResourceExtraction(status: .needsAttention, reason: reason) }

    static func fileURL(_ item: LearningResource) throws -> URL {
        let url = URL(fileURLWithPath: item.origin)
        guard !item.isLink, !item.removed, let expected = item.stamp, stamp(url) == expected else { throw ResourceError.unavailable }
        return url
    }

    private static func identity(_ metadata: stat) -> String {
        "\(metadata.st_dev):\(metadata.st_ino):\(metadata.st_size):\(metadata.st_mtimespec.tv_sec):\(metadata.st_mtimespec.tv_nsec)"
    }

    static func stamp(_ url: URL) -> String? {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG else { return nil }
        return identity(metadata)
    }

    static func read(_ url: URL, stamp expected: String?, maximum: Int) throws -> Data {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw ResourceError.unavailable }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              expected == nil || expected == identity(metadata) else { throw ResourceError.unavailable }
        guard metadata.st_size <= maximum else { throw ResourceError.limit }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw ResourceError.unavailable }
            if count == 0 { break }
            guard bytes.count + count <= maximum else { throw ResourceError.limit }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard fstat(descriptor, &metadata) == 0, expected == nil || expected == identity(metadata) else { throw ResourceError.unavailable }
        return bytes
    }

    static func cleaned(_ text: String) -> String {
        text.replacingOccurrences(of: "[\\p{Cc}\\p{Cf}\\s]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func decoded(_ data: Data) -> String? {
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) { return String(data: data, encoding: .utf16) }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else { return nil }
        return text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
    }

    static func excerpts(_ entries: [(ResourceLocation, String)], minimumLetters: Int = 3,
                         partialReason: String? = nil, emptyReason: String = "empty", read: Int? = nil, total: Int? = nil) -> ResourceExtraction {
        let usable = entries.compactMap { location, raw -> (ResourceLocation, String)? in
            let text = String(cleaned(raw).prefix(1_100))
            guard text.unicodeScalars.lazy.filter({ CharacterSet.letters.contains($0) }).prefix(minimumLetters).count >= minimumLetters else { return nil }
            return (location, text)
        }
        guard !usable.isEmpty else { return failure(emptyReason) }
        let indexes = usable.count <= 12 ? Array(usable.indices) : (0..<12).map { $0 * (usable.count - 1) / 11 }
        let sample = indexes.map { index in ResourceSegment(id: "s\(index + 1)", location: usable[index].0, text: usable[index].1) }
        return ResourceExtraction(status: partialReason == nil ? .ready : .partial, reason: partialReason, segments: sample, read: read, total: total)
    }

    static func overview(_ segments: [ResourceSegment]) -> String? {
        guard let first = segments.first else { return nil }
        let tokenizer = NLTokenizer(unit: .sentence)
        var sentences: [String] = []
        var seen = Set<String>()
        for segment in segments {
            tokenizer.string = segment.text
            tokenizer.enumerateTokens(in: segment.text.startIndex..<segment.text.endIndex) { range, _ in
                let sentence = cleaned(String(segment.text[range]))
                let complete = sentence.last.map { ".!?。！？\"”".contains($0) } ?? false
                if (sentence.count >= 60 || complete && sentence.count >= 14),
                   sentence.unicodeScalars.lazy.filter({ CharacterSet.letters.contains($0) }).prefix(10).count == 10,
                   seen.insert(sentence).inserted {
                    sentences.append(sentence)
                }
                return true
            }
        }
        if sentences.isEmpty { sentences = [cleaned(first.text)] }
        let count = min(3, sentences.count)
        return (0..<count).map { index in
            let sentence = sentences[count == 1 ? 0 : index * (sentences.count - 1) / (count - 1)]
            return sentence.count <= 160 ? sentence : String(sentence.prefix(160)) + "…"
        }.joined(separator: "\n")
    }

    static func pdf(data: Data) -> ResourceExtraction {
        guard let document = PDFDocument(data: data), document.pageCount > 0 else { return failure("readFailed") }
        guard !document.isLocked else { return failure("encrypted") }
        let pageCount = document.pageCount
        var pages: [(ResourceLocation, String)] = [], ocrCount = 0
        for position in 0..<min(80, pageCount) {
            guard let page = document.page(at: position) else { continue }
            var text = cleaned(page.string ?? "")
            if text.count < 18 && ocrCount < 20 {
                ocrCount += 1
                if let recognized = recognize(page), recognized.count > text.count { text = recognized }
            }
            if text.unicodeScalars.contains(where: { CharacterSet.letters.contains($0) }) {
                pages.append((ResourceLocation(kind: "page", start: position + 1), text))
            }
        }
        return excerpts(pages, minimumLetters: 1, partialReason: pages.count == pageCount ? nil : "somePages",
                        read: pages.count, total: pageCount)
    }

    private static func recognize(_ page: PDFPage) -> String? {
        let size = page.bounds(for: .mediaBox).size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
        let factor = 1440.0 / max(size.width, size.height)
        let image = page.thumbnail(of: CGSize(width: max(1, size.width * factor), height: max(1, size.height * factor)), for: .mediaBox)
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let supported = (try? request.supportedRecognitionLanguages()) ?? []
        request.recognitionLanguages = ["zh-Hans", "en-US"].filter(supported.contains)
        request.usesLanguageCorrection = true
        guard (try? VNImageRequestHandler(cgImage: cgImage).perform([request])) != nil else { return nil }
        return cleaned((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " "))
    }

    private static func document(_ url: URL, stamp: String?) throws -> ResourceExtraction {
        let ext = url.pathExtension.lowercased()
        let paragraphs: [String]
        if ext == "docx" {
            guard self.stamp(url) == stamp else { throw ResourceError.unavailable }
            let output = try ResourceCommand.run("/usr/bin/unzip", ["-p", url.path, "word/document.xml"], maximum: 4 * 1024 * 1024, seconds: 10)
            guard self.stamp(url) == stamp, output.status == 0 else { throw ResourceError.unavailable }
            let reader = ResourceWordText()
            let parser = XMLParser(data: output.bytes)
            parser.shouldResolveExternalEntities = false
            parser.delegate = reader
            guard parser.parse() else { throw ResourceError.unavailable }
            paragraphs = reader.paragraphs
        } else {
            let data = try read(url, stamp: stamp, maximum: 2 * 1024 * 1024)
            let value: String?
            if ext == "rtf" {
                value = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil).string
            } else { value = decoded(data) }
            guard let value else { return failure("encoding") }
            paragraphs = value.components(separatedBy: .newlines)
        }
        var entries: [(ResourceLocation, String)] = []
        var text = "", start = 1
        var skippedLongText = false
        for (index, line) in paragraphs.enumerated() {
            let paragraph = cleaned(line)
            if paragraph.isEmpty { continue }
            if !text.isEmpty && text.count + paragraph.count > 900 {
                entries.append((ResourceLocation(kind: "paragraph", start: start, end: index), text))
                text = ""
            }
            if text.isEmpty { start = index + 1 }
            if paragraph.count > 1_100 { skippedLongText = true }
            text += (text.isEmpty ? "" : " ") + String(paragraph.prefix(1_100))
            if entries.count >= 1500 { skippedLongText = true; break }
        }
        if !text.isEmpty { entries.append((ResourceLocation(kind: "paragraph", start: start, end: paragraphs.count), text)) }
        return excerpts(entries, partialReason: skippedLongText ? "sizeLimited" : nil)
    }

    static func captions(_ data: Data, within ranges: [ResourceLocation]? = nil) -> ResourceExtraction {
        guard let file = decoded(data) else { return failure("encoding") }
        let content = file.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let time = #"(?m)^(\d{1,3}:)?(\d{2}):(\d{2})[,.](\d{3})[ \t]+-->[ \t]+(\d{1,3}:)?(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n"#
        let regex = try! NSRegularExpression(pattern: time)
        var cues: [(ResourceLocation, String)] = []
        var incomplete = false
        for block in content.components(separatedBy: "\n\n").prefix(10_000) {
            let source = block as NSString
            guard let match = regex.firstMatch(in: block, range: NSRange(location: 0, length: source.length)) else {
                if block.contains("-->") { incomplete = true }
                continue
            }
            func integer(_ index: Int) -> Int {
                let range = match.range(at: index)
                return range.location == NSNotFound ? 0 : Int(source.substring(with: range).trimmingCharacters(in: CharacterSet(charactersIn: ":"))) ?? 0
            }
            let start = (integer(1) * 3600 + integer(2) * 60 + integer(3)) * 1000 + integer(4)
            let end = (integer(5) * 3600 + integer(6) * 60 + integer(7)) * 1000 + integer(8)
            guard start < end, integer(2) < 60, integer(3) < 60, integer(6) < 60, integer(7) < 60 else { incomplete = true; continue }
            let text = PublicResourceWeb.entities(source.substring(from: NSMaxRange(match.range)).replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression))
            let cue = cleaned(text)
            if cue.isEmpty { incomplete = true; continue }
            if let ranges, !ranges.contains(where: { start <= ($0.end ?? $0.start) && end >= $0.start }) { continue }
            if let last = cues.last, start >= last.0.start, start - (last.0.end ?? start) < 2500, end - last.0.start <= 30_000,
               last.1.count + cue.count < 1050 {
                cues[cues.count - 1] = (ResourceLocation(kind: "time", start: last.0.start, end: end), last.1 + " " + cue)
            } else { cues.append((ResourceLocation(kind: "time", start: start, end: end), cue)) }
        }
        let selected = ranges.map { ranges in cues.filter { cue in ranges.contains { cue.0.start <= ($0.end ?? $0.start) && (cue.0.end ?? cue.0.start) >= $0.start } } } ?? cues
        return excerpts(selected, partialReason: incomplete ? "someCaptions" : nil, emptyReason: "invalidCaptions")
    }
}

private final class ResourceWordText: NSObject, XMLParserDelegate {
    private(set) var paragraphs: [String] = []
    private var buffer = "", collecting = false, paragraphDepth = 0
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        if name == "w:p" { paragraphDepth += 1 }
        if name == "w:t", paragraphDepth > 0 { collecting = true }
        if ["w:tab", "w:br"].contains(name), paragraphDepth > 0 { buffer += " " }
    }
    func parser(_ parser: XMLParser, foundCharacters text: String) {
        if collecting && buffer.count < 2_000 { buffer += String(text.prefix(2_000)) }
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if name == "w:t" { collecting = false }
        if name == "w:p" {
            paragraphDepth -= 1
            if !buffer.isEmpty { paragraphs.append(buffer); buffer = "" }
        }
    }
}

enum ResourceCommand {
    static func run(_ executable: String, _ arguments: [String], maximum: Int, seconds: Double,
                    continueWhile: (() -> Bool)? = nil) throws -> (bytes: Data, status: Int32) {
        let process = Process(), channel = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = channel
        process.standardError = FileHandle.nullDevice
        try process.run()
        let timeout = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let deadline = DispatchTime.now() + seconds
        if continueWhile == nil { timeout.schedule(deadline: deadline) }
        else { timeout.schedule(deadline: .now(), repeating: .milliseconds(250)) }
        timeout.setEventHandler {
            if (DispatchTime.now() >= deadline || continueWhile?() == false), process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        timeout.resume()
        defer {
            timeout.cancel()
            if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() }
            try? channel.fileHandleForReading.close()
        }
        var data = Data()
        while let next = try channel.fileHandleForReading.read(upToCount: 8192), !next.isEmpty {
            guard data.count + next.count <= maximum else { throw ResourceError.limit }
            data.append(next)
        }
        process.waitUntilExit()
        return (data, process.terminationStatus)
    }
}
