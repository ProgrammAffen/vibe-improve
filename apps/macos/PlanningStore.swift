import Foundation
import JavaScriptCore

enum PlanningError:String,Error {
    case generationInvalid="PLANNING_GENERATION_INVALID", generationStale="PLANNING_GENERATION_STALE", generationExists="PLANNING_GENERATION_EXISTS"
    case invalid="PLANNING_INVALID", large="PLANNING_TOO_LARGE", conflict="PLANNING_CONFLICT", busy="PLANNING_BUSY"
    case incomplete="PLANNING_INCOMPLETE", evidence="PLANNING_EVIDENCE_INVALID", response="PLANNING_RESPONSE_INVALID", replace="PLANNING_REPLACE_REQUIRED"
    case route="PLANNING_ROUTE_INVALID", target="PLANNING_TARGET_UNAVAILABLE", limit="PLANNING_LIMIT", storage="PLANNING_STORAGE_UNAVAILABLE", project="PLANNING_PROJECT_UNAVAILABLE"
}

final class PlanningStore {
    private let files:RuntimeDirectory,validatorURL:URL,workspace:(String)throws->URL
    private let lock=NSRecursiveLock()
    private var seenProjects=Set<String>()
    private let maximumBytes=8_388_608
    init(runtime:RuntimeDirectory,validatorURL:URL?=nil,workspace:@escaping(String)throws->URL)throws{
        files=try runtime.child("projects").child("planning")
        self.validatorURL=validatorURL ?? Bundle.main.resourceURL!.appendingPathComponent("PlanningValidation/planning.js")
        self.workspace=workspace
    }
    private func project(_ id:String)throws{
        guard id.range(of:"^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",options:.regularExpression) != nil else{throw PlanningError.invalid}
        do{_ = try workspace(id)}catch{throw PlanningError.project}
    }
    private func call(_ name:String,_ args:[Any])throws->[String:Any]{
        guard let code=try? String(contentsOf:validatorURL,encoding:.utf8),let context=JSContext() else{throw PlanningError.storage}
        context.evaluateScript(code)
        guard context.exception==nil,let function=context.objectForKeyedSubscript("VibePlanning")?.objectForKeyedSubscript(name),!function.isUndefined else{throw PlanningError.storage}
        let result=function.call(withArguments:args)
        if let exception=context.exception{throw PlanningError(rawValue:exception.objectForKeyedSubscript("message")?.toString() ?? "") ?? .invalid}
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
    func enter(projectID:String,provider:String?,locale:String,route:[String:Any]?=nil)throws->[String:Any]{
        try synchronized(projectID){
            if let existing=try initialized(projectID){
                if let route{
                    let next=try call("importRoute",[existing,route,existing["revision"] as Any])
                    try write(projectID,next);return next
                }
                return existing
            }
            let args:[Any]=[projectID,provider.map{$0 as Any} ?? NSNull(),locale]+(route.map{[$0]} ?? [])
            let state=try call("createPlanning",args);try write(projectID,state);return state
        }
    }
    private func mutate(_ id:String,_ name:String,_ arguments:[Any])throws->[String:Any]{
        try synchronized(id){guard let current=try initialized(id) else{throw PlanningError.invalid};let next=try call(name,[current]+arguments);try write(id,next);return next}
    }
    func appendUser(projectID:String,text:String,messageID:String,requestID:String,expectedRevision:Int,target:[String:Any]?=nil,mentions:[[String:Any]]?=nil)throws->[String:Any]{var args:[Any]=[text,messageID,requestID,expectedRevision];if let mentions{args += [ISO8601DateFormatter().string(from:Date()),target.map{$0 as Any} ?? NSNull(),mentions]}else if let target{args += [ISO8601DateFormatter().string(from:Date()),target]};return try mutate(projectID,"appendUser",args)}
    func applyInterview(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyInterview",[result,requestID,baseRevision])}
    func beginConsistencyCheck(projectID:String,requestID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"beginConsistencyCheck",[requestID,expectedRevision])}
    func applyConsistencyCheck(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyConsistencyCheck",[result,requestID,baseRevision])}
    func acceptConsistencySuggestion(projectID:String,issueID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"acceptConsistencySuggestion",[issueID,expectedRevision])}
    func planningFacts(projectID:String)throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("planningFacts",[state])}}
    func startGeneration(projectID:String,requestID:String,expectedRevision:Int,replaceExisting:Bool=false,generationMode:String="new")throws->[String:Any]{try mutate(projectID,"startGeneration",[requestID,expectedRevision,replaceExisting,generationMode])}
    func saveGenerationProgress(projectID:String,progress:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"saveGenerationProgress",[progress,requestID,baseRevision])}
    func acceptAnswer(projectID:String,questionID:String,messageID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"acceptAnswer",[questionID,messageID,expectedRevision])}
    func reanswer(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"restartIntakeFrom",[questionID,expectedRevision])}
    func restartIntake(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"restartIntake",[expectedRevision])}
    func cancelAnswerDraft(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"cancelAnswerDraft",[questionID,expectedRevision])}
    func setResources(projectID:String,text:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"setResources",[text,expectedRevision])}
    func applyGenerated(projectID:String,route:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyGenerated",[route,requestID,baseRevision])}
    func applyEdit(projectID:String,result:[String:Any],requestID:String,baseRevision:Int)throws->[String:Any]{try mutate(projectID,"applyEdit",[result,requestID,baseRevision])}
    func agentRouteDiagnostics(projectID:String,route:Any)throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("agentRouteDiagnostics",[state,route])}}
    func agentInterviewDiagnostics(projectID:String,result:[String:Any])throws->[String:Any]{try synchronized(projectID){guard let state=try initialized(projectID) else{throw PlanningError.invalid};return try call("agentInterviewDiagnostics",[state,result])}}
    func cancel(projectID:String,requestID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"cancelPlanningRequest",[requestID,expectedRevision])}
    func focus(projectID:String,questionID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"focusQuestion",[questionID,expectedRevision])}
    func setProvider(projectID:String,provider:String?,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"setProvider",[provider.map{$0 as Any} ?? NSNull(),expectedRevision])}
    func setAgentOptions(projectID:String,options:[String:Any],expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"setAgentOptions",[options,expectedRevision])}
    func reopenIntake(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"reopenIntake",[expectedRevision])}
    func removeImportedRoute(projectID:String,expectedRevision:Int)throws->[String:Any]{try mutate(projectID,"removeImportedRoute",[expectedRevision])}
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
