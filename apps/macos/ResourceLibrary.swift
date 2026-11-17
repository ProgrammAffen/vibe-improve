import Foundation
import CryptoKit
import Darwin

enum ResourceError: String, Error {
    case invalid = "RESOURCE_INVALID"
    case storage = "RESOURCE_STORAGE"
    case unavailable = "RESOURCE_UNAVAILABLE"
    case limit = "RESOURCE_LIMIT"
    case changed = "RESOURCE_SELECTION_CHANGED"
    case searchUnavailable = "RESOURCE_SEARCH_UNAVAILABLE"
    case searchNeedsTopic = "RESOURCE_SEARCH_NEEDS_TOPIC"
}

struct ResourceLocation: Codable, Hashable {
    let kind: String
    let start: Int
    var end: Int? = nil
}

struct ResourceSegment: Codable {
    let id: String
    let location: ResourceLocation
    let text: String
}

struct ResourceSelection: Codable, Hashable {
    let id: String
    let version: String
}

struct ResourceScope: Codable, Hashable {
    let routeId: String
    let nodeId: String
}

enum ResourceStatus: String, Codable { case pending, processing, ready, partial, needsAttention, attachment }

struct ResourceExtraction {
    var status: ResourceStatus
    var reason: String? = nil
    var segments: [ResourceSegment] = []
    var read: Int? = nil
    var total: Int? = nil
    var hasTranscript: Bool? = nil
}

struct LearningResource: Codable {
    let id: String
    var version: String
    let format: String
    let name: String
    var origin: String
    var stamp: String?
    var planning: Bool
    var lessons: [ResourceScope] = []
    var removed = false
    var status: ResourceStatus = .pending
    var reason: String?
    var segments: [ResourceSegment] = []
    var read: Int?
    var total: Int?
    var jobId: String?
    var speechLocale: String?
    var hasTranscript: Bool?
    var captions: Data?
    var fromTutorialSearch: Bool?
    var removedLinkDigest: Data?
    var draftID: String?

    var isLink: Bool { format == "web" }
    var isMedia: Bool { format == "audio" || format == "video" }
    var hasReadableContent: Bool { !segments.isEmpty && (status == .ready || status == .partial) && !removed }
    var parseFailed: Bool { status == .attachment || (status == .needsAttention && reason != "speechPaused") }
    var ref: ResourceSelection { ResourceSelection(id: id, version: version) }

    mutating func beginParsing() {
        jobId = UUID().uuidString.lowercased()
        status = .processing
        reason = speechLocale == nil ? nil : "transcribing"
    }

    func display(details: Bool = false) -> [String: Any] {
        var result: [String: Any] = [
            "id": id, "version": version, "format": format, "name": name, "planning": planning,
            "status": status.rawValue, "removed": removed, "lessonCount": lessons.count, "segmentCount": segments.count
        ]
        if let reason { result["reason"] = reason }
        if fromTutorialSearch == true { result["fromTutorialSearch"] = true }
        if let read { result["read"] = read }
        if let total { result["total"] = total }
        if let speechLocale { result["speechLocale"] = speechLocale }
        if let hasTranscript { result["hasTranscript"] = hasTranscript }
        if let first = segments.first {
            result["firstSegment"] = Self.json(first.location)
        }
        if !segments.isEmpty {
            result["positions"] = segments.map { ["id": $0.id, "location": Self.json($0.location)] }
        }
        if details {
            result["segments"] = segments.map(Self.json)
            result["overview"] = ResourceExtractors.overview(segments)
        }
        return result
    }

    static func json<T: Encodable>(_ value: T) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]) ?? [:]
    }
}

final class ResourceLibrary {
    private struct Draft: Codable {
        let id: String
        var refs: Set<ResourceSelection>
        var deleted: Set<ResourceSelection> = []
    }

    private struct Document: Codable {
        var version = 1
        var items: [LearningResource] = []
        var draft: Draft?

        var savedRefs: Set<ResourceSelection> {
            Set(items.filter { $0.planning && !$0.removed }.map(\.ref))
        }

        func requireDraft(_ id: String) throws -> Draft {
            guard let draft, draft.id == id else { throw ResourceError.changed }
            return draft
        }

        func draftItems(_ draft: Draft) -> [LearningResource] {
            items.filter { draft.refs.contains($0.ref) && !$0.removed }
        }

        func draftView(_ draft: Draft) -> [String: Any] {
            ["id": draft.id, "items": draftItems(draft).map { $0.display() }, "dirty": draft.refs != savedRefs]
        }
    }
    private struct ImportReport {
        var added = 0
        var duplicates = 0
        var overLimit = 0
        var invalidLines: [Int] = []
        var skipped = 0
        var scanLimited = false
        var json: [String: Any] {
            ["added": added, "duplicates": duplicates, "overLimit": overLimit, "invalidLines": invalidLines,
             "skipped": skipped, "scanLimited": scanLimited]
        }
    }

    static let planningFiles = 20, planningLinks = 20, lessonFiles = 40, lessonLinks = 20
    private static let projectLimit = 768
    private let root: RuntimeDirectory
    private let validateProject: (String) throws -> Void
    private let extract: (LearningResource) -> ResourceExtraction
    private let whisper: ResourceWhisper
    private let log: (String, String, String, String, Int) -> Void
    private let lock = NSLock()
    private let processing = OperationQueue()
    private let transcription = OperationQueue()
    private var running: Set<String> = []
    private let maximumBytes = 24 * 1024 * 1024

    init(runtime: RuntimeDirectory, project: @escaping (String) throws -> Void,
         extract: @escaping (LearningResource) -> ResourceExtraction = ResourceExtractors.extract,
         whisper: ResourceWhisper = ResourceWhisper(),
         log: @escaping (String, String, String, String, Int) -> Void = { _, _, _, _, _ in }) throws {
        root = try runtime.child("projects").child("resources")
        validateProject = project
        self.extract = extract
        self.whisper = whisper
        self.log = log
        processing.maxConcurrentOperationCount = 3
        processing.qualityOfService = .utility
        transcription.maxConcurrentOperationCount = 1
        transcription.qualityOfService = .utility
    }

    private func transaction<T>(_ project: String, update: Bool = false, _ body: (inout Document) throws -> T) throws -> T {
        guard project.range(of: "^proj_[a-f0-9-]{36}$", options: .regularExpression) != nil else { throw ResourceError.invalid }
        try validateProject(project)
        lock.lock()
        defer { lock.unlock() }
        let dir = try root.child(project)
        let deadline = Date().addingTimeInterval(0.25)
        while true {
            do {
                return try dir.locked {
                    var document = try dir.read("library.json", maximumBytes: maximumBytes)
                        .map { try JSONDecoder().decode(Document.self, from: $0) } ?? Document()
                    guard document.version == 1, document.items.count <= Self.projectLimit else { throw ResourceError.storage }
                    let result = try body(&document)
                    if update {
                        let bytes = try JSONEncoder().encode(document)
                        guard bytes.count <= maximumBytes else { throw ResourceError.limit }
                        try dir.write("library.json", data: bytes)
                    }
                    return result
                }
            } catch RuntimeFileError.busy where Date() < deadline {
                Thread.sleep(forTimeInterval: 0.015)
            }
        }
    }

    func list(_ project: String, scope: ResourceScope?, all: Bool = false) throws -> [[String: Any]] {
        let (items, jobs) = try transaction(project) { document in
            (document.items.filter { item in
                if all { return !item.removed && item.draftID == nil }
                if let scope { return item.lessons.contains(scope) && !item.removed }
                return item.planning && !item.removed
            }, document.items.filter { !$0.removed && $0.jobId != nil })
        }
        schedule(project, jobs)
        return items.map { $0.display() }
    }

    func beginDraft(_ project: String) throws -> [String: Any] {
        let (view, jobs) = try transaction(project, update: true) { document in
            let draft = document.draft ?? Draft(id: Self.token(), refs: document.savedRefs)
            document.draft = draft
            startPending(in: &document, refs: draft.refs)
            return (document.draftView(draft), document.draftItems(draft).filter { $0.jobId != nil })
        }
        schedule(project, jobs)
        return view
    }

    func readDraft(_ project: String, id: String) throws -> [String: Any] {
        let (view, jobs) = try transaction(project) { document in
            let draft = try document.requireDraft(id)
            return (document.draftView(draft), document.draftItems(draft).filter { $0.jobId != nil })
        }
        schedule(project, jobs)
        return view
    }

    func removeFromDraft(_ project: String, id: String, refs: Set<ResourceSelection>?) throws {
        try transaction(project, update: true) { document in
            var draft = try document.requireDraft(id)
            let removed = refs ?? Set(document.draftItems(draft).filter(\.parseFailed).map(\.ref))
            draft.deleted.formUnion(draft.refs.intersection(removed))
            draft.refs.subtract(removed)
            document.draft = draft
        }
    }

    func finishDraft(_ project: String, id: String, saveRefs: Set<ResourceSelection>?) throws -> [ResourceSelection] {
        let (invalidated, discarded) = try transaction(project, update: true) { document in
            let draft = try document.requireDraft(id)
            var invalidated: [ResourceSelection] = [], discarded: [LearningResource] = []
            if let saveRefs {
                guard saveRefs == draft.refs, saveRefs.count == document.draftItems(draft).count else { throw ResourceError.changed }
                for index in document.items.indices {
                    let original = document.items[index]
                    if saveRefs.contains(original.ref), !original.removed {
                        document.items[index].planning = true
                        document.items[index].draftID = nil
                    } else if original.planning && !original.removed {
                        invalidated.append(original.ref)
                        document.items[index].planning = false
                        if draft.deleted.contains(original.ref) {
                            discarded.append(original)
                            removeRecord(&document.items[index])
                        }
                    }
                }
            }
            discarded.append(contentsOf: document.items.filter { $0.draftID == id })
            document.items.removeAll { $0.draftID == id }
            document.draft = nil
            return (invalidated, discarded)
        }
        cleanup(project, discarded)
        return invalidated
    }

    func item(_ project: String, ref: ResourceSelection) throws -> LearningResource {
        try transaction(project) { document in
            guard let item = document.items.first(where: { $0.ref == ref }) else { throw ResourceError.unavailable }
            return item
        }
    }

    func describe(_ project: String, refs: [ResourceSelection]) throws -> [[String: Any]] {
        let wanted = Set(refs)
        return try transaction(project) { $0.items.filter { wanted.contains($0.ref) }.map { $0.display() } }
    }

    private func belongs(_ item: LearningResource, to scope: ResourceScope?) -> Bool {
        if let scope { return item.lessons.contains(scope) }
        return item.planning
    }

    private func admit(_ input: [LearningResource], into document: inout Document, scope: ResourceScope?, draftID: String? = nil,
                       report: inout ImportReport) throws -> [LearningResource] {
        var draft = try draftID.map { try document.requireDraft($0) }
        var present = draft.map { document.draftItems($0) } ?? document.items.filter { !$0.removed && belongs($0, to: scope) }
        var files = present.filter { !$0.isLink }.count
        var links = present.count - files
        var jobs: [LearningResource] = []
        for item in input {
            let byteMatch: (LearningResource) -> Bool = {
                !$0.removed && ($0.draftID == nil || $0.draftID == draftID) && $0.origin == item.origin && $0.stamp == item.stamp
            }
            if present.contains(where: byteMatch) { report.duplicates += 1; continue }
            let existing = document.items.firstIndex {
                byteMatch($0) && (item.fromTutorialSearch != true || $0.fromTutorialSearch == true && $0.status == .ready)
            }
            let replacing = item.isLink ? nil : present.firstIndex(where: { $0.origin == item.origin })
            let hasSpace = replacing != nil || (item.isLink ? links < (scope == nil ? Self.planningLinks : Self.lessonLinks)
                : files < (scope == nil ? Self.planningFiles : Self.lessonFiles))
            guard hasSpace, existing != nil || document.items.count < Self.projectLimit else { report.overLimit += 1; continue }
            if let replacing,
               let old = document.items.firstIndex(where: { $0.ref == present[replacing].ref }) {
                if draft != nil { draft?.refs.remove(present[replacing].ref) }
                else if let scope { document.items[old].lessons.removeAll { $0 == scope } }
                else { document.items[old].planning = false }
                present.remove(at: replacing)
                files -= 1
            }
            var admitted = existing.map { document.items[$0] } ?? item
            if draft != nil {
                if existing == nil {
                    admitted.planning = false
                    admitted.draftID = draftID
                }
                draft?.refs.insert(admitted.ref)
                draft?.deleted.remove(admitted.ref)
            } else if let scope {
                if !admitted.lessons.contains(scope) { admitted.lessons.append(scope) }
            } else {
                admitted.planning = true
            }
            if (draft != nil || scope != nil) && admitted.status == .pending {
                admitted.beginParsing()
                jobs.append(admitted)
            }
            if let existing { document.items[existing] = admitted }
            else { document.items.append(admitted) }
            present.append(admitted)
            if item.isLink { links += 1 } else { files += 1 }
            report.added += 1
        }
        if let draft { document.draft = draft }
        return jobs
    }

    private func local(_ url: URL, scope: ResourceScope?) -> LearningResource? {
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        guard let stamp = ResourceExtractors.stamp(resolved), !url.hasDirectoryPath,
              (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { return nil }
        let format = ResourceExtractors.format(resolved.pathExtension)
        return LearningResource(id: Self.token(), version: Self.token(), format: format,
                                name: String(resolved.lastPathComponent.prefix(230)), origin: resolved.path, stamp: stamp,
                                planning: scope == nil, lessons: scope.map { [$0] } ?? [])
    }

    func addFiles(_ project: String, urls: [URL], folder: Bool, scope: ResourceScope?, draftID: String? = nil) throws -> [String: Any] {
        var report = ImportReport(), candidates: [LearningResource] = []
        if folder, let selected = urls.first {
            let resolved = selected.standardizedFileURL.resolvingSymlinksInPath()
            let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isRegularFileKey]
            guard let children = FileManager.default.enumerator(at: resolved, includingPropertiesForKeys: keys,
                    options: [.skipsHiddenFiles, .skipsPackageDescendants], errorHandler: { _, _ in report.skipped += 1; return true })
            else { throw ResourceError.unavailable }
            for (position, entry) in children.enumerated() {
                guard position < 4000 else { report.scanLimited = true; break }
                guard let url = entry as? URL, let values = try? url.resourceValues(forKeys: Set(keys)) else { report.skipped += 1; continue }
                if values.isSymbolicLink == true { report.skipped += 1; continue }
                guard values.isRegularFile == true else { continue }
                guard url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(resolved.path == "/" ? "/" : resolved.path + "/"),
                      let item = local(url, scope: scope) else { report.skipped += 1; continue }
                candidates.append(item)
            }
            candidates.sort { $0.origin.localizedStandardCompare($1.origin) == .orderedAscending }
        } else {
            for url in urls.prefix(4000) {
                if let item = local(url, scope: scope) { candidates.append(item) } else { report.skipped += 1 }
            }
            report.scanLimited = urls.count > 4000
        }
        let reply = try transaction(project, update: true) {
            try admit(candidates, into: &$0, scope: scope, draftID: draftID, report: &report)
        }
        schedule(project, reply)
        return report.json
    }

    func addLinks(_ project: String, text: String, scope: ResourceScope?, draftID: String? = nil) throws -> [String: Any] {
        guard text.utf8.count <= 48_000 else { throw ResourceError.limit }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        guard lines.count <= 200 else { throw ResourceError.limit }
        var report = ImportReport(), items: [LearningResource] = []
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let url = PublicResourceWeb.address(trimmed), let host = url.host else {
                report.invalidLines.append(index + 1)
                continue
            }
            items.append(Self.webResource(url, host: host, scope: scope))
        }
        let reply = try transaction(project, update: true) {
            try admit(items, into: &$0, scope: scope, draftID: draftID, report: &report)
        }
        schedule(project, reply)
        return report.json
    }

    @discardableResult func parsePending(_ project: String) throws -> Int {
        let jobs = try transaction(project, update: true) { document in
            let refs = document.savedRefs
            return startPending(in: &document, refs: refs)
        }
        schedule(project, jobs)
        return jobs.count
    }

    @discardableResult private func startPending(in document: inout Document, refs: Set<ResourceSelection>) -> [LearningResource] {
        var pending: [LearningResource] = []
        for index in document.items.indices where refs.contains(document.items[index].ref) &&
            !document.items[index].removed && document.items[index].status == .pending {
            document.items[index].beginParsing()
            pending.append(document.items[index])
        }
        return pending
    }

    private static func webResource(_ url: URL, host: String, scope: ResourceScope?) -> LearningResource {
        let suffix = url.lastPathComponent.trimmingCharacters(in: .whitespaces)
        let name = suffix.isEmpty || suffix == "/" ? host : host + " / " + suffix
        return LearningResource(id: token(), version: token(), format: "web",
                                name: String(name.prefix(230)), origin: url.absoluteString,
                                planning: scope == nil, lessons: scope.map { [$0] } ?? [])
    }

    func prepareTutorialSearch(_ project: String, draftID: String, restart: Bool) throws -> (slots: Int, excluded: [String]) {
        try transaction(project, update: restart) { document in
            var draft = try document.requireDraft(draftID)
            if restart {
                draft.refs.subtract(document.draftItems(draft).filter { $0.fromTutorialSearch == true }.map(\.ref))
                document.draft = draft
            }
            let items = document.draftItems(draft)
            let slots = Self.planningLinks - items.filter(\.isLink).count
            let excluded = items.filter { $0.fromTutorialSearch == true }.map(\.origin)
            return (slots, excluded)
        }
    }

    func addTutorialResults(_ project: String, draftID: String, candidates: [String],
                            readPage: (URL, TimeInterval) -> ResourceExtraction = PublicResourceWeb.fetch,
                            validate: () throws -> Void = {}) throws -> Int {
        try validate()
        let (remaining, known, cached) = try transaction(project) { document in
            let draft = try document.requireDraft(draftID)
            let slots = Self.planningLinks - document.draftItems(draft).filter(\.isLink).count
            let verified = document.items.filter {
                !$0.removed && $0.fromTutorialSearch == true && $0.status == .ready && !$0.segments.isEmpty
            }
            return (slots, knownLinkDigests(document, draft: draft), Dictionary(verified.map { ($0.origin, $0) }, uniquingKeysWith: { first, _ in first }))
        }
        guard remaining > 0 else { return 0 }
        let deadline = Date().addingTimeInterval(25)
        var seen = known
        var readable: [LearningResource] = []
        for raw in candidates.prefix(Self.planningLinks * 2) {
            let seconds = min(7, deadline.timeIntervalSinceNow)
            guard readable.count < remaining, seconds >= 1 else { break }
            guard let url = PublicResourceWeb.address(raw), let host = url.host,
                  seen.insert(Self.linkDigest(url.absoluteString)).inserted else { continue }
            if let item = cached[url.absoluteString] {
                readable.append(item)
                continue
            }
            let result = readPage(url, seconds)
            guard result.status == .ready, !result.segments.isEmpty else { continue }
            var item = Self.webResource(url, host: host, scope: nil)
            item.status = .ready
            item.segments = result.segments
            item.read = result.read
            item.total = result.total
            item.fromTutorialSearch = true
            readable.append(item)
        }
        try validate()
        guard !readable.isEmpty else { return 0 }
        return try transaction(project, update: true) { document in
            let draft = try document.requireDraft(draftID)
            let existing = knownLinkDigests(document, draft: draft)
            var report = ImportReport()
            _ = try admit(readable.filter { !existing.contains(Self.linkDigest($0.origin)) }, into: &document, scope: nil,
                          draftID: draftID, report: &report)
            return report.added
        }
    }

    private static func linkDigest(_ origin: String) -> Data { Data(SHA256.hash(data: Data(origin.utf8))) }

    private func knownLinkDigests(_ document: Document, draft: Draft) -> Set<Data> {
        Set(document.items.filter(\.isLink).compactMap { item in
            if item.removed { return item.removedLinkDigest }
            guard draft.refs.contains(item.ref) || draft.deleted.contains(item.ref) else { return nil }
            return Self.linkDigest(item.origin)
        })
    }

    func remove(_ project: String, ref: ResourceSelection) throws -> [ResourceSelection] {
        try remove(project, refs: [ref])
    }

    func remove(_ project: String, refs: Set<ResourceSelection>) throws -> [ResourceSelection] {
        try removeResources(project) { refs.contains($0.ref) }
    }

    func removeFailed(_ project: String) throws -> [ResourceSelection] {
        try removeResources(project) { $0.parseFailed }
    }

    private func removeResources(_ project: String, matching: (LearningResource) -> Bool) throws -> [ResourceSelection] {
        let removed = try transaction(project, update: true) { document in
            var removed: [LearningResource] = []
            for index in document.items.indices {
                let original = document.items[index]
                guard original.planning, !original.removed, matching(original) else { continue }
                removed.append(original)
                removeRecord(&document.items[index])
            }
            return removed
        }
        cleanup(project, removed)
        return removed.map(\.ref)
    }

    private func removeRecord(_ item: inout LearningResource) {
        item.removed = true
        item.planning = false
        item.lessons = []
        if item.isLink { item.removedLinkDigest = Self.linkDigest(item.origin) }
        item.origin = ""
        item.stamp = nil
        item.segments = []
        item.captions = nil
        item.jobId = nil
        item.speechLocale = nil
        item.hasTranscript = nil
    }

    private func cleanup(_ project: String, _ items: [LearningResource]) {
        for item in items {
            cancel(item.jobId)
            if item.speechLocale != nil { deleteTranscript(project, ref: item.ref) }
        }
    }

    func change(_ project: String, ref: ResourceSelection, action: String, scope: ResourceScope? = nil,
                speechLocale: String? = nil, captions: Data? = nil) throws {
        let (pending, cancelled, discard): (LearningResource?, String?, Bool) = try transaction(project, update: true) { document in
            guard let index = document.items.firstIndex(where: { $0.ref == ref && !$0.removed }) else { throw ResourceError.unavailable }
            var item = document.items[index]
            var cancelled: String?, discard = false
            switch action {
            case "detach":
                guard let scope, item.lessons.contains(scope) else { throw ResourceError.invalid }
                item.lessons.removeAll { $0 == scope }
            case "pauseTranscription":
                guard let job = item.jobId, item.speechLocale != nil else { throw ResourceError.invalid }
                cancelled = job
                item.jobId = nil
                item.status = item.segments.isEmpty ? .needsAttention : .partial
                item.reason = "speechPaused"
            case "retry":
                guard item.parseFailed, item.jobId == nil else { return (nil, nil, false) }
                item.beginParsing()
                document.items[index] = item
                return (item, nil, false)
            case "transcribe", "captions":
                guard item.jobId == nil else { throw ResourceError.invalid }
                if action == "transcribe" {
                    guard item.isMedia, item.segments.isEmpty || (item.status == .partial && item.speechLocale != nil),
                          let speechLocale, ResourceWhisper.locales.contains(speechLocale) else { throw ResourceError.invalid }
                    if item.hasTranscript == nil {
                        item.read = nil
                        item.total = nil
                        item.hasTranscript = false
                        item.speechLocale = speechLocale
                    }
                    item.speechLocale = item.speechLocale ?? speechLocale
                    item.captions = nil
                } else {
                    guard item.isMedia, item.segments.isEmpty, let captions else { throw ResourceError.invalid }
                    discard = item.speechLocale != nil
                    item.captions = captions
                    item.speechLocale = nil
                    item.hasTranscript = nil
                    item.read = nil
                    item.total = nil
                }
                item.beginParsing()
                document.items[index] = item
                return (item, nil, discard)
            default: throw ResourceError.invalid
            }
            document.items[index] = item
            return (nil, cancelled, discard)
        }
        cancel(cancelled)
        if discard { deleteTranscript(project, ref: ref) }
        if let pending { schedule(project, [pending]) }
    }

    private func cancel(_ job: String?) {
        guard let job else { return }
        lock.lock()
        running.remove(job)
        lock.unlock()
    }

    private func deleteTranscript(_ project: String, ref: ResourceSelection) {
        if let directory = try? root.child(project).child("transcripts") {
            try? FileManager.default.removeItem(at: directory.url.appendingPathComponent(transcriptName(ref), isDirectory: true))
        }
    }

    func transcript(_ project: String, ref: ResourceSelection) throws -> (name: String, text: String) {
        let item = try item(project, ref: ref)
        guard !item.removed, item.hasTranscript == true else { throw ResourceError.unavailable }
        return (item.name, try ResourceWhisper.transcript(in: transcriptDirectory(project, ref: ref)))
    }

    private func transcriptName(_ ref: ResourceSelection) -> String { ref.id + "-" + ref.version }

    private func transcriptDirectory(_ project: String, ref: ResourceSelection) throws -> RuntimeDirectory {
        try root.child(project).child("transcripts").child(transcriptName(ref))
    }

    private func isRunning(_ job: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return running.contains(job)
    }

    private func transcribe(_ item: LearningResource, project: String, job: String) throws -> ResourceExtraction {
        guard let directory = try? transcriptDirectory(project, ref: item.ref) else { return ResourceExtractors.failure("speechFailed") }
        return try whisper.transcribe(item, in: directory, continueWhile: { self.isRunning(job) }) { read, total, hasTranscript in
            try transaction(project, update: true) { document in
                guard let index = document.items.firstIndex(where: { $0.ref == item.ref && $0.jobId == job && !$0.removed })
                else { throw ResourceError.changed }
                document.items[index].read = read
                document.items[index].total = total
                document.items[index].hasTranscript = hasTranscript
            }
        }
    }

    func generationReferences(_ project: String, selections: [ResourceSelection]) throws -> [[String: Any]] {
        if selections.isEmpty { return [] }
        guard selections.count <= Self.planningFiles + Self.planningLinks, Set(selections).count == selections.count else { throw ResourceError.invalid }
        return try transaction(project) { document in
            try selections.map { ref in
                guard let item = document.items.first(where: { $0.ref == ref }), item.hasReadableContent, item.planning
                else { throw ResourceError.changed }
                return ["id": ref.id, "version": ref.version, "format": item.format,
                        "segments": item.segments.map { ["id": $0.id, "location": LearningResource.json($0.location), "text": $0.text] }]
            }
        }
    }

    private func schedule(_ project: String, _ items: [LearningResource]) {
        for item in items {
            guard let job = item.jobId else { continue }
            lock.lock()
            let inserted = running.insert(job).inserted
            lock.unlock()
            guard inserted else { continue }
            let queue = item.speechLocale != nil ? transcription : processing
            queue.addOperation { [self] in
                defer { cancel(job) }
                do {
                    let next = try root.child(project).locked("read-\(item.id).lock") { () -> LearningResource? in
                        let current = try self.item(project, ref: item.ref)
                        guard current.jobId == job, !current.removed else { return nil }
                        let start = Date()
                        let result = current.speechLocale != nil ? try transcribe(current, project: project, job: job) : extract(current)
                        if (current.planning || current.draftID != nil) && current.isMedia && result.reason == "captionsNeeded" {
                            return try beginAutomaticTranscription(project, ref: current.ref, after: job)
                        }
                        try finish(project, ref: item.ref, job: job, result: result)
                        log(job, result.status.rawValue, item.format, result.reason ?? "OK", Int(Date().timeIntervalSince(start) * 1000))
                        return nil
                    }
                    if let next { schedule(project, [next]) }
                } catch RuntimeFileError.busy {
                    // Another app instance holds the job lock. The next list request can reschedule it.
                    return
                } catch ResourceError.limit {
                    try? finish(project, ref: item.ref, job: job, result: ResourceExtraction(status: .attachment, reason: "storageFull"))
                    log(job, "attachment", item.format, "storageFull", 0)
                } catch {
                    log(job, "failed", item.format, ResourceError.storage.rawValue, 0)
                }
            }
        }
    }

    private func beginAutomaticTranscription(_ project: String, ref: ResourceSelection, after job: String) throws -> LearningResource? {
        try transaction(project, update: true) { document in
            guard let index = document.items.firstIndex(where: { $0.ref == ref && $0.jobId == job && !$0.removed })
            else { return nil }
            document.items[index].speechLocale = "auto"
            document.items[index].hasTranscript = false
            document.items[index].beginParsing()
            return document.items[index]
        }
    }

    private func finish(_ project: String, ref: ResourceSelection, job: String, result: ResourceExtraction) throws {
        try transaction(project, update: true) { document in
            guard let index = document.items.firstIndex(where: { $0.ref == ref && $0.jobId == job && !$0.removed }) else { return }
            var item = document.items[index]
            let previous = item.speechLocale != nil ? item.segments : []
            item.status = !previous.isEmpty && result.status != .ready ? .partial : result.status
            item.reason = result.reason
            if previous.isEmpty {
                item.segments = result.segments
            } else if result.status == .ready {
                // Retain published segment IDs so references from older routes still resolve.
                let firstNewId = (previous.compactMap { Int($0.id.dropFirst()) }.max() ?? 0) + 1
                item.segments = result.segments.enumerated().map { index, segment in
                    ResourceSegment(id: "s\(firstNewId + index)", location: segment.location, text: segment.text)
                } + previous
            }
            item.read = result.read ?? item.read
            item.total = result.total ?? item.total
            item.hasTranscript = result.hasTranscript ?? item.hasTranscript
            item.jobId = nil
            item.captions = nil
            document.items[index] = item
        }
    }

    private static func token() -> String { UUID().uuidString.lowercased() }
}
