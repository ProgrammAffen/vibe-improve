import Cocoa
import CoreFoundation
import UniformTypeIdentifiers

final class ResourceBridge {
    private let library: ResourceLibrary
    private let planning: PlanningStore
    private let agent: PlanningAgentManager?
    private let chatAttachments: PlanningChatAttachmentStore?
    private let invalidate: (String, String) -> Void
    private let previews = ResourcePreviewWindows()
    private let queue = DispatchQueue(label: "vibe-improve.resources", qos: .userInitiated)
    private let searchQueue = DispatchQueue(label: "vibe-improve.resources.search", qos: .utility)
    private var choosing = false

    init(library: ResourceLibrary, planning: PlanningStore, agent: PlanningAgentManager?, chatAttachments: PlanningChatAttachmentStore? = nil,
         invalidate: @escaping (String, String) -> Void) {
        self.library = library
        self.planning = planning
        self.agent = agent
        self.chatAttachments = chatAttachments
        self.invalidate = invalidate
    }

    func request(_ action: String, value: [String: Any], window: NSWindow, english: Bool,
                 reply: @escaping (Any?, String?) -> Void) {
        guard let project = value["projectId"] as? String else { reply(nil, ResourceError.invalid.rawValue); return }
        func respond(on worker: DispatchQueue? = nil, _ operation: @escaping () throws -> Any) {
            (worker ?? queue).async {
                do {
                    let result = try operation()
                    DispatchQueue.main.async { reply(result, nil) }
                } catch {
                    let code = (error as? ResourceError)?.rawValue ?? (error as? PlanningError)?.rawValue
                        ?? (error as? PlanningAgentError)?.rawValue ?? ResourceError.storage.rawValue
                    DispatchQueue.main.async { reply(nil, code) }
                }
            }
        }
        switch action {
        case "resources.searchTutorials":
            guard Set(value.keys) == ["projectId", "expectedRevision", "draftId", "mode"],
                  let draft = try? draftID(value["draftId"]),
                  let mode = value["mode"] as? String, ["start", "continue"].contains(mode),
                  let revision = value["expectedRevision"] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(),
                  revision.doubleValue == Double(revision.intValue), revision.intValue >= 0 else {
                reply(nil, ResourceError.invalid.rawValue); return
            }
            respond(on: searchQueue) { [self] in
                try searchTutorials(project, revision: revision.intValue, draft: draft, restart: mode == "start",
                                    locale: english ? "en" : "zh-CN")
            }
        case "resources.chooseFiles", "resources.chooseFolder", "resources.chooseCaptions", "resources.chooseChatFiles":
            guard !choosing else { reply(nil, ResourceError.invalid.rawValue); return }
            let captions = action == "resources.chooseCaptions", folder = action == "resources.chooseFolder"
            let chat = action == "resources.chooseChatFiles"
            let retained: [String]
            if chat {
                guard Set(value.keys) == ["projectId", "retaining"], let ids = value["retaining"] as? [String],
                      Set(ids).count == ids.count,
                      ids.allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }) else {
                    reply(nil, ResourceError.invalid.rawValue); return
                }
                retained = ids
            } else if Set(value.keys) == (captions ? ["projectId", "ref"] : ["projectId", "scope"])
                        || action == "resources.chooseFiles" && Set(value.keys) == ["projectId", "draftId"] {
                retained = []
            } else {
                reply(nil, ResourceError.invalid.rawValue); return
            }
            choosing = true
            let panel = NSOpenPanel()
            panel.canChooseFiles = !folder
            panel.canChooseDirectories = folder
            panel.canCreateDirectories = false
            panel.allowsMultipleSelection = !folder && !captions
            panel.resolvesAliases = false
            if captions {
                panel.allowedContentTypes = ["srt", "vtt"].compactMap { UTType(filenameExtension: $0) }
                panel.allowsOtherFileTypes = false
            }
            if chat {
                panel.message = english ? "Choose images, PDF, DOCX, or text files."
                    : "选择图片、PDF、DOCX 或文本文件。"
            }
            panel.title = chat ? (english ? "Attach files to chat" : "添加对话附件")
                : folder ? (english ? "Add a resource folder" : "添加资料文件夹")
                : captions ? (english ? "Add captions" : "添加字幕") : (english ? "Add learning files" : "添加学习文件")
            panel.prompt = english ? "Add" : "添加"
            panel.beginSheetModal(for: window) { [self] result in
                choosing = false
                guard result == .OK else { reply(NSNull(), nil); return }
                let urls = panel.urls
                respond { [self] in
                    if chat {
                        guard let chatAttachments, let state = try planning.read(projectID: project),
                              state["provider"] is String else { throw PlanningAgentError.attachment }
                        let messages = state["messages"] as? [[String: Any]] ?? []
                        let sentIDs = messages.flatMap { $0["attachments"] as? [[String: String]] ?? [] }.compactMap { $0["id"] }
                        return try chatAttachments.add(urls, project: project, retaining: Set(sentIDs + retained))
                    }
                    if captions {
                        guard let url = urls.first, ["srt", "vtt"].contains(url.pathExtension.lowercased()) else { throw ResourceError.invalid }
                        let data = try ResourceExtractors.read(url, stamp: nil, maximum: 1024 * 1024)
                        try library.change(project, ref: try reference(value["ref"]), action: "captions", captions: data)
                        return NSNull()
                    }
                    return try library.addFiles(project, urls: urls, folder: folder, scope: scope(value["scope"], project: project),
                                                draftID: value["draftId"].map { try draftID($0) })
                }
            }
        case "resources.openTranscript":
            respond { [self] in
                guard Set(value.keys) == ["projectId", "ref"] else { throw ResourceError.invalid }
                let transcript = try library.transcript(project, ref: reference(value["ref"]))
                let title = (english ? "Transcript · " : "转写 · ") + transcript.name
                DispatchQueue.main.async { self.previews.openTranscript(title: title, text: transcript.text) }
                return NSNull()
            }
        case "resources.open":
            queue.async { [self] in
                do {
                    let item = try library.item(project, ref: reference(value["ref"]))
                    let segment = value["segmentId"] as? String
                    if segment != nil && !item.segments.contains(where: { $0.id == segment }) { throw ResourceError.unavailable }
                    let location = item.segments.first { $0.id == segment }?.location
                    DispatchQueue.main.async {
                        if self.previews.open(item, location: location) { reply(NSNull(), nil) }
                        else { reply(nil, ResourceError.unavailable.rawValue) }
                    }
                } catch { DispatchQueue.main.async { reply(nil, ResourceError.unavailable.rawValue) } }
            }
        default:
            respond { [self] in
                try execute(action, project: project, value: value)
            }
        }
    }

    private func execute(_ action: String, project: String, value: [String: Any]) throws -> Any {
        switch action {
        case "resources.read":
            return try library.list(project, scope: scope(value["scope"], project: project))
        case "resources.library":
            return try library.list(project, scope: nil, all: true)
        case "resources.limits":
            return ["files": ResourceLibrary.planningFiles, "links": ResourceLibrary.planningLinks,
                    "lessonFiles": ResourceLibrary.lessonFiles, "lessonLinks": ResourceLibrary.lessonLinks]
        case "resources.beginDraft":
            guard Set(value.keys) == ["projectId"] else { throw ResourceError.invalid }
            return try library.beginDraft(project)
        case "resources.readDraft":
            guard Set(value.keys) == ["projectId", "draftId"] else { throw ResourceError.invalid }
            return try library.readDraft(project, id: draftID(value["draftId"]))
        case "resources.saveDraft", "resources.discardDraft":
            let saving = action == "resources.saveDraft"
            guard Set(value.keys) == (saving ? ["projectId", "draftId", "refs"] : ["projectId", "draftId"]) else {
                throw ResourceError.invalid
            }
            let saveRefs = saving ? try references(value["refs"]) : nil
            let removed = try library.finishDraft(project, id: draftID(value["draftId"]), saveRefs: saveRefs)
            for ref in removed { invalidate(project, ref.id) }
            return NSNull()
        case "resources.removeDraftItems", "resources.removeDraftFailures":
            let allFailures = action == "resources.removeDraftFailures"
            guard Set(value.keys) == (allFailures ? ["projectId", "draftId"] : ["projectId", "draftId", "refs"]) else {
                throw ResourceError.invalid
            }
            let refs = allFailures ? nil : try references(value["refs"])
            try library.removeFromDraft(project, id: draftID(value["draftId"]), refs: refs)
            return NSNull()
        case "resources.bindings":
            let (state, route) = try route(project, value: value)
            let links = (state["routeMaterials"] as? [[String: Any]])?.first(where: { $0["routeId"] as? String == route["id"] as? String })?["links"] as? [[String: String]] ?? []
            return ["links": links, "items": try library.describe(project, refs: links.map(reference))]
        case "resources.detail":
            return try library.item(project, ref: reference(value["ref"])).display(details: true)
        case "resources.attachLesson":
            guard Set(value.keys) == ["projectId", "ref", "scope"],
                  let target = try scope(value["scope"], project: project) else { throw ResourceError.invalid }
            return try library.addExisting(project, ref: reference(value["ref"]), scope: target)
        case "resources.transcribe":
            guard Set(value.keys) == ["projectId", "ref", "locale"], let locale = value["locale"] as? String
            else { throw ResourceError.invalid }
            try library.change(project, ref: reference(value["ref"]), action: "transcribe", speechLocale: locale)
            return NSNull()
        case "resources.addLinks":
            guard let text = value["text"] as? String,
                  Set(value.keys) == ["projectId", "text", "scope"] || Set(value.keys) == ["projectId", "text", "draftId"]
            else { throw ResourceError.invalid }
            return try library.addLinks(project, text: text, scope: scope(value["scope"], project: project),
                                        draftID: value["draftId"].map { try draftID($0) })
        case "resources.bind", "resources.unbind":
            let (state, route) = try route(project, value: value)
            let ref = try reference(value["ref"])
            let add = action == "resources.bind", item = try library.item(project, ref: ref)
            guard let kind = value["kind"] as? String, ["chapter", "lesson"].contains(kind),
                  let target = value["targetId"] as? String, let routeID = route["id"] as? String,
                  let expected = value["expectedRevision"] as? NSNumber, CFGetTypeID(expected) != CFBooleanGetTypeID(),
                  expected.doubleValue == Double(expected.intValue)
            else { throw ResourceError.invalid }
            guard expected.intValue == state["revision"] as? Int else { throw PlanningError.conflict }
            var link = ["id": ref.id, "version": ref.version, "kind": kind, "targetId": target, "origin": "editor"]
            if let segment = value["segmentId"] as? String {
                guard !add || item.segments.contains(where: { $0.id == segment }) else { throw ResourceError.unavailable }
                link["segmentId"] = segment
            }
            if add && (item.removed || item.draftID != nil) { throw ResourceError.unavailable }
            return try planning.setRouteMaterial(projectID: project, routeID: routeID, link: link, add: add, expectedRevision: expected.intValue)
        case "resources.detach", "resources.retry", "resources.pauseTranscription":
            let verb = String(action.dropFirst("resources.".count))
            let ref = try reference(value["ref"])
            try library.change(project, ref: ref, action: verb, scope: scope(value["scope"], project: project))
            return NSNull()
        default: throw ResourceError.invalid
        }
    }

    private func searchTutorials(_ project: String, revision: Int, draft: String, restart: Bool, locale: String) throws -> [String: Any] {
        func currentIntake() throws -> [String: Any] {
            guard let state = try planning.read(projectID: project), state["revision"] as? Int == revision,
                  state["step"] as? String == "intake", state["pending"] == nil else { throw ResourceError.changed }
            return state
        }
        let state = try currentIntake()
        let goal = try PlanningPromptPack.acceptedAnswers(state)["goal"] as? [String: Any]
        let fields = goal?["fields"] as? [String: String]
        let topic = String((fields?["topic"] ?? fields?["outcome"] ?? "")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(200))
        guard !topic.isEmpty else { throw ResourceError.searchNeedsTopic }
        guard let provider = state["provider"] as? String, let agent else { throw ResourceError.searchUnavailable }
        let search = try library.prepareTutorialSearch(project, draftID: draft, restart: restart)
        guard search.slots > 0 else { return ["status": "full", "added": 0] }
        let candidates: [String]
        do {
            candidates = try agent.searchTutorials(projectID: project, provider: provider, topic: topic, locale: locale,
                maxCandidates: min(ResourceLibrary.planningLinks * 2, max(6, search.slots * 2)),
                options: state["agentOptions"] as? [String: Any] ?? [:], excluding: search.excluded)
        } catch {
            throw ResourceError.searchUnavailable
        }
        let added = try library.addTutorialResults(project, draftID: draft, candidates: candidates, validate: { _ = try currentIntake() })
        return ["status": "complete", "added": added]
    }

    private func draftID(_ value: Any?) throws -> String {
        guard let id = value as? String, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ResourceError.invalid }
        return id
    }

    private func references(_ value: Any?) throws -> Set<ResourceSelection> {
        guard let refs = value as? [[String: String]], refs.count <= ResourceLibrary.planningFiles + ResourceLibrary.planningLinks,
              refs.allSatisfy({ Set($0.keys) == ["id", "version"] }) else { throw ResourceError.invalid }
        return try Set(refs.map(reference))
    }

    private func reference(_ value: Any?) throws -> ResourceSelection {
        guard let ref = value as? [String: String], let id = ref["id"], let version = ref["version"],
              UUID(uuidString: id) != nil, UUID(uuidString: version) != nil else { throw ResourceError.invalid }
        return ResourceSelection(id: id, version: version)
    }

    private func route(_ project: String, value: [String: Any]) throws -> ([String: Any], [String: Any]) {
        guard let routeID = value["routeId"] as? String, let state = try planning.read(projectID: project),
              let route = state["routeDraft"] as? [String: Any], route["id"] as? String == routeID else { throw ResourceError.changed }
        return (state, route)
    }

    private func scope(_ value: Any?, project: String) throws -> ResourceScope? {
        guard let value else { return nil }
        guard let fields = value as? [String: String], Set(fields.keys) == ["routeId", "nodeId"], let routeId = fields["routeId"],
              let nodeID = fields["nodeId"] else { throw ResourceError.invalid }
        let (state, route) = try route(project, value: ["routeId": routeId])
        guard (state["step"] as? String == "editor" || state["confirmedRevision"] as? Int == route["revision"] as? Int),
              let chapters = route["chapters"] as? [[String: Any]],
              chapters.contains(where: { ($0["nodes"] as? [[String: Any]])?.contains(where: { $0["id"] as? String == nodeID }) == true })
        else { throw ResourceError.changed }
        return ResourceScope(routeId: routeId, nodeId: nodeID)
    }
}
