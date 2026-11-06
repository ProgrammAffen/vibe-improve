import Foundation
import CoreFoundation

final class PlanningCoordinator {
    private let store:PlanningStore,routes:RoutePreparationStore,agents:AgentManager,runner:PlanningAgentManager
    private let lock=NSRecursiveLock()
    private struct Active {let jobID:String,requestID:String}
    private var active:[String:Active]=[:]
    private let log:(String,String,[String:Any])->Void
    init(store:PlanningStore,routes:RoutePreparationStore,agents:AgentManager,runner:PlanningAgentManager,log:@escaping(String,String,[String:Any])->Void={_,_,_ in}){self.store=store;self.routes=routes;self.agents=agents;self.runner=runner;self.log=log}
    private func revision(_ value:Any?)throws->Int{
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue==Double(n.intValue),n.intValue>=0,n.intValue<1_000_000_000 else{throw PlanningError.invalid};return n.intValue
    }
    private func keys(_ value:[String:Any],_ names:Set<String>)throws{guard Set(value.keys)==names else{throw PlanningError.invalid}}
    private func current(_ id:String,_ expected:Int)throws->[String:Any]{guard let state=try store.read(projectID:id) else{throw PlanningError.invalid};guard try revision(state["revision"])==expected else{throw PlanningError.conflict};return state}
    private func provider(_ id:String)throws->String?{let choice=try agents.choice(id) as? String;return choice=="manual" ? nil:choice}
    private func clean(_ id:String,_ job:[String:Any])throws{
        guard ["failed","cancelled","completed"].contains(job["state"] as? String ?? ""),let running=active[id],running.jobID==job["id"] as? String else{return}
        if job["state"] as? String=="completed"{active.removeValue(forKey:id);return}
        log("native.planning.failed",job["errorCode"] as? String ?? "PLANNING_AGENT_FAILED",job["diagnostic"] as? [String:Any] ?? [:])
        if let state=try store.read(projectID:id),let pending=state["pending"] as? [String:Any],pending["id"] as? String==running.requestID{
            _ = try store.cancel(projectID:id,requestID:running.requestID,expectedRevision:try revision(state["revision"]))
        }
        active.removeValue(forKey:id)
    }
    func request(_ action:String,value:[String:Any])throws->Any{
        lock.lock();defer{lock.unlock()}
        guard let id=value["projectId"] as? String else{throw PlanningError.invalid}
        if let running=active[id]{
            do{let job=try runner.state(projectID:id,jobID:running.jobID);try clean(id,job)}
            catch PlanningAgentError.invalid{try clean(id,["id":running.jobID,"state":"failed"])}
        }
        if let saved=try store.read(projectID:id),saved["importedOriginal"] != nil,(try routes.read(projectID:id))["routeDraft"] == nil {
            _ = try store.removeImportedRoute(projectID:id,expectedRevision:revision(saved["revision"]))
        }
        switch action {
        case "planning.import.remove":
            try keys(value,["projectId","expectedRouteRevision","expectedPlanningRevision"])
            let routeRevision=try revision(value["expectedRouteRevision"]),saved=try store.read(projectID:id)
            if let saved{guard try revision(value["expectedPlanningRevision"])==revision(saved["revision"]),saved["pending"]==nil else{throw PlanningError.conflict}}
            else{guard value["expectedPlanningRevision"] is NSNull else{throw PlanningError.conflict}}
            let originalID=(saved?["importedOriginal"] as? [String:Any])?["id"] as? String
            let currentID=(saved?["routeDraft"] as? [String:Any])?["id"] as? String
            _ = try routes.removeImport(projectID:id,expectedRevision:routeRevision,preserveCreated:currentID != nil && currentID != originalID)
            if let saved{return try store.removeImportedRoute(projectID:id,expectedRevision:revision(saved["revision"]))}
            return NSNull()
        case "planning.models":
            guard Set(value.keys)==["projectId"] || Set(value.keys)==["projectId","refresh"],value["refresh"]==nil || value["refresh"] is Bool else{throw PlanningError.invalid};return try runner.models(projectID:id,refresh:value["refresh"] as? Bool ?? false)
        case "planning.options":
            try keys(value,["projectId","options","expectedRevision"])
            let expected=try revision(value["expectedRevision"]);_ = try current(id,expected)
            guard let options=value["options"] as? [String:Any] else{throw PlanningError.invalid}
            try runner.validateOptions(projectID:id,options:options)
            return try store.setAgentOptions(projectID:id,options:options,expectedRevision:expected)
        case "planning.read":
            try keys(value,["projectId"]);return try store.read(projectID:id) ?? NSNull()
        case "planning.enter":
            guard Set(value.keys)==["projectId","locale","mode"] || Set(value.keys)==["projectId","locale","mode","expectedRevision"],let locale=value["locale"] as? String,["zh-CN","en"].contains(locale),let mode=value["mode"] as? String,["ai","manual","import"].contains(mode) else{throw PlanningError.invalid}
            let routeState=try routes.read(projectID:id)
            guard routeState["agentConfirmed"] as? Bool==true else{throw PlanningError.incomplete}
            let selected=mode=="manual" ? nil:try provider(id)
            if mode=="ai",selected==nil{throw PlanningAgentError.unavailable}
            let imported=(routeState["routeDraft"] as? [String:Any])?["route"] as? [String:Any]
            if mode=="import",imported==nil{throw PlanningError.incomplete}
            let existing=try store.read(projectID:id)
            if let expected=value["expectedRevision"] {guard let existing,try revision(existing["revision"])==revision(expected) else{throw PlanningError.conflict}}
            var state=try store.enter(projectID:id,provider:selected,locale:locale,route:existing==nil && mode=="import" ? imported:nil)
            if mode=="import",existing != nil,value["expectedRevision"] != nil,let imported{state=try store.importRoute(projectID:id,route:imported,expectedRevision:try revision(state["revision"]))}
            if (state["provider"] as? String) != selected{state=try store.setProvider(projectID:id,provider:selected,expectedRevision:try revision(state["revision"]))}
            if mode=="ai",state["step"] as? String=="editor"{state=try store.reopenIntake(projectID:id,expectedRevision:revision(state["revision"]))}
            if mode != "ai",state["step"] as? String != "editor"{state=try store.openEditor(projectID:id,expectedRevision:try revision(state["revision"]))}
            return state
        case "planning.begin":
            guard Set(value.keys).isSubset(of:["projectId","intent","expectedRevision","text","target","mentions","replaceExisting","generationMode"]),Set(["projectId","intent","expectedRevision"]).isSubset(of:Set(value.keys)),let intent=value["intent"] as? String,["interview","generate","edit","consistency"].contains(intent) else{throw PlanningError.invalid}
            if let mode=value["generationMode"]{guard intent=="generate",let mode=mode as? String,["new","resume","restart"].contains(mode) else{throw PlanningError.invalid}}
            if value["replaceExisting"] != nil{guard intent=="generate",value["replaceExisting"] is Bool else{throw PlanningError.invalid}}
            if value["target"] != nil{guard intent=="edit",value["target"] is [String:Any],value["mentions"]==nil else{throw PlanningError.target}}
            if value["mentions"] != nil{guard intent=="edit",value["mentions"] is [[String:Any]] else{throw PlanningError.target}}
            let expected=try revision(value["expectedRevision"]),before=try current(id,expected)
            guard let selected=try provider(id),before["provider"] as? String==selected else{throw PlanningAgentError.unavailable}
            guard (intent=="edit" && before["step"] as? String=="editor") || (intent != "edit" && before["step"] as? String=="intake") else{throw PlanningError.invalid}
            let requestID=UUID().uuidString.lowercased(),state:[String:Any]
            if intent=="generate"{guard value["text"]==nil else{throw PlanningError.invalid};state=try store.startGeneration(projectID:id,requestID:requestID,expectedRevision:expected,replaceExisting:value["replaceExisting"] as? Bool ?? false,generationMode:value["generationMode"] as? String ?? "new")}
            else if intent=="consistency"{guard value["text"]==nil else{throw PlanningError.invalid};state=try store.beginConsistencyCheck(projectID:id,requestID:requestID,expectedRevision:expected)}
            else{guard let text=value["text"] as? String,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,text.utf8.count<=32_000 else{throw PlanningError.invalid};state=try store.appendUser(projectID:id,text:text,messageID:UUID().uuidString.lowercased(),requestID:requestID,expectedRevision:expected,target:value["target"] as? [String:Any],mentions:value["mentions"] as? [[String:Any]])}
            guard let pending=state["pending"] as? [String:Any] else{throw PlanningError.invalid}
            let base=try revision(pending["baseRevision"])
            do{
                let job=try runner.begin(projectID:id,intent:intent,context:state,saveProgress:{[self] progress in
                    _ = try store.saveGenerationProgress(projectID:id,progress:progress,requestID:requestID,baseRevision:base)
                },validateRoute:{[self] route in
                    let details=try store.agentRouteDiagnostics(projectID:id,route:route)
                    if !(details["issues"] as? [[String:String]] ?? []).isEmpty{throw NSError(domain:"VibeImprove.PlanningValidation",code:1,userInfo:details)}
                }){[self] result in
                    lock.lock();defer{lock.unlock()}
                    let applied:[String:Any]
                    do{switch intent {
                    case "interview":applied=try store.applyInterview(projectID:id,result:result,requestID:requestID,baseRevision:base)
                    case "consistency":applied=try store.applyConsistencyCheck(projectID:id,result:result,requestID:requestID,baseRevision:base)
                    case "generate":
                        if result["generationBlocked"] as? Bool==true,let consistency=result["consistency"] as? [String:Any],consistency["status"] as? String=="requires_review",let reply=result["reply"] as? String {
                            applied=try store.applyConsistencyCheck(projectID:id,result:["reply":reply,"consistency":consistency],requestID:requestID,baseRevision:base)
                        }else{guard let route=result["route"] as? [String:Any] else{throw PlanningError.response};applied=try store.applyGenerated(projectID:id,route:route,requestID:requestID,baseRevision:base)}
                    default:applied=try store.applyEdit(projectID:id,result:result,requestID:requestID,baseRevision:base)
                    }}catch PlanningError.evidence{
                        let details=(try? store.agentInterviewDiagnostics(projectID:id,result:result)) ?? [:]
                        throw NSError(domain:"VibeImprove.PlanningEvidence",code:1,userInfo:details)
                    }catch PlanningError.route{
                        let details=(try? store.agentRouteDiagnostics(projectID:id,route:result["route"] ?? NSNull())) ?? [:]
                        throw NSError(domain:"VibeImprove.PlanningValidation",code:1,userInfo:details)
                    }
                    let diagnostic=active[id].flatMap{try? runner.state(projectID:id,jobID:$0.jobID)["diagnostic"] as? [String:Any]} ?? [:]
                    if active[id]?.requestID==requestID{active.removeValue(forKey:id)}
                    log("native.planning.completed","OK",diagnostic)
                    return applied
                }
                guard let jobID=job["id"] as? String else{throw PlanningError.invalid};active[id]=Active(jobID:jobID,requestID:requestID);log("native.planning.started","OK",job["diagnostic"] as? [String:Any] ?? [:]);return job
            }catch{_ = try? store.cancel(projectID:id,requestID:requestID,expectedRevision:try revision(state["revision"]));throw error}
        case "planning.state","planning.cancel":
            try keys(value,["projectId","jobId"]);guard let jobID=value["jobId"] as? String else{throw PlanningError.invalid}
            if action=="planning.cancel"{try runner.cancel(projectID:id,jobID:jobID)}
            let job=try runner.state(projectID:id,jobID:jobID);try clean(id,job);return job
        case "planning.save":
            try keys(value,["projectId","route","expectedRevision"]);guard let route=value["route"] as? [String:Any] else{throw PlanningError.invalid};return try store.saveEditor(projectID:id,route:route,expectedRevision:revision(value["expectedRevision"]))
        case "planning.focus":
            try keys(value,["projectId","questionId","expectedRevision"]);guard let question=value["questionId"] as? String else{throw PlanningError.invalid};return try store.focus(projectID:id,questionID:question,expectedRevision:revision(value["expectedRevision"]))
        case "planning.answer.accept":
            try keys(value,["projectId","questionId","messageId","expectedRevision"]);guard let question=value["questionId"] as? String,let message=value["messageId"] as? String else{throw PlanningError.invalid};return try store.acceptAnswer(projectID:id,questionID:question,messageID:message,expectedRevision:revision(value["expectedRevision"]))
        case "planning.answer.reset":
            try keys(value,["projectId","questionId","expectedRevision"]);guard let question=value["questionId"] as? String else{throw PlanningError.invalid};return try store.reanswer(projectID:id,questionID:question,expectedRevision:revision(value["expectedRevision"]))
        case "planning.intake.restart":
            try keys(value,["projectId","expectedRevision"]);return try store.restartIntake(projectID:id,expectedRevision:revision(value["expectedRevision"]))
        case "planning.answer.cancel-draft":
            try keys(value,["projectId","questionId","expectedRevision"]);guard let question=value["questionId"] as? String else{throw PlanningError.invalid};return try store.cancelAnswerDraft(projectID:id,questionID:question,expectedRevision:revision(value["expectedRevision"]))
        case "planning.consistency.suggestion.accept":
            try keys(value,["projectId","issueId","expectedRevision"]);guard let issue=value["issueId"] as? String else{throw PlanningError.invalid};return try store.acceptConsistencySuggestion(projectID:id,issueID:issue,expectedRevision:revision(value["expectedRevision"]))
        case "planning.resources.save":
            try keys(value,["projectId","text","expectedRevision"]);guard let text=value["text"] as? String else{throw PlanningError.invalid};return try store.setResources(projectID:id,text:text,expectedRevision:revision(value["expectedRevision"]))
        case "planning.reopen-intake","planning.open-editor","planning.route.reset","planning.confirm","planning.proposal.apply","planning.proposal.discard","planning.undo","planning.redo":
            try keys(value,["projectId","expectedRevision"]);let expected=try revision(value["expectedRevision"])
            switch action{
            case "planning.reopen-intake":return try store.reopenIntake(projectID:id,expectedRevision:expected)
            case "planning.open-editor":return try store.openEditor(projectID:id,expectedRevision:expected)
            case "planning.route.reset":return try store.resetEditor(projectID:id,expectedRevision:expected)
            case "planning.confirm":return try store.confirmRoute(projectID:id,expectedRevision:expected)
            case "planning.proposal.apply":return try store.applyProposal(projectID:id,expectedRevision:expected)
            case "planning.proposal.discard":return try store.discardProposal(projectID:id,expectedRevision:expected)
            case "planning.redo":return try store.redoEditor(projectID:id,expectedRevision:expected)
            default:return try store.undoEditor(projectID:id,expectedRevision:expected)
            }
        default:throw PlanningError.invalid
        }
    }
}
