import Foundation
import JavaScriptCore
import CryptoKit

enum PlanningError:String,Error {
    case generationInvalid="PLANNING_GENERATION_INVALID", generationStale="PLANNING_GENERATION_STALE", generationExists="PLANNING_GENERATION_EXISTS"
    case invalid="PLANNING_INVALID", large="PLANNING_TOO_LARGE", conflict="PLANNING_CONFLICT", busy="PLANNING_BUSY"
    case incomplete="PLANNING_INCOMPLETE", evidence="PLANNING_EVIDENCE_INVALID", response="PLANNING_RESPONSE_INVALID", replace="PLANNING_REPLACE_REQUIRED"
    case route="PLANNING_ROUTE_INVALID", target="PLANNING_TARGET_UNAVAILABLE", limit="PLANNING_LIMIT", storage="PLANNING_STORAGE_UNAVAILABLE", project="PLANNING_PROJECT_UNAVAILABLE"
    case studiedLessonLocked="PLANNING_STUDIED_LESSON_LOCKED"
}

final class PlanningStore {
    enum LearningChange {
        case start(String)
        case complete(String)
        case skip(String, reason: String)
        case reset
    }

    private struct LearningProgress: Codable {
        let routeId: String
        var completedNodeIds: Set<String>
        var skippedReasons: [String: String]?
        var startedNodeIds: Set<String>?
        var progressRevision: Int?
        var notebookResetRevision: Int?

        var studiedNodeIds: Set<String> { completedNodeIds.union(startedNodeIds ?? []) }
        var revision: Int { progressRevision ?? 0 }
    }

    private let files:RuntimeDirectory,validatorURL:URL,workspace:(String)throws->URL
    private let projectFiles: RuntimeDirectory
    private let lock=NSRecursiveLock()
    private var seenProjects=Set<String>()
    private let maximumBytes=8_388_608
    init(runtime:RuntimeDirectory,validatorURL:URL?=nil,workspace:@escaping(String)throws->URL)throws{
        projectFiles = try runtime.child("projects")
        files = try projectFiles.child("planning")
        self.validatorURL=validatorURL ?? Bundle.main.resourceURL!.appendingPathComponent("PlanningValidation/planning.js")
        self.workspace=workspace
    }
    private func project(_ id:String)throws{
        guard id.range(of:"^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",options:.regularExpression) != nil else{throw PlanningError.invalid}
        do{_ = try workspace(id)}catch{throw PlanningError.project}
    }
    private func invoke(_ name:String,_ args:[Any])throws->JSValue?{
        guard let code=try? String(contentsOf:validatorURL,encoding:.utf8),let context=JSContext() else{throw PlanningError.storage}
        context.evaluateScript(code)
        guard context.exception==nil,let function=context.objectForKeyedSubscript("VibePlanning")?.objectForKeyedSubscript(name),!function.isUndefined else{throw PlanningError.storage}
        let result=function.call(withArguments:args)
        if let exception=context.exception{throw PlanningError(rawValue:exception.objectForKeyedSubscript("message")?.toString() ?? "") ?? .invalid}
        return result
    }
    private func call(_ name:String,_ args:[Any])throws->[String:Any]{
        let result=try invoke(name,args)
        guard let value=result?.toDictionary() as? [String:Any],JSONSerialization.isValidJSONObject(value) else{throw PlanningError.invalid}
        return value
    }
    private func raw(_ id:String)throws->[String:Any]?{
        guard let data=try files.read(id+".json",maximumBytes:maximumBytes) else{return nil}
        guard let state=try? JSONSerialization.jsonObject(with:data) as? [String:Any],state["projectId"] as? String==id else{throw PlanningError.storage}
        return try call("validatePlanning",[state])
    }
    private func write(_ id:String,_ state:[String:Any])throws{
        let validated=try call("validatePlanning",[state]),data=try JSONSerialization.data(withJSONObject:validated,options:.sortedKeys)
        guard data.count<=maximumBytes else{throw PlanningError.large};try files.write(id+".json",data:data)
    }
    private func initialized(_ id:String)throws->[String:Any]?{
        var state=try raw(id)
        if !seenProjects.contains(id),let current=state,current["pending"] != nil{
            state=try call("recoverPlanning",[current]);try write(id,state!)
        }
        seenProjects.insert(id);return state
    }
    private func synchronized<T>(_ id:String,_ body:()throws->T)throws->T{
        try project(id);lock.lock();defer{lock.unlock()};return try files.locked(body)
    }
    func read(projectID:String)throws->[String:Any]?{try synchronized(projectID){try initialized(projectID)}}
    private func learningLocation(_ projectID: String, _ routeID: String) throws -> (directory: RuntimeDirectory, name: String) {
        let directory = try projectFiles.child("learning").child(projectID)
        let routeKey = SHA256.hash(data: Data(routeID.utf8)).map { String(format: "%02x", $0) }.joined()
        return (directory, routeKey + ".json")
    }
    private func readProgress(_ directory: RuntimeDirectory, _ name: String, routeID: String) throws -> LearningProgress {
        guard let data = try directory.read(name, maximumBytes: maximumBytes) else {
            return LearningProgress(routeId: routeID, completedNodeIds: [])
        }
        let progress = try JSONDecoder().decode(LearningProgress.self, from: data)
        guard progress.routeId == routeID, progress.revision >= 0, progress.revision < 1_000_000_000,
              (progress.notebookResetRevision ?? 0) >= 0, (progress.notebookResetRevision ?? 0) <= progress.revision else { throw PlanningError.storage }
        return progress
    }
    private func protectStudiedLessons(_ projectID: String, previous: [String: Any]?, next: [String: Any]?) throws {
        guard let previous, let routeID = previous["id"] as? String else { return }
        if let next, NSDictionary(dictionary: previous).isEqual(to: next) { return }
        let location = try learningLocation(projectID, routeID)
        let studied = try readProgress(location.directory, location.name, routeID: routeID).studiedNodeIds
        guard !studied.isEmpty else { return }
        _ = try invoke("assertStudiedRouteUnchanged", [previous, next.map { $0 as Any } ?? NSNull(), studied.sorted()])
    }
    func withRouteReplacementGuard<T>(projectID: String, _ operation: () throws -> T) throws -> T {
        try synchronized(projectID) {
            let route = try initialized(projectID)?["routeDraft"] as? [String: Any]
            try protectStudiedLessons(projectID, previous: route, next: nil)
            return try operation()
        }
    }
    func learningProgress(projectID: String, routeID: String, revision: Int, change: LearningChange? = nil, expectedProgressRevision: Int? = nil) throws -> [String: Any] {
        try synchronized(projectID) {
            guard let state = try initialized(projectID),
                  let route = state["routeDraft"] as? [String: Any],
                  route["id"] as? String == routeID,
                  route["revision"] as? Int == revision,
                  let chapters = route["chapters"] as? [[String: Any]] else { throw PlanningError.conflict }
            let nodes = chapters.flatMap { $0["nodes"] as? [[String: Any]] ?? [] }
            let ids = Set(nodes.compactMap { $0["id"] as? String })
            let location = try learningLocation(projectID, routeID)
            var progress = try readProgress(location.directory, location.name, routeID: routeID)
            var started = progress.studiedNodeIds
            var completed = progress.completedNodeIds
            var skipped = progress.skippedReasons ?? [:]
            var changed = false
            if let change {
                guard let expectedProgressRevision else { throw PlanningError.invalid }
                guard expectedProgressRevision == progress.revision else { throw PlanningError.conflict }
                if case .reset = change {
                    guard state["pending"] == nil else { throw PlanningError.busy }
                    started.removeAll()
                    completed.removeAll()
                    skipped.removeAll()
                    progress.notebookResetRevision = progress.revision + 1
                    changed = true
                } else {
                    guard state["confirmedRevision"] as? Int == revision else { throw PlanningError.conflict }
                    let nodeID: String
                    switch change {
                    case .start(let id), .complete(let id), .skip(let id, _): nodeID = id
                    case .reset: throw PlanningError.invalid
                    }
                    guard nodes.contains(where: { $0["id"] as? String == nodeID }),
                          let required = try invoke("learningPrerequisiteIds", [route, nodeID])?.toArray() as? [String],
                          completed.contains(nodeID) || required.allSatisfy({ completed.contains($0) || skipped[$0] != nil })
                          else { throw PlanningError.conflict }
                    switch change {
                    case .start:
                        changed = started.insert(nodeID).inserted
                    case .complete:
                        guard started.contains(nodeID) else { throw PlanningError.conflict }
                        changed = completed.insert(nodeID).inserted
                    case .skip(_, let rawReason):
                        let reason = rawReason.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !reason.isEmpty, reason.utf16.count <= 240 else { throw PlanningError.invalid }
                        guard !completed.contains(nodeID) else { throw PlanningError.conflict }
                        changed = skipped[nodeID] == nil
                        if changed { skipped[nodeID] = reason }
                    case .reset: throw PlanningError.invalid
                    }
                }
                if changed {
                    guard progress.revision < 999_999_999 else { throw PlanningError.limit }
                    progress.progressRevision = progress.revision + 1
                    progress.startedNodeIds = started
                    progress.completedNodeIds = completed
                    progress.skippedReasons = skipped
                    let data = try JSONEncoder().encode(progress)
                    guard data.count <= maximumBytes else { throw PlanningError.large }
                    try location.directory.write(location.name, data: data)
                }
            }
            return [
                "progressRevision": progress.revision,
                "notebookResetRevision": progress.notebookResetRevision ?? 0,
                "recordedNodeCount": started.union(skipped.keys).count,
                "startedNodeIds": started.intersection(ids).sorted(),
                "completedNodeIds": completed.intersection(ids).sorted(),
                "skippedReasons": skipped.filter { ids.contains($0.key) && !completed.contains($0.key) },
            ]
        }
    }
    func enter(projectID:String,provider:String?,locale:String,route:[String:Any]?=nil)throws->[String:Any]{
        try synchronized(projectID){
            if let existing=try initialized(projectID){
                if let route{
                    let next=try call("importRoute",[existing,route,existing["revision"] as Any])
                    try protectStudiedLessons(projectID, previous: existing["routeDraft"] as? [String: Any], next: next["routeDraft"] as? [String: Any])
                    try write(projectID,next);return next
                }
                return existing
            }
            let args:[Any]=[projectID,provider.map{$0 as Any} ?? NSNull(),locale]+(route.map{[$0]} ?? [])
            let state=try call("createPlanning",args);try write(projectID,state);return state
        }
    }
    private func mutate(_ id:String,_ name:String,_ arguments:[Any],beforeCommit:(()throws->Void)?=nil)throws->[String:Any]{
        try synchronized(id) {
            guard let current = try initialized(id) else { throw PlanningError.invalid }
            let previous = current["routeDraft"] as? [String: Any]
            let next = try call(name, [current] + arguments)
            let candidate: [String: Any]?
            if name == "startGeneration" {
                candidate = nil
            } else if name == "applyEdit", let proposal = next["proposal"] as? [String: Any],
                      (current["proposal"] as? [String: Any]).map({ NSDictionary(dictionary: $0).isEqual(to: proposal) }) != true {
                candidate = proposal["route"] as? [String: Any]
            } else {
                candidate = next["routeDraft"] as? [String: Any]
            }
            try protectStudiedLessons(id, previous: previous, next: candidate)
            try beforeCommit?()
            try write(id, next)
            return next
        }
    }
    func appendUser(projectID:String,text:String,messageID:String,requestID:String,expectedRevision:Int,target:[String:Any]?=nil,
                    mentions:[[String:Any]]?=nil,attachments:[[String:String]]?=nil)throws->[String:Any]{
        var args:[Any]=[text,messageID,requestID,expectedRevision]
        if let attachments {
            args += [ISO8601DateFormatter().string(from:Date()),target.map{$0 as Any} ?? NSNull(),mentions.map{$0 as Any} ?? NSNull(),attachments]
        } else if let mentions {
            args += [ISO8601DateFormatter().string(from:Date()),target.map{$0 as Any} ?? NSNull(),mentions]
        } else if let target {
            args += [ISO8601DateFormatter().string(from:Date()),target]
        }
        return try mutate(projectID,"appendUser",args)
    }
    func beginInterviewPrefill(projectID:String,requestID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"beginInterviewPrefill",[requestID,expectedRevision])}
    func applyInterview(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyInterview",[result,requestID,baseRevision])}
    func beginConsistencyCheck(projectID:String,requestID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"beginConsistencyCheck",[requestID,expectedRevision])}
    func applyConsistencyCheck(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyConsistencyCheck",[result,requestID,baseRevision])}
    func acceptConsistencySuggestion(projectID:String,issueID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"acceptConsistencySuggestion",[issueID,expectedRevision])}
    func planningFacts(projectID:String)throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("planningFacts",[state])}}
    func startGeneration(projectID:String,requestID:String,expectedRevision:Int,replaceExisting:Bool=false,generationMode:String="new",snapshot:[String:Any]?=nil)throws->[String:Any]{try mutate(projectID,"startGeneration",[requestID,expectedRevision,replaceExisting,generationMode,snapshot.map{$0 as Any} ?? NSNull()])}
    func saveGenerationProgress(projectID:String,progress:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"saveGenerationProgress",[progress,requestID,baseRevision])}
    func saveGenerationRevision(projectID:String,patch:[String:Any]?,requestID:String,baseRevision:Int)throws->[String:Any]{
        try mutate(projectID,"saveGenerationRevision",[patch.map{$0 as Any} ?? NSNull(),requestID,baseRevision])
    }
    func acceptAnswer(projectID:String,questionID:String,messageID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"acceptAnswer",[questionID,messageID,expectedRevision])}
    func reanswer(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"restartIntakeFrom",[questionID,expectedRevision])}
    func restartIntake(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"restartIntake",[expectedRevision])}
    func cancelAnswerDraft(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"cancelAnswerDraft",[questionID,expectedRevision])}
    func setResources(projectID:String,text:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"setResources",[text,expectedRevision])}
    func applyGenerated(projectID:String,route:[String:Any],requestID:String,baseRevision:Int,revisedLessons:[String]=[],renamedLessons:[String]=[],materialLinks:[[String:String]] = [])throws->[String:Any]{try mutate(projectID,"applyGenerated",[route,requestID,baseRevision,revisedLessons,renamedLessons,materialLinks])}
    func setRouteMaterial(projectID: String, routeID: String, link: [String: String], add: Bool, expectedRevision: Int) throws -> [String: Any] {
        try mutate(projectID, "setRouteMaterial", [routeID, link, add, expectedRevision], beforeCommit: {
            guard let state = try self.raw(projectID), let route = state["routeDraft"] as? [String: Any],
                  let chapters = route["chapters"] as? [[String: Any]], let target = link["targetId"] else { throw PlanningError.conflict }
            let location = try self.learningLocation(projectID, routeID)
            let studied = try self.readProgress(location.directory, location.name, routeID: routeID).studiedNodeIds
            let affected = link["kind"] == "lesson" ? [target] : (chapters.first(where: { $0["id"] as? String == target })?["nodes"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            if affected.contains(where: studied.contains) { throw PlanningError.studiedLessonLocked }
        })
    }
    func applyEdit(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyEdit",[result,requestID,baseRevision])}
    func agentRouteDiagnostics(projectID:String,route:Any)throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("agentRouteDiagnostics",[state,route])}}
    func agentInterviewDiagnostics(projectID:String,result:[String:Any])throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("agentInterviewDiagnostics",[state,result])}}
    func cancel(projectID:String,requestID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"cancelPlanningRequest",[requestID,expectedRevision])}
    func focus(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"focusQuestion",[questionID,expectedRevision])}
    func setProvider(projectID:String,provider:String?,expectedRevision:Int,rememberChoice:Bool=false)throws->[String:Any]{
        try mutate(projectID,"setProvider",[provider.map{$0 as Any} ?? NSNull(),expectedRevision,rememberChoice])
    }
    func setAgentOptions(projectID:String,options:[String:Any],expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"setAgentOptions",[options,expectedRevision])}
    func reopenIntake(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"reopenIntake",[expectedRevision])}
    func reconcileMissingImport(projectID: String, expectedRevision: Int) throws {
        try synchronized(projectID) {
            guard let current = try initialized(projectID), current["revision"] as? Int == expectedRevision
                else { throw PlanningError.conflict }
            let previous = current["routeDraft"] as? [String: Any]
            if let routeID = previous?["id"] as? String,
               routeID == (current["importedOriginal"] as? [String: Any])?["id"] as? String {
                let location = try learningLocation(projectID, routeID)
                let progress = try readProgress(location.directory, location.name, routeID: routeID)
                if progress.revision > 0 || !progress.studiedNodeIds.isEmpty || !(progress.skippedReasons ?? [:]).isEmpty { return }
            }
            let next = try call("removeImportedRoute", [current, expectedRevision])
            try protectStudiedLessons(projectID, previous: previous, next: next["routeDraft"] as? [String: Any])
            try write(projectID, next)
        }
    }
    func removeImportedRoute(projectID:String,expectedRevision:Int,beforeCommit:(()throws->Void)?=nil)throws->[String:Any]{
        try mutate(projectID,"removeImportedRoute",[expectedRevision],beforeCommit:beforeCommit)
    }
    func openEditor(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"openEditor",[expectedRevision])}
    func resetEditor(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"resetEditor",[expectedRevision])}
    func saveEditor(projectID:String,route:[String:Any],expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"saveEditor",[route,expectedRevision])}
    func importRoute(projectID:String,route:[String:Any],expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"importRoute",[route,expectedRevision])}
    func confirmRoute(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"confirmRoute",[expectedRevision])}
    func applyProposal(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"applyProposal",[expectedRevision])}
    func discardProposal(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"discardProposal",[expectedRevision])}
    func undoEditor(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"undoEditor",[expectedRevision])}
    func redoEditor(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"redoEditor",[expectedRevision])}
}
