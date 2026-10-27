import Foundation
import Darwin

enum ProjectError: String, Error {
    case invalidName = "PROJECT_NAME_INVALID", directoryRequired = "PROJECT_DIRECTORY_REQUIRED"
    case exists = "PROJECT_EXISTS", unavailable = "PROJECT_UNAVAILABLE", invalid = "PROJECT_INVALID"
    case conflict = "PROJECT_CONFLICT", limit = "PROJECT_LIMIT", storage = "PROJECT_STORAGE_UNAVAILABLE"
}

struct ProjectDocument: Codable {
    let format: String
    let schemaVersion: Int
    let id: String
    var name: String
    var revision: Int
    let createdAt: String
    var updatedAt: String
    var lastOpenedAt: String
    let state: String
}

private struct ProjectEntry: Codable {
    let id: String
    let kind: String
    let bookmark: Data
    let path: String
    var document: ProjectDocument
}

final class ProjectStore {
    private let files: RuntimeDirectory
    private var grants: [String: URL] = [:]
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    init(runtime: RuntimeDirectory) throws {
        files = try runtime.child("projects")
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }
    static func validName(_ value: String) -> Bool {
        let name = value.precomposedStringWithCanonicalMapping
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        let stem = name.split(separator: ".", omittingEmptySubsequences: false).first.map(String.init)?.uppercased() ?? ""
        let reserved = ["CON", "PRN", "AUX", "NUL"] + (1...9).flatMap { ["COM\($0)", "LPT\($0)"] }
        return !name.isEmpty && name.unicodeScalars.count <= 80 && name.utf8.count <= 255 && name == name.trimmingCharacters(in: .whitespacesAndNewlines)
            && name != "." && name != ".." && !name.hasSuffix(".") && name.rangeOfCharacter(from: bad) == nil
            && !reserved.contains(stem)
    }
    func grant(_ url: URL) throws -> [String: Any] {
        let selected = url.standardizedFileURL.resolvingSymlinksInPath()
        let fd = open(selected.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ProjectError.unavailable }
        close(fd)
        let token = UUID().uuidString.lowercased()
        grants[token] = selected
        return ["token": token, "path": selected.path, "name": selected.lastPathComponent]
    }
    private func readIndex() throws -> [ProjectEntry] {
        guard let data = try files.read("index.json", maximumBytes: 2_000_000) else { return [] }
        guard let entries = try? decoder.decode([ProjectEntry].self, from: data), entries.count <= 256,
              Set(entries.map(\.id)).count == entries.count,
              entries.allSatisfy({ valid($0.document) && $0.id == $0.document.id && ["draft", "project"].contains($0.kind) }) else { throw ProjectError.storage }
        return entries
    }
    private func saveIndex(_ entries: [ProjectEntry]) throws {
        let data = try encoder.encode(entries)
        guard data.count <= 2_000_000 else { throw ProjectError.limit }
        try files.write("index.json", data: data)
    }
    private func valid(_ document: ProjectDocument) -> Bool {
        document.format == "vibe-improve.project" && document.schemaVersion == 1
            && document.id.range(of: "^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil
            && Self.validName(document.name) && document.revision > 0 && document.revision < 1_000_000
            && document.state == "draft" && [document.createdAt, document.updatedAt, document.lastOpenedAt].allSatisfy({
                let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return ISO8601DateFormatter().date(from: $0) != nil || fractional.date(from: $0) != nil
            })
    }
    private func resolve(_ entry: ProjectEntry) throws -> URL {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: entry.bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale) else { throw ProjectError.unavailable }
        return url.standardizedFileURL
    }
    private func readDocument(at url: URL) throws -> ProjectDocument {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFDIR else { throw ProjectError.unavailable }
        let marker = url.appendingPathComponent(".vibe-improve", isDirectory: true)
        let directory = try RuntimeDirectory(url: marker, create: false)
        let keys: Set<String> = ["format", "schemaVersion", "id", "name", "revision", "createdAt", "updatedAt", "lastOpenedAt", "state"]
        guard let data = try directory.read("project.json", maximumBytes: 32_768),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], Set(value.keys) == keys,
              let document = try? decoder.decode(ProjectDocument.self, from: data), valid(document) else { throw ProjectError.invalid }
        return document
    }
    private func summary(_ document: ProjectDocument, path: String, available: Bool = true, kind: String = "draft") throws -> [String: Any] {
        var result = try JSONSerialization.jsonObject(with: encoder.encode(document)) as! [String: Any]
        result["path"] = path
        result["available"] = available
        result["kind"] = kind
        result["completedNodes"] = 0
        result["totalNodes"] = 0
        return result
    }
    func list() throws -> [[String: Any]] {
        try files.locked {
            try readIndex().map { entry in
                do {
                    let url = try resolve(entry)
                    if entry.kind == "draft" {
                        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                        guard fd >= 0 else { throw ProjectError.unavailable }; close(fd)
                        return try summary(entry.document, path: url.appendingPathComponent(entry.document.name).path)
                    }
                    let document = try readDocument(at: url)
                    guard document.id == entry.id else { throw ProjectError.invalid }
                    return try summary(document, path: url.path, kind: "project")
                } catch { return try summary(entry.document, path: entry.path, available: false, kind: entry.kind) }
            }
        }
    }
    func create(name: String, parentToken: String, commandID: String) throws -> [String: Any] {
        let normalized = name.precomposedStringWithCanonicalMapping
        guard Self.validName(normalized) else { throw ProjectError.invalidName }
        guard let parent = grants[parentToken] else { throw ProjectError.directoryRequired }
        guard UUID(uuidString: commandID) != nil else { throw ProjectError.invalid }
        return try files.locked {
            var entries = try readIndex()
            let projectID = "proj_" + commandID.lowercased()
            let target = parent.appendingPathComponent(normalized, isDirectory: true)
            if let entry = entries.first(where: { $0.id == projectID }) {
                guard entry.document.name == normalized, entry.path == target.path else { throw ProjectError.conflict }
                return try summary(entry.document, path: entry.path)
            }
            guard entries.count < 256 else { throw ProjectError.limit }
            let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parentFD >= 0 else { throw ProjectError.unavailable }
            defer { close(parentFD) }
            var metadata = stat()
            if fstatat(parentFD, normalized, &metadata, AT_SYMLINK_NOFOLLOW) == 0 { throw ProjectError.exists }
            guard errno == ENOENT else { throw ProjectError.unavailable }
            guard !entries.contains(where: { $0.path.precomposedStringWithCanonicalMapping.lowercased() == target.path.precomposedStringWithCanonicalMapping.lowercased() }) else { throw ProjectError.exists }
            let now = ISO8601DateFormatter().string(from: Date())
            let document = ProjectDocument(format: "vibe-improve.project", schemaVersion: 1, id: projectID, name: normalized, revision: 1, createdAt: now, updatedAt: now, lastOpenedAt: now, state: "draft")
            let entry = ProjectEntry(id: projectID, kind: "draft", bookmark: try parent.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil), path: target.path, document: document)
            entries.append(entry); try saveIndex(entries)
            try files.remove("draft.json")
            return try summary(document, path: target.path)
        }
    }
    func openProject(id: String) throws -> [String: Any] {
        try files.locked {
            var entries = try readIndex()
            guard let index = entries.firstIndex(where: { $0.id == id }) else { throw ProjectError.unavailable }
            let entry = entries[index], url = try resolve(entry)
            var document = entry.kind == "draft" ? entry.document : try readDocument(at: url)
            guard document.id == id else { throw ProjectError.invalid }
            document.lastOpenedAt = ISO8601DateFormatter().string(from: Date())
            if entry.kind == "project" { try RuntimeDirectory(url: url.appendingPathComponent(".vibe-improve"), create: false).write("project.json", data: encoder.encode(document)) }
            let path = entry.kind == "draft" ? url.appendingPathComponent(document.name).path : url.path
            entries[index] = ProjectEntry(id: id, kind: entry.kind, bookmark: entry.bookmark, path: path, document: document)
            try saveIndex(entries)
            var result = try summary(document, path: path, kind: entry.kind)
            if entry.kind == "draft" { result["directory"] = try grant(url) }
            return result
        }
    }
    func register(_ url: URL, replacing id: String? = nil) throws -> [String: Any] {
        try files.locked {
            var entries = try readIndex()
            let document = try readDocument(at: url)
            if let id, document.id != id { throw ProjectError.invalid }
            let entry = ProjectEntry(id: document.id, kind: "project", bookmark: try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil), path: url.path, document: document)
            if let index = entries.firstIndex(where: { $0.id == document.id }) { entries[index] = entry }
            else { guard entries.count < 256 else { throw ProjectError.limit }; entries.append(entry) }
            try saveIndex(entries)
            return try summary(document, path: url.path, kind: "project")
        }
    }
    func rename(id: String, name: String, expectedRevision: Int, parentToken: String?) throws -> [String: Any] {
        let name = name.precomposedStringWithCanonicalMapping
        guard Self.validName(name) else { throw ProjectError.invalidName }
        return try files.locked {
            var entries = try readIndex()
            guard let index = entries.firstIndex(where: { $0.id == id }) else { throw ProjectError.unavailable }
            let entry = entries[index]
            let url = entry.kind == "draft" && parentToken != nil ? grants[parentToken!] : try resolve(entry)
            guard let url else { throw ProjectError.directoryRequired }
            var document = entry.kind == "draft" ? entry.document : try readDocument(at: url)
            guard document.id == id, document.revision == expectedRevision else { throw ProjectError.conflict }
            let path = entry.kind == "draft" ? url.appendingPathComponent(name).path : url.path
            if entry.kind == "draft" {
                let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw ProjectError.unavailable }; close(fd)
                var metadata = stat()
                guard lstat(path, &metadata) != 0, errno == ENOENT else { throw ProjectError.exists }
                guard !entries.contains(where: { $0.id != id && $0.path.lowercased() == path.lowercased() }) else { throw ProjectError.exists }
            }
            document.name = name; document.revision += 1; document.updatedAt = ISO8601DateFormatter().string(from: Date())
            if entry.kind == "project" { try RuntimeDirectory(url: url.appendingPathComponent(".vibe-improve"), create: false).write("project.json", data: encoder.encode(document)) }
            entries[index] = ProjectEntry(id: id, kind: entry.kind, bookmark: try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil), path: path, document: document)
            try saveIndex(entries)
            return try summary(document, path: path, kind: entry.kind)
        }
    }
    func remove(id: String, expectedRevision: Int) throws {
        guard id.range(of: "^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil,
              expectedRevision > 0, expectedRevision < 1_000_000 else { throw ProjectError.invalid }
        try files.locked {
            var entries = try readIndex()
            guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
            let entry = entries[index]
            var revision = entry.document.revision
            if entry.kind == "project", let url = try? resolve(entry), let current = try? readDocument(at: url) {
                guard current.id == id else { throw ProjectError.invalid }
                revision = current.revision
            }
            guard revision == expectedRevision else { throw ProjectError.conflict }
            entries.remove(at: index)
            try saveIndex(entries)
        }
    }
    func saveDraft(name: String, parentToken: String?) throws {
        guard name.count <= 80 else { throw ProjectError.invalidName }
        var record: [String: Any] = ["name": name]
        if let token = parentToken, let url = grants[token] { record["parent"] = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString() }
        try files.locked { try files.write("draft.json", data: JSONSerialization.data(withJSONObject: record)) }
    }
    func loadDraft() throws -> [String: Any] {
        try files.locked {
            guard let data = try files.read("draft.json", maximumBytes: 65_536), let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let name = record["name"] as? String, name.count <= 80 else { return ["name": ""] }
            var response: [String: Any] = ["name": name]
            if let encoded = record["parent"] as? String, let bookmark = Data(base64Encoded: encoded) {
                var stale = false
                if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale), let choice = try? grant(url) { response["directory"] = choice }
            }
            return response
        }
    }
}
