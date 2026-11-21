import Foundation
import Darwin

/// Holds an already authorized file descriptor, never a client-provided path.
final class LessonPreviewStream {
    static let maximumChunkBytes = 65_536
    private let lock = NSLock()
    private var descriptor: Int32
    private var cursor = 0
    private var remaining: Int
    private let expectedStamp: String
    init(descriptor: Int32, length: Int, expectedStamp: String) throws {
        self.descriptor = dup(descriptor)
        self.remaining = length
        self.expectedStamp = expectedStamp
        guard self.descriptor >= 0 else { throw LessonError.preview }
        _ = fcntl(self.descriptor, F_SETFD, FD_CLOEXEC)
    }
    deinit { close() }
    func close() {
        lock.lock(); defer { lock.unlock() }
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 }
        remaining = 0
    }
    func next() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard remaining > 0, descriptor >= 0 else { return nil }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              expectedStamp == "\(metadata.st_dev):\(metadata.st_ino):\(metadata.st_size):\(metadata.st_mtimespec.tv_sec):\(metadata.st_mtimespec.tv_nsec)"
        else { throw LessonError.preview }
        var buffer = [UInt8](repeating: 0, count: min(Self.maximumChunkBytes, remaining))
        while true {
            let amount = pread(descriptor, &buffer, buffer.count, off_t(cursor))
            if amount < 0 && errno == EINTR { continue }
            guard amount > 0 else { throw LessonError.preview }
            cursor += amount; remaining -= amount
            return Data(buffer.prefix(amount))
        }
    }
}

struct LessonPreviewResponse {
    let code: String
    let headers: [String: String]
    let data: Data
    let stream: LessonPreviewStream?
    init(code: String, headers: [String: String], data: Data, stream: LessonPreviewStream? = nil) {
        self.code = code; self.headers = headers; self.data = data; self.stream = stream
    }
}

/// Opaque, expiring capabilities. Neither paths nor arbitrary URLs enter the HTTP endpoint.
final class LessonPreviewStore {
    static let maximumRangeBytes = 8 * 1024 * 1024
    private struct Grant { let identity: LessonIdentity; let ref: ResourceSelection; let expires: Date }
    private var grants: [String: Grant] = [:]
    private let lock = NSLock()
    private let store: LessonStore
    init(store: LessonStore) { self.store = store }
    private func mime(_ extensionName: String) -> String? {
        ["pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
         "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg",
         "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
         "txt": "text/plain; charset=utf-8", "md": "text/markdown; charset=utf-8", "markdown": "text/markdown; charset=utf-8",
         "csv": "text/plain; charset=utf-8", "tsv": "text/plain; charset=utf-8", "srt": "text/plain; charset=utf-8", "vtt": "text/vtt; charset=utf-8"][extensionName.lowercased()]
    }
    func issue(_ identity: LessonIdentity, ref: ResourceSelection) throws -> [String: Any] {
        let item = try store.previewResource(identity, ref)
        if item.isLink {
            guard let url = PublicResourceWeb.address(item.origin) else { throw LessonError.preview }
            return ["url": url.absoluteString, "mimeType": "text/uri-list", "name": item.name]
        }
        let file = try ResourceExtractors.fileURL(item)
        guard let type = mime(file.pathExtension) else { throw LessonError.preview }
        let token = UUID().uuidString.lowercased() + UUID().uuidString.lowercased()
        lock.lock(); defer { lock.unlock() }
        grants = grants.filter { $0.value.expires > Date() }
        guard grants.count < 2048 else { throw LessonError.preview }
        grants[token] = Grant(identity: identity, ref: ref, expires: Date().addingTimeInterval(3600))
        return ["url": "/vibe-improve/lesson-preview/" + token, "mimeType": type, "name": item.name]
    }
    func response(_ token: String, range: String?, head: Bool) throws -> LessonPreviewResponse {
        guard token.range(of: "^[a-f0-9-]{72}$", options: .regularExpression) != nil else { throw LessonError.preview }
        lock.lock(); let grant = grants[token]; lock.unlock()
        guard let grant, grant.expires > Date() else { throw LessonError.preview }
        let item = try store.previewResource(grant.identity, grant.ref)
        let file = try ResourceExtractors.fileURL(item)
        guard let type = mime(file.pathExtension) else { throw LessonError.preview }
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw LessonError.preview }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size >= 0,
              item.stamp == "\(metadata.st_dev):\(metadata.st_ino):\(metadata.st_size):\(metadata.st_mtimespec.tv_sec):\(metadata.st_mtimespec.tv_nsec)" else { throw LessonError.preview }
        let size = Int(metadata.st_size)
        var first = 0, end = size, code = "200 OK"
        var headers = ["Content-Type": type, "Accept-Ranges": "bytes", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox"]
        if let range {
            let values = range.hasPrefix("bytes=") && !range.contains(",") ? range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false) : []
            guard values.count == 2 else { return LessonPreviewResponse(code: "416 Range Not Satisfiable", headers: ["Content-Range": "bytes */\(size)"], data: Data()) }
            if values[0].isEmpty, let suffix = Int(values[1]), suffix > 0 { first = max(0, size - suffix) }
            else if let start = Int(values[0]), start >= 0 { first = start; if !values[1].isEmpty, let last = Int(values[1]), last >= start { end = last >= size - 1 ? size : last + 1 } else if !values[1].isEmpty { first = size } }
            else { first = size }
            guard first < size, end > first else { return LessonPreviewResponse(code: "416 Range Not Satisfiable", headers: ["Content-Range": "bytes */\(size)"], data: Data()) }
            if values[0].isEmpty { first = max(first, end - Self.maximumRangeBytes) }
            end = first + min(end - first, Self.maximumRangeBytes)
            code = "206 Partial Content"; headers["Content-Range"] = "bytes \(first)-\(end - 1)/\(size)"
        }
        headers["Content-Length"] = String(end - first)
        if head { return LessonPreviewResponse(code: code, headers: headers, data: Data()) }
        if range == nil && size > Self.maximumRangeBytes {
            guard let stamp = item.stamp else { throw LessonError.preview }
            let stream = try LessonPreviewStream(descriptor: descriptor, length: size, expectedStamp: stamp)
            return LessonPreviewResponse(code: code, headers: headers, data: Data(), stream: stream)
        }
        guard lseek(descriptor, off_t(first), SEEK_SET) >= 0 else { throw LessonError.preview }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65_536)
        while data.count < end - first {
            let amount = Darwin.read(descriptor, &buffer, min(buffer.count, end - first - data.count))
            if amount < 0 && errno == EINTR { continue }
            guard amount > 0 else { throw LessonError.preview }
            data.append(contentsOf: buffer.prefix(amount))
        }
        return LessonPreviewResponse(code: code, headers: headers, data: data)
    }
}
