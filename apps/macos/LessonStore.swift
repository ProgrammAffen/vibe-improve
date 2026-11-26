import Foundation
import JavaScriptCore
import CryptoKit

enum LessonError: String, Error {
    case invalid = "LESSON_INVALID", tooLarge = "LESSON_TOO_LARGE", conflict = "LESSON_CONFLICT"
    case target = "LESSON_TARGET_UNAVAILABLE", storage = "LESSON_STORAGE_UNAVAILABLE"
    case resource = "LESSON_RESOURCE_UNAVAILABLE", preview = "LESSON_PREVIEW_UNAVAILABLE"
}

struct LessonIdentity {
    let projectId: String
    let routeId: String
    let nodeId: String
    init(_ value: [String: Any]) throws {
        guard let project = value["projectId"] as? String,
              project.range(of: "^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil,
              let route = value["routeId"] as? String, let node = value["nodeId"] as? String,
              [route, node].allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil })
        else { throw LessonError.invalid }
        projectId = project; routeId = route; nodeId = node
    }
    var json: [String: Any] { ["projectId": projectId, "routeId": routeId, "nodeId": nodeId] }
    var key: String { SHA256.hash(data: Data((routeId + "\0" + nodeId).utf8)).map { String(format: "%02x", $0) }.joined() }
}

/// Runtime-owned notebook files. Resources remain references to the existing resource library.
final class LessonStore {
    static let maximumBytes = 2_097_152
    private let files: RuntimeDirectory
    private let validatorURL: URL
    private let context: (LessonIdentity) throws -> [String: Any]
    private let resource: (LessonIdentity, ResourceSelection) throws -> LearningResource
    private let lock = NSRecursiveLock()
    private var opened = Set<String>()
    init(runtime: RuntimeDirectory, validatorURL: URL? = nil,
         context: @escaping (LessonIdentity) throws -> [String: Any],
         resource: @escaping (LessonIdentity, ResourceSelection) throws -> LearningResource) throws {
        files = try runtime.child("projects").child("lessons")
        self.validatorURL = validatorURL ?? Bundle.main.resourceURL!.appendingPathComponent("LessonValidation/lesson.js")
        self.context = context; self.resource = resource
    }
    private func call(_ name: String, _ arguments: [Any]) throws -> [String: Any] {
        guard let code = try? String(contentsOf: validatorURL, encoding: .utf8), let js = JSContext() else { throw LessonError.storage }
        js.evaluateScript(code)
        guard js.exception == nil, let function = js.objectForKeyedSubscript("VibeLesson")?.objectForKeyedSubscript(name), !function.isUndefined else { throw LessonError.storage }
        let result = function.call(withArguments: arguments)
        if let error = js.exception { throw LessonError(rawValue: error.objectForKeyedSubscript("message")?.toString() ?? "") ?? .invalid }
        guard let value = result?.toDictionary() as? [String: Any] else { throw LessonError.invalid }
        return value
    }
    func trustedContext(_ identity: LessonIdentity) throws -> [String: Any] { try context(identity) }
    func validateResource(_ identity: LessonIdentity, _ ref: ResourceSelection) throws -> LearningResource {
        let item = try resource(identity, ref)
        guard !item.removed, item.draftID == nil else { throw LessonError.resource }
        return item
    }
    private func synchronized<T>(_ identity: LessonIdentity, _ operation: (RuntimeDirectory) throws -> T) throws -> T {
        _ = try trustedContext(identity)
        lock.lock(); defer { lock.unlock() }
        let directory = try files.child(identity.projectId)
        return try directory.locked(identity.key + ".lock") { try operation(directory) }
    }
    private func resetRevision(_ identity: LessonIdentity) throws -> Int {
        let revision = try trustedContext(identity)["notebookResetRevision"] as? Int ?? 0
        guard revision >= 0, revision < 1_000_000_000 else { throw LessonError.storage }
        return revision
    }
    private func raw(_ identity: LessonIdentity, _ directory: RuntimeDirectory) throws -> (workspace: [String: Any], resetRevision: Int) {
        guard let data = try directory.read(identity.key + ".json", maximumBytes: Self.maximumBytes + 1024) else {
            return (try call("emptyLessonWorkspace", [identity.json]), 0)
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LessonError.storage }
        if value["storageVersion"] != nil {
            guard Set(value.keys) == ["storageVersion", "notebookResetRevision", "workspace"], value["storageVersion"] as? Int == 1,
                  let revision = value["notebookResetRevision"] as? Int, revision >= 0, revision < 1_000_000_000,
                  let workspace = value["workspace"] as? [String: Any] else { throw LessonError.storage }
            return (try call("validateLessonWorkspace", [workspace, identity.json]), revision)
        }
        // Initial notebook files were plain workspaces; they predate route-level clearing.
        return (try call("validateLessonWorkspace", [value, identity.json]), 0)
    }
    private func write(_ identity: LessonIdentity, _ directory: RuntimeDirectory, _ workspace: [String: Any], resetRevision: Int) throws {
        let document = try JSONSerialization.data(withJSONObject: workspace, options: .sortedKeys)
        guard document.count <= Self.maximumBytes else { throw LessonError.tooLarge }
        let envelope: [String: Any] = ["storageVersion": 1, "notebookResetRevision": resetRevision, "workspace": workspace]
        let data = try JSONSerialization.data(withJSONObject: envelope, options: .sortedKeys)
        try directory.write(identity.key + ".json", data: data)
    }
    private func initialized(_ identity: LessonIdentity, _ directory: RuntimeDirectory) throws -> [String: Any] {
        let key = identity.projectId + "/" + identity.key
        let stored = try raw(identity, directory)
        let epoch = try resetRevision(identity)
        guard stored.resetRevision <= epoch else { throw LessonError.storage }
        var workspace = stored.workspace
        var changed = false
        if stored.resetRevision < epoch {
            workspace = try call("resetLessonWorkspace", [workspace, identity.json])
            changed = true
        }
        if !opened.contains(key) {
            let recovered = try call("recoverLessonWorkspace", [workspace, identity.json])
            changed = changed || recovered["revision"] as? Int != workspace["revision"] as? Int
            workspace = recovered
        }
        if changed { try write(identity, directory, workspace, resetRevision: epoch) }
        opened.insert(key)
        return workspace
    }
    func read(_ identity: LessonIdentity) throws -> [String: Any] {
        try synchronized(identity) { try initialized(identity, $0) }
    }
    func save(_ identity: LessonIdentity, expectedRevision: Int, workspace: [String: Any]) throws -> [String: Any] {
        try synchronized(identity) { directory in
            let epoch = try resetRevision(identity)
            let current = try initialized(identity, directory)
            guard try resetRevision(identity) == epoch else { throw LessonError.conflict }
            let next = try call("nextLessonWorkspace", [current, identity.json, expectedRevision, workspace])
            let retained = Set((current["blocks"] as? [[String: Any]] ?? []).compactMap { block -> ResourceSelection? in
                guard let fields = block["resource"] as? [String: String], let id = fields["id"], let version = fields["version"] else { return nil }
                return ResourceSelection(id: id, version: version)
            })
            for block in next["blocks"] as? [[String: Any]] ?? [] {
                if let fields = block["resource"] as? [String: String], let id = fields["id"], let version = fields["version"] {
                    let ref = ResourceSelection(id: id, version: version)
                    // A missing source must not erase or freeze its existing notes. New references still require permission.
                    if !retained.contains(ref) { _ = try validateResource(identity, ref) }
                }
            }
            _ = try trustedContext(identity)
            guard try resetRevision(identity) == epoch else {
                _ = try initialized(identity, directory)
                throw LessonError.conflict
            }
            // Stamp the epoch actually used to validate this edit. A concurrent reset in another
            // app process can never make old content appear to have already applied the new reset.
            try write(identity, directory, next, resetRevision: epoch)
            if try resetRevision(identity) != epoch {
                _ = try initialized(identity, directory)
                throw LessonError.conflict
            }
            return next
        }
    }
    func agentContext(_ fields: [String: String], expectedRevision: Int) throws -> [String: Any] {
        let identity = try LessonIdentity(fields)
        let workspace = try read(identity)
        guard workspace["revision"] as? Int == expectedRevision else { throw LessonError.conflict }
        var result = try trustedContext(identity)
        result["workspace"] = workspace
        return result
    }
    func previewResource(_ identity: LessonIdentity, _ ref: ResourceSelection) throws -> LearningResource {
        let workspace = try read(identity)
        let item = try validateResource(identity, ref)
        let inWorkspace = (workspace["blocks"] as? [[String: Any]] ?? []).contains { block in
            let saved = block["resource"] as? [String: String]
            return saved?["id"] == ref.id && saved?["version"] == ref.version
        }
        let directlyAttached = item.lessons.contains(ResourceScope(routeId: identity.routeId, nodeId: identity.nodeId))
        if !inWorkspace && !directlyAttached {
            let linkedResources = try trustedContext(identity)["linkedResources"] as? [ResourceSelection] ?? []
            guard linkedResources.contains(ref) else { throw LessonError.resource }
        }
        return item
    }
}
