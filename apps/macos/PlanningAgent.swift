import Foundation
import Darwin

enum PlanningAgentError:String,Error {
    case options="PLANNING_AGENT_OPTIONS", evidence="PLANNING_EVIDENCE_INVALID"
    case invalid="PLANNING_AGENT_INVALID", unsupported="PLANNING_AGENT_UNSUPPORTED", busy="PLANNING_AGENT_BUSY"
    case unavailable="PLANNING_AGENT_UNAVAILABLE", auth="PLANNING_AGENT_AUTH_REQUIRED", permission="PLANNING_AGENT_PERMISSION_REQUIRED"
    case timeout="PLANNING_AGENT_TIMEOUT", cancelled="PLANNING_AGENT_CANCELLED", network="PLANNING_AGENT_NETWORK", quota="PLANNING_AGENT_QUOTA"
    case protocolFailure="PLANNING_AGENT_PROTOCOL", tooLarge="PLANNING_AGENT_OUTPUT_TOO_LARGE", failed="PLANNING_AGENT_FAILED", rejected="PLANNING_AGENT_RESULT_REJECTED", routeMissing="PLANNING_AGENT_ROUTE_MISSING", routeEncoding="PLANNING_AGENT_ROUTE_ENCODING"
}

struct PlanningOutputError:Error,CustomStringConvertible,CustomDebugStringConvertible {
    let code:PlanningAgentError,issues:[[String:String]]
    fileprivate let repairCandidate:String?
    init(code:PlanningAgentError,issues:[[String:String]],repairCandidate:String?=nil){self.code=code;self.issues=issues;self.repairCandidate=PlanningRepair.bounded(repairCandidate)}
    var description:String{code.rawValue}
    var debugDescription:String{code.rawValue}
}

enum PlanningRepair {
    private static let maximumCandidateBytes=128*1024,maximumContextBytes=768*1024
    static func bounded(_ text:String?)->String?{guard let text,!text.isEmpty,text.utf8.count<=maximumCandidateBytes else{return nil};return text}
    static func candidate(_ value:[String:Any]?)->String?{
        guard let value,JSONSerialization.isValidJSONObject(value),let data=try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys),data.count<=maximumCandidateBytes else{return nil}
        return String(decoding:data,as:UTF8.self)
    }
    static func prompt(_ original:String,candidate:String?,issues:[[String:String]])->String?{
        let marker="\nCONTEXT_JSON_DATA:\n"
        guard original.hasPrefix(PlanningAgentPrompt.policy),let split=original.range(of:marker) else{return nil}
        let fixed=String(original[..<split.lowerBound]),originalData=String(original[split.upperBound...])
        guard let task=["interview","outline","lessons","review","edit","consistency"].first(where:{fixed.contains("TASK: "+$0+"\n")}),var data=try? PlanningStrictJSON.object(originalData) else{return nil}
        guard let candidate=bounded(candidate) else{return try? PlanningPromptPack.make(task:task,data:data,repair:true)}
        let fields="status|reply|result|missing|updates|fields|evidence|messageRef|proposalRef|questionId|complete|summary|unresolved|consistency|issues|kind|reason|suggestion|route|format|schemaVersion|id|revision|title|locale|sourceLanguage|chapters|nodes|stageGoal|objectives|description|prerequisites|estimatedMinutes|activities|assessment|task|passCriteria|objectiveIds|mode|evaluatorPrompt|[0-9]+"
        let safe=issues.filter{issue in
            guard Set(issue.keys)==["path","code"],let path=issue["path"],path.utf8.count<=256,let code=issue["code"],["required","invalid","count","duplicate","dependencies","identity"].contains(code) else{return false}
            return path.range(of:"^(?:"+fields+")(?:\\.(?:"+fields+"))*$",options:.regularExpression) != nil
        }
        data["repair"]=["candidate":candidate,"issues":Array(safe.prefix(24))]
        guard let encoded=try? JSONSerialization.data(withJSONObject:data,options:.sortedKeys),encoded.count<=maximumContextBytes else{return try? PlanningPromptPack.make(task:task,data:PlanningStrictJSON.object(originalData),repair:true)}
        return try? PlanningPromptPack.make(task:task,data:data,repair:true)
    }
}

enum PlanningAgentPrompt {
    static var policy:String{PlanningPromptPack.policy}
    static func make(intent:String,context:[String:Any])throws->String {
        guard ["interview","generate","edit","consistency"].contains(intent),let locale=context["locale"] as? String,["zh-CN","en"].contains(locale),context["questions"] is [[String:Any]],context["messages"] is [[String:Any]] else{throw PlanningAgentError.invalid}
        if intent=="interview"{return try PlanningPromptPack.make(task:"interview",data:PlanningPromptPack.interviewInput(context))}
        if intent=="consistency"{return try PlanningPromptPack.make(task:"consistency",data:PlanningPromptPack.consistencyInput(context))}
        if intent=="generate"{return try PlanningGeneration.outlinePrompt(context:context)}
        var data:[String:Any]=[:]
        for key in ["locale","currentQuestion","questions","messages","routeDraft","proposal","resources"]{if let value=context[key]{data[key]=value}}
        if let questions=data["questions"] as? [[String:Any]]{data["questions"]=questions.map{$0.filter{["id","status","summary","fields","missing"].contains($0.key)}}}
        if let draft=context["routeDraft"] as? [String:Any],let chapters=draft["chapters"] as? [[String:Any]],let last=(context["messages"] as? [[String:Any]])?.last,last["role"] as? String=="user" {
            var mentions=last["mentions"] as? [[String:Any]] ?? []
            if let target=last["target"] as? [String:Any]{mentions.append(["target":target,"token":"legacy-reference"])}
            guard mentions.count<=32 else{throw PlanningAgentError.invalid}
            var references:[[String:Any]]=[]
            for mention in mentions {
                guard let target=mention["target"] as? [String:Any],let chapterID=target["chapterId"] as? String,let chapter=chapters.first(where:{$0["id"] as? String==chapterID}),let token=mention["token"] as? String else{throw PlanningAgentError.invalid}
                var reference:[String:Any]=["token":token,"chapterId":chapterID,"kind":"chapter","content":chapter]
                if let nodeID=target["nodeId"] as? String{guard let node=(chapter["nodes"] as? [[String:Any]])?.first(where:{$0["id"] as? String==nodeID}) else{throw PlanningAgentError.invalid};reference["nodeId"]=nodeID;reference["kind"]="lesson";reference["chapterTitle"]=chapter["title"];reference["content"]=node}
                references.append(reference)
            }
            if !references.isEmpty{data["references"]=references}
        }
        return try PlanningPromptPack.make(task:"edit",data:data)
    }
}

private final class PlanningAgentJob {
    let id=UUID().uuidString.lowercased(),projectID:String,intent:String
    let lock=NSLock()
    var phase="pending",result:[String:Any]?,errorCode:String?
    private var transports:[PlanningAgentTransport]=[],interrupted=false
    private let started=ProcessInfo.processInfo.systemUptime
    private var stage="preparing",provider="",receivedCharacters=0,finished:TimeInterval?
    private var partialReply="",userReply:String?
    private var lastActivityMs=0,thinkingCharacters=0,outputCharacters=0,activitySequence=0
    private var activityEvents:[[String:Any]]=[]
    private var validationIssues:[[String:String]]=[]
    private var completedChapters:Int?,chapterCount:Int?
    private var generationOutput:[[String:Any]]=[],generationOutputBytes=0,outputOverflow=false
    private var outputCurrent:[Int:String]=[:],outputPrefix:[Int:String]=[:]
    init(projectID:String,intent:String){self.projectID=projectID;self.intent=intent}
    func snapshot()->[String:Any]{
        lock.lock();defer{lock.unlock()}
        var value:[String:Any]=["id":id,"projectId":projectID,"intent":intent,"state":phase=="committing" ? "pending":phase]
        value["diagnostic"]=["traceId":id,"provider":provider,"intent":intent,"stage":stage,"durationMs":Int(((finished ?? ProcessInfo.processInfo.systemUptime)-started)*1000),"receivedCharacters":receivedCharacters,"promptVersion":PlanningPromptPack.version]
        value["activity"]=["durationMs":Int(((finished ?? ProcessInfo.processInfo.systemUptime)-started)*1000),"lastActivityMs":lastActivityMs,"thinkingCharacters":thinkingCharacters,"outputCharacters":outputCharacters,"events":activityEvents]
        if let completedChapters,let chapterCount{var diagnostic=value["diagnostic"] as! [String:Any];diagnostic["completedChapters"]=completedChapters;diagnostic["chapterCount"]=chapterCount;value["diagnostic"]=diagnostic}
        if !validationIssues.isEmpty{var diagnostic=value["diagnostic"] as! [String:Any];diagnostic["validationIssues"]=validationIssues;value["diagnostic"]=diagnostic}
        if phase != "completed",!partialReply.isEmpty{value["partialReply"]=partialReply}
        if let userReply{value["userReply"]=userReply}
        if ["generate","consistency"].contains(intent){value["generationOutput"]=generationOutput}
        if let result{value["result"]=result};if let errorCode{value["errorCode"]=errorCode};return value
    }
    func chapterProgress(completed:Int,count:Int){lock.lock();defer{lock.unlock()};guard phase=="pending" else{return};completedChapters=completed;chapterCount=count}
    func progress(_ stage:String,characters:Int=0,provider:String?=nil){
        lock.lock();defer{lock.unlock()};guard phase=="pending" else{return}
        let now=Int((ProcessInfo.processInfo.systemUptime-started)*1000),changed=self.stage != stage
        self.stage=stage;receivedCharacters=min(1_048_576,receivedCharacters+max(0,characters));if let provider{self.provider=provider}
        if stage=="thinking"{thinkingCharacters=min(16_777_216,thinkingCharacters+max(0,characters))}else{outputCharacters=min(16_777_216,outputCharacters+max(0,characters))}
        if changed || characters>0{lastActivityMs=now}
        if changed || characters>0 && now-(activityEvents.last?["atMs"] as? Int ?? -5000)>=5000 {
            activitySequence+=1;activityEvents.append(["sequence":activitySequence,"stage":stage,"atMs":now,"thinkingCharacters":thinkingCharacters,"outputCharacters":outputCharacters]);if activityEvents.count>60{activityEvents.removeFirst()}
        }
    }
    func preview(_ text:String){lock.lock();defer{lock.unlock()};guard phase=="pending",!text.isEmpty,text.utf16.count<=8000 else{return};partialReply=text}
    func beginOutput(_ kind:String)throws->Int?{
        guard ["generate","consistency"].contains(intent) else{return nil}
        lock.lock();defer{lock.unlock()}
        guard phase=="pending",!interrupted else{throw PlanningAgentError.cancelled}
        guard generationOutput.count<1024,!outputOverflow else{throw PlanningAgentError.tooLarge}
        let sequence=generationOutput.count+1
        generationOutput.append(["sequence":sequence,"kind":kind,"form":"reply","text":"","state":"streaming"])
        return sequence
    }
    func outputPreview(_ sequence:Int?,_ text:String){
        guard let sequence else{return};lock.lock();defer{lock.unlock()}
        guard phase=="pending",generationOutput.indices.contains(sequence-1),!outputOverflow,!text.isEmpty else{return}
        let current=outputCurrent[sequence] ?? "",previous=generationOutput[sequence-1]["text"] as? String ?? ""
        if !current.isEmpty,current.hasPrefix(text){return}
        var prefix=outputPrefix[sequence] ?? ""
        if !current.isEmpty,!text.hasPrefix(current){prefix+=current+"\n\n"}
        let visible=prefix+text,bytes=generationOutputBytes-previous.utf8.count+visible.utf8.count
        guard bytes<=8_388_608 else{outputOverflow=true;return}
        outputCurrent[sequence]=text;outputPrefix[sequence]=prefix;generationOutputBytes=bytes;generationOutput[sequence-1]["text"]=visible
    }
    func finishOutput(_ sequence:Int?,reply:String?=nil,interrupted:Bool=false)throws{
        if let reply,!reply.isEmpty{outputPreview(sequence,reply)}
        lock.lock();defer{lock.unlock()};guard !outputOverflow else{throw PlanningAgentError.tooLarge}
        if let sequence,generationOutput.indices.contains(sequence-1){generationOutput[sequence-1]["state"]=interrupted || phase != "pending" ? "incomplete":"complete"}
    }
    func appendOutput(_ kind:String,text:String)throws{
        guard let sequence=try beginOutput(kind) else{return}
        outputPreview(sequence,text);try finishOutput(sequence)
        lock.lock();defer{lock.unlock()};guard phase=="pending",!interrupted else{throw PlanningAgentError.cancelled};generationOutput[sequence-1]["form"]="content"
    }
    private func interruptOutput(){for index in generationOutput.indices where generationOutput[index]["state"] as? String=="streaming"{generationOutput[index]["state"]="incomplete"}}
    var cancelled:Bool{lock.lock();defer{lock.unlock()};return phase=="cancelled" || interrupted}
    func attach(_ value:PlanningAgentTransport)throws{lock.lock();defer{lock.unlock()};guard phase=="pending",!interrupted else{throw PlanningAgentError.cancelled};transports.append(value)}
    func detach(_ value:PlanningAgentTransport){lock.lock();transports.removeAll{$0===value};lock.unlock()}
    func abortTransports(interrupt:Bool=true){lock.lock();if interrupt{interrupted=true};let active=transports;lock.unlock();for transport in active{transport.cancel()}}
    func cancel()throws{
        lock.lock();if phase=="committing"{lock.unlock();throw PlanningAgentError.busy}
        guard phase=="pending" else{lock.unlock();return};phase="cancelled";interruptOutput();finished=ProcessInfo.processInfo.systemUptime;errorCode=PlanningAgentError.cancelled.rawValue
        let active=transports;lock.unlock();for transport in active{transport.cancel()}
    }
    func claimCommit()throws{lock.lock();defer{lock.unlock()};guard phase=="pending",!interrupted else{throw PlanningAgentError.cancelled};phase="committing";transports=[]}
    func complete(_ value:[String:Any]){lock.lock();defer{lock.unlock()};guard phase=="committing" else{return};result=value;phase="completed";partialReply="";finished=ProcessInfo.processInfo.systemUptime}
    func fail(_ error:Error){
        lock.lock();defer{lock.unlock()};guard phase=="pending" || phase=="committing" else{return}
        phase="failed";interruptOutput();transports=[];finished=ProcessInfo.processInfo.systemUptime
        if let outcome=error as? PlanningTaskOutcome{errorCode=outcome.code;userReply=outcome.userReply;partialReply=""}
        else if let error=error as? PlanningOutputError{errorCode=error.code.rawValue;validationIssues=Array(error.issues.prefix(24))}
        else if (error as NSError).domain=="VibeImprove.PlanningValidation"{errorCode=PlanningAgentError.rejected.rawValue;validationIssues=Array(((error as NSError).userInfo["issues"] as? [[String:String]] ?? []).prefix(24))}
        else if (error as NSError).domain=="VibeImprove.PlanningEvidence"{errorCode="PLANNING_EVIDENCE_INVALID";validationIssues=Array(((error as NSError).userInfo["issues"] as? [[String:String]] ?? []).prefix(24))}
        else if let error=error as? PlanningAgentError{errorCode=error.rawValue}
        else if let error=error as? AgentError{errorCode=error.rawValue}
        else if let error=error as? any RawRepresentable,let code=error.rawValue as? String,Set(["PLANNING_GENERATION_INVALID","PLANNING_GENERATION_STALE","PLANNING_GENERATION_EXISTS","PLANNING_INVALID","PLANNING_TOO_LARGE","PLANNING_CONFLICT","PLANNING_BUSY","PLANNING_INCOMPLETE","PLANNING_EVIDENCE_INVALID","PLANNING_RESPONSE_INVALID","PLANNING_ROUTE_INVALID","PLANNING_TARGET_UNAVAILABLE","PLANNING_LIMIT","PLANNING_STORAGE_UNAVAILABLE","PLANNING_PROJECT_UNAVAILABLE"]).contains(code){errorCode=code}
        else{errorCode=PlanningAgentError.rejected.rawValue}
    }
}

final class PlanningAgentManager {
    private let agents:AgentManager,timeout:TimeInterval?,idleTimeout:TimeInterval,prepare:((String)throws->AgentSessionPreparation)?
    private let lock=NSLock()
    private var jobs:[String:PlanningAgentJob]=[:],order:[String]=[],closed=false
    init(agents:AgentManager,timeout:TimeInterval?=nil,idleTimeout:TimeInterval=180,prepare:((String)throws->AgentSessionPreparation)?=nil){self.agents=agents;self.timeout=timeout.map{max(0.1,min($0,1800))};self.idleTimeout=max(0.1,min(idleTimeout,180));self.prepare=prepare}
    static func requestTimeout(provider:String,intent:String)->TimeInterval{intent=="generate" ? 1800:intent=="edit" ? 600:180}
    func begin(projectID:String,intent:String,context:[String:Any],saveProgress:(([String:Any])throws->Void)?=nil,validateRoute:(([String:Any])throws->Void)?=nil,apply:@escaping([String:Any])throws->[String:Any])throws->[String:Any]{
        guard projectID.range(of:"^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",options:.regularExpression) != nil,context["projectId"] as? String==projectID else{throw PlanningAgentError.invalid}
        let prompt=try PlanningAgentPrompt.make(intent:intent,context:context),job=PlanningAgentJob(projectID:projectID,intent:intent)
        lock.lock();defer{lock.unlock()}
        guard !closed else{throw PlanningAgentError.unavailable}
        guard !jobs.values.contains(where:{$0.projectID==projectID && ["pending","committing"].contains($0.snapshot()["state"] as? String ?? "")}) else{throw PlanningAgentError.busy}
        while order.count>=32,let oldest=order.first {
            guard let previous=jobs[oldest],previous.snapshot()["state"] as? String != "pending" else{throw PlanningAgentError.busy}
            jobs.removeValue(forKey:oldest);order.removeFirst()
        }
        jobs[job.id]=job;order.append(job.id)
        DispatchQueue.global(qos:.userInitiated).async{[self] in
            do{
                guard !job.cancelled else{throw PlanningAgentError.cancelled}
                let restored=try (intent=="generate" ? context["generationDraft"] as? [String:Any]:nil).map{try PlanningGeneration.restore($0,locale:context["locale"] as? String ?? "zh-CN")}
                if let (plan,parts)=restored,parts.enumerated().allSatisfy({($0.element?["nodes"] as? [[String:Any]])?.count==plan.chapters[$0.offset].lessons.count}){
                    try job.appendOutput("outline",text:PlanningGeneration.displayOutline(plan))
                    for (index,part) in parts.enumerated(){if let part{try job.appendOutput("lessons",text:PlanningGeneration.displayChapter(part,plan:plan,index:index,count:plan.chapters[index].lessons.count))}}
                    let route=try plan.completeRoute(parts.compactMap{$0});try validateRoute?(route)
                    job.progress("validating");try job.claimCommit();job.complete(try apply(["reply":plan.reply,"route":route]));return
                }
                let prepared=try prepare?(projectID) ?? agents.prepareSession(projectID:projectID)
                guard prepared.projectID==projectID else{throw PlanningAgentError.invalid}
                guard let launch=prepared.launch else{throw PlanningAgentError.unsupported}
                guard launch.projectID==projectID else{throw PlanningAgentError.invalid}
                guard ["codex","claude-code","codebuddy"].contains(prepared.provider),launch.provider==prepared.provider else{throw PlanningAgentError.unsupported}
                if let provider=context["provider"] as? String,provider != prepared.provider{throw PlanningAgentError.unavailable}
                job.progress("connecting",provider:prepared.provider)
                let budget=timeout ?? Self.requestTimeout(provider:prepared.provider,intent:intent)
                let deadline=Date().addingTimeInterval(budget)
                func request(_ instructions:String,kind:String)throws->[String:Any]{
                    guard !job.cancelled else{throw PlanningAgentError.cancelled}
                    let remaining=deadline.timeIntervalSinceNow
                    guard remaining>0 else{job.progress("total_timeout");throw PlanningAgentError.timeout}
                    let outputSequence=try job.beginOutput(kind)
                    let transport=PlanningAgentTransport(launch:launch,timeout:remaining,idleTimeout:idleTimeout,options:context["agentOptions"] as? [String:Any] ?? [:],intent:kind,progress:{[weak job] stage,count in job?.progress(stage,characters:count)},preview:{[weak job] text in job?.outputPreview(outputSequence,text);if kind != "lessons"{job?.preview(text)}})
                    try job.attach(transport);defer{job.detach(transport)}
                    let result:[String:Any]
                    do{result=try transport.perform(prompt:instructions);try job.finishOutput(outputSequence,reply:result["reply"] as? String)}
                    catch{try? job.finishOutput(outputSequence,interrupted:true);throw error}
                    guard Date()<deadline else{job.progress("total_timeout");throw PlanningAgentError.timeout}
                    return result
                }
                func checked<T>(_ instructions:String,kind:String,check:([String:Any])throws->T)throws->T{
                    var current=instructions
                    for attempt in 0...1 {
                        var response:[String:Any]?
                        do{
                            let value=try request(current,kind:kind);response=value
                            if let assessment=value["consistency"] as? [String:Any] {
                                _ = try PlanningPromptPack.consistencyResult(["status":"ok","reply":value["reply"] ?? NSNull(),"result":assessment,"missing":[]],context:context)
                            }
                            return try check(value)
                        }
                        catch {
                            if error is PlanningTaskOutcome{throw error}
                            let normalized:Error
                            if let pack=error as? PlanningPromptPackError {
                                if pack == .tooLarge{throw PlanningAgentError.tooLarge}
                                normalized=PlanningOutputError(code:pack == .evidence ? .evidence:.rejected,issues:[["path":pack == .evidence ? "result.evidence":"result","code":"invalid"]],repairCandidate:PlanningRepair.candidate(response))
                            }else{normalized=error}
                            let outputError=normalized as? PlanningOutputError
                            let repairable=outputError?.code == .rejected || outputError?.code == .routeEncoding || outputError?.code == .evidence || (normalized as NSError).domain=="VibeImprove.PlanningValidation"
                            let issues=outputError?.issues ?? ((normalized as NSError).userInfo["issues"] as? [[String:String]] ?? [])
                            guard attempt==0,repairable,!job.cancelled,let repaired=PlanningRepair.prompt(instructions,candidate:outputError?.repairCandidate ?? PlanningRepair.candidate(response),issues:issues) else{throw normalized}
                            current=repaired
                        }
                    }
                    throw PlanningAgentError.rejected
                }
                let value:[String:Any]
                if intent=="generate" {
                    do{
                    let plan:PlanningGeneration.Plan
                    if let restored{plan=restored.0}else{plan=try checked(PlanningGeneration.outlinePrompt(context:context),kind:"outline"){try PlanningGeneration.plan($0,locale:context["locale"] as? String ?? "zh-CN")}}
                    try job.appendOutput("outline",text:PlanningGeneration.displayOutline(plan))
                    let queue=OperationQueue(),generationLock=NSLock()
                    queue.maxConcurrentOperationCount=2
                    var chapters=restored?.1 ?? [([String:Any])?](repeating:nil,count:plan.chapters.count),generationError:Error?
                    var finishedCount=chapters.enumerated().filter{($0.element?["nodes"] as? [[String:Any]])?.count==plan.chapters[$0.offset].lessons.count}.count
                    if restored==nil{try saveProgress?(plan.progress(chapters))}
                    for (index,part) in chapters.enumerated(){if let part{try job.appendOutput("lessons",text:PlanningGeneration.displayChapter(part,plan:plan,index:index,count:(part["nodes"] as? [[String:Any]] ?? []).count))}}
                    job.chapterProgress(completed:finishedCount,count:plan.chapters.count)
                    for index in plan.chapters.indices {
                        let savedChapter=chapters[index],savedCount=(savedChapter?["nodes"] as? [[String:Any]] ?? []).count
                        if savedCount==plan.chapters[index].lessons.count{continue}
                        queue.addOperation {
                            generationLock.lock();let stopped=generationError != nil;generationLock.unlock()
                            guard !stopped,!job.cancelled else{return}
                            do {
                                var currentChapter=savedChapter
                                for start in stride(from:savedCount,to:plan.chapters[index].lessons.count,by:3) {
                                    generationLock.lock();let stopBatch=generationError != nil;generationLock.unlock();if stopBatch{break}
                                    let range=start..<min(start+3,plan.chapters[index].lessons.count)
                                    let instructions=try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:index,completed:currentChapter.map{[$0]} ?? [],range:range,plannedPrerequisites:true)
                                    currentChapter=try checked(instructions,kind:"lessons"){response in
                                        var chapter=try PlanningGeneration.chapter(response,plan:plan,index:index,range:range)
                                        chapter["nodes"]=(currentChapter?["nodes"] as? [[String:Any]] ?? [])+(chapter["nodes"] as? [[String:Any]] ?? [])
                                        var fieldsOnly=chapter
                                        fieldsOnly["nodes"]=(chapter["nodes"] as? [[String:Any]] ?? []).map{node in var copy=node;copy["prerequisites"]=[] as [String];return copy}
                                        try validateRoute?(plan.route([fieldsOnly]))
                                        guard try JSONSerialization.data(withJSONObject:chapter).count<=1024*1024 else{throw PlanningAgentError.tooLarge}
                                        return chapter
                                    }
                                    if let currentChapter{
                                        generationLock.lock()
                                        do{
                                            guard !job.cancelled,generationError==nil else{throw PlanningAgentError.cancelled}
                                            var next=chapters;next[index]=currentChapter
                                            try saveProgress?(plan.progress(next));chapters=next
                                            if range.upperBound==plan.chapters[index].lessons.count{finishedCount+=1;job.chapterProgress(completed:finishedCount,count:plan.chapters.count)}
                                            generationLock.unlock()
                                        }catch{generationLock.unlock();throw error}
                                        try job.appendOutput("lessons",text:PlanningGeneration.displayChapter(currentChapter,plan:plan,index:index,count:range.count))
                                    }
                                }
                            }catch{
                                generationLock.lock();if generationError==nil{generationError=error};let business=(generationError as? PlanningTaskOutcome)?.consistency != nil;generationLock.unlock()
                                job.abortTransports(interrupt:!business)
                            }
                        }
                    }
                    queue.waitUntilAllOperationsAreFinished()
                    if let generationError{throw generationError}
                    guard !job.cancelled else{throw PlanningAgentError.cancelled}
                    let route=try plan.completeRoute(chapters.compactMap{$0})
                    guard try JSONSerialization.data(withJSONObject:route).count<=1024*1024 else{throw PlanningAgentError.tooLarge}
                    try validateRoute?(route)
                    value=["reply":plan.reply,"route":route]
                    }catch let outcome as PlanningTaskOutcome{
                        guard let consistency=outcome.consistency,consistency["status"] as? String=="requires_review" else{throw outcome}
                        var blocked=try PlanningPromptPack.consistencyResult(["status":"ok","reply":outcome.userReply,"result":consistency,"missing":[]],context:context)
                        blocked["generationBlocked"]=true;value=blocked
                    }
                }else if intent=="interview" {
                    value=try checked(prompt,kind:"interview"){try PlanningPromptPack.interviewResult($0,context:context)}
                }else if intent=="consistency" {
                    value=try checked(prompt,kind:"consistency"){try PlanningPromptPack.consistencyResult($0,context:context)}
                }else {
                    value=try checked(prompt,kind:"edit"){response in let value=try PlanningPromptPack.unwrap(response,task:"edit");try Self.validate(value,intent:"edit");return value}
                }
                job.progress("validating");try Self.validate(value,intent:intent)
                guard Date()<deadline else{job.progress("total_timeout");throw PlanningAgentError.timeout}
                try job.claimCommit()
                job.complete(try apply(value))
            }catch{job.fail(error)}
        }
        return job.snapshot()
    }
    private func job(projectID:String,jobID:String)throws->PlanningAgentJob{
        lock.lock();defer{lock.unlock()};guard let job=jobs[jobID],job.projectID==projectID else{throw PlanningAgentError.invalid};return job
    }
    func state(projectID:String,jobID:String)throws->[String:Any]{try job(projectID:projectID,jobID:jobID).snapshot()}
    func cancel(projectID:String,jobID:String)throws{try job(projectID:projectID,jobID:jobID).cancel()}
    func shutdown(){lock.lock();closed=true;let active=Array(jobs.values);lock.unlock();for job in active{try? job.cancel()}}
    private var modelCache:[String:(Date,[[String:Any]])]=[:]
    func models(projectID:String,refresh:Bool=false)throws->[String:Any]{
        let prepared=try prepare?(projectID) ?? agents.prepareSession(projectID:projectID)
        guard let launch=prepared.launch else{throw PlanningAgentError.unavailable}
        lock.lock();let cached=modelCache[projectID+prepared.provider];lock.unlock()
        if !refresh,let cached,Date().timeIntervalSince(cached.0)<300{return ["provider":prepared.provider,"models":cached.1]}
        let models=try PlanningAgentTransport(launch:launch,timeout:25).catalog()
        lock.lock();modelCache[projectID+prepared.provider]=(Date(),models);if modelCache.count>64,let oldest=modelCache.min(by:{$0.value.0<$1.value.0})?.key{modelCache.removeValue(forKey:oldest)};lock.unlock()
        return ["provider":prepared.provider,"models":models]
    }
    func validateOptions(projectID:String,options:[String:Any])throws{
        guard Set(options.keys)==["model","effort"],options["model"] is NSNull || options["model"] is String,options["effort"] is NSNull || options["effort"] is String else{throw PlanningAgentError.options}
        if options["model"] is NSNull,options["effort"] is NSNull{return}
        let data=try models(projectID:projectID),models=data["models"] as? [[String:Any]] ?? []
        let selected=(options["model"] as? String).flatMap{key in models.first{$0["id"] as? String==key}} ?? (options["model"] is NSNull ? models.first{$0["isDefault"] as? Bool==true}:nil)
        guard let selected else{throw PlanningAgentError.options}
        if let effort=options["effort"] as? String,!(selected["efforts"] as? [String] ?? []).contains(effort){throw PlanningAgentError.options}
    }
    private static func validate(_ value:[String:Any],intent:String)throws{
        guard let reply=value["reply"] as? String,!reply.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,reply.utf16.count<=8000,reply.utf8.count<=24_000 else{throw PlanningAgentError.protocolFailure}
        if intent=="interview" {
            guard Set(value.keys).isSubset(of:["reply","summary","updates","consistency"]),Set(["reply","updates"]).isSubset(of:Set(value.keys)),let updates=value["updates"] as? [[String:Any]],updates.count<=5 else{throw PlanningAgentError.protocolFailure}
            if let summary=value["summary"]{guard let text=summary as? String,text.count<=2000 else{throw PlanningAgentError.protocolFailure}}
            for update in updates {
                guard let id=update["id"] as? String,["goal","purpose","baseline","time","constraints"].contains(id),
                      update["fields"] is [String:String],update["evidence"] is [[String:Any]],update["missing"] is [String],update["complete"] is Bool else{throw PlanningAgentError.protocolFailure}
            }
        }else if intent=="consistency" || (intent=="generate" && value["generationBlocked"] as? Bool==true) {
            let expected:Set<String>=intent=="consistency" ? ["reply","consistency"]:["reply","consistency","generationBlocked"]
            guard Set(value.keys)==expected,let assessment=value["consistency"] as? [String:Any],["consistent","requires_review"].contains(assessment["status"] as? String ?? ""),assessment["issues"] is [[String:Any]],intent != "generate" || assessment["status"] as? String=="requires_review" else{throw PlanningAgentError.protocolFailure}
        }else if intent=="edit" {
            guard Set(value.keys)==Set(["reply"]) || Set(value.keys)==Set(["reply","route"]) else{throw PlanningAgentError.protocolFailure}
            if let raw=value["route"],!(raw is NSNull){guard let route=raw as? [String:Any],route["format"] as? String=="vibe-improve.route",route["schemaVersion"] as? Int==2,route["chapters"] is [[String:Any]] else{throw PlanningAgentError.protocolFailure}}
        }else{
            guard Set(value.keys)==Set(["reply","route"]),let route=value["route"] as? [String:Any],route["format"] as? String=="vibe-improve.route",route["schemaVersion"] as? Int==2,route["chapters"] is [[String:Any]] else{throw PlanningAgentError.protocolFailure}
        }
    }
}

private final class PlanningAgentTransport {
    private let launch:AgentSessionLaunch,timeout:TimeInterval,options:[String:Any],process=Process(),input=Pipe(),output=Pipe(),errorPipe=Pipe()
    private let condition=NSCondition(),writeLock=NSLock()
    private var queue:[Data]=[],partial=Data(),diagnostic=Data(),byteCount=0,scanOffset=0,readFinished=false,exited=false,cancelled=false,readError:PlanningAgentError?
    private var threadID:String?,turnID:String?,closed=false
    private let progress:(String,Int)->Void
    private let preview:(String)->Void
    private var replyStream=PlanningReplyStream()
    private var idleDeadline:Date?
    private let idleTimeout:TimeInterval,intent:String
    init(launch:AgentSessionLaunch,timeout:TimeInterval,idleTimeout:TimeInterval=180,options:[String:Any]=[:],intent:String="interview",progress:@escaping(String,Int)->Void={_,_ in},preview:@escaping(String)->Void={_ in}){self.launch=launch;self.timeout=timeout;self.idleTimeout=idleTimeout;self.options=options;self.intent=intent;self.progress=progress;self.preview=preview}
    private func replyDelta(_ text:String,reset:Bool=false){if reset{replyStream=PlanningReplyStream()};preview(replyStream.append(text))}
    private func activity(_ stage:String,characters:Int=0){idleDeadline=Date().addingTimeInterval(idleTimeout);progress(stage,characters)}
    func cancel(){condition.lock();cancelled=true;condition.broadcast();condition.unlock();stop()}
    private func stop(){
        writeLock.lock();if !closed{closed=true;try? input.fileHandleForWriting.close()};writeLock.unlock()
        if process.isRunning{process.terminate();DispatchQueue.global().asyncAfter(deadline:.now()+1){[self] in if process.isRunning{kill(process.processIdentifier,SIGKILL)}}}
    }
    private func send(_ value:[String:Any])throws{
        guard let data=try? JSONSerialization.data(withJSONObject:value),data.count<=900*1024 else{throw PlanningAgentError.invalid}
        writeLock.lock();defer{writeLock.unlock()};guard !closed else{throw PlanningAgentError.cancelled}
        do{try input.fileHandleForWriting.write(contentsOf:data+Data([10]))}catch{throw PlanningAgentError.unavailable}
    }
    private func observe(_ bytes:Data,isError:Bool){
        condition.lock();defer{condition.unlock();condition.broadcast()}
        if isError{if diagnostic.count<16_384{diagnostic.append(bytes.prefix(16_384-diagnostic.count))};return}
        byteCount+=bytes.count
        guard byteCount <= 32*1024*1024 else{readError = .tooLarge;return}
        partial.append(bytes)
        while let split=partial.range(of:Data([10]),in:scanOffset..<partial.count){let line=Data(partial[..<split.lowerBound]);partial=Data(partial[split.upperBound...]);scanOffset=0;if !line.isEmpty{queue.append(line)}}
        scanOffset=partial.count
        if partial.count>1024*1024 || queue.count>2048 || queue.reduce(partial.count,{$0+$1.count})>4*1024*1024{readError = .tooLarge}
    }
    private func next(deadline:Date)throws->[String:Any]?{
        condition.lock();defer{condition.unlock()}
        let effectiveDeadline=min(deadline,idleDeadline ?? deadline)
        while queue.isEmpty && !readFinished && !cancelled && readError==nil && Date()<effectiveDeadline{_ = condition.wait(until:min(effectiveDeadline,Date().addingTimeInterval(0.2)))}
        if cancelled{throw PlanningAgentError.cancelled};if let readError{throw readError};if Date()>=effectiveDeadline{progress(idleDeadline==nil ? "handshake_timeout":Date()>=deadline ? "total_timeout":"idle_timeout",0);throw PlanningAgentError.timeout}
        if !queue.isEmpty {
            let line=queue.removeFirst()
            guard let message=try? JSONSerialization.jsonObject(with:line) as? [String:Any] else{throw PlanningAgentError.protocolFailure}
            return message
        }
        if readFinished{throw Self.classify(diagnostic,fallback:.failed)}
        return nil
    }
    private func start(systemPrompt:String?=nil)throws{
        condition.lock();let wasCancelled=cancelled;condition.unlock();guard !wasCancelled else{throw PlanningAgentError.cancelled}
        try launch.configure(process)
        if ["codebuddy","claude-code"].contains(launch.provider){process.arguments=(process.arguments ?? [])+["--include-partial-messages"]}
        if let systemPrompt{guard ["claude-code","codebuddy"].contains(launch.provider) else{throw PlanningAgentError.invalid};process.arguments=(process.arguments ?? [])+["--system-prompt",systemPrompt]}
        if launch.provider != "codex" {
            if let model=options["model"] as? String{process.arguments=(process.arguments ?? [])+["--model",model]}
            if let effort=options["effort"] as? String {
                if launch.provider=="codebuddy",let data=try? JSONSerialization.data(withJSONObject:["effort":effort]),let settings=String(data:data,encoding:.utf8){process.arguments=(process.arguments ?? [])+["--settings",settings]}
                else{process.arguments=(process.arguments ?? [])+["--effort",effort]}
            }
        }
        process.standardInput=input;process.standardOutput=output;process.standardError=errorPipe
        process.terminationHandler={[weak self] _ in guard let self else{return};condition.lock();exited=true;condition.broadcast();condition.unlock()}
        do{try process.run()}catch{throw PlanningAgentError.unavailable}
        for (pipe,isError) in [(output,false),(errorPipe,true)] {
            DispatchQueue.global().async{[self] in
                while true{let data=pipe.fileHandleForReading.availableData;if data.isEmpty{break};observe(data,isError:isError)}
                if !isError{condition.lock();if !partial.isEmpty{queue.append(partial);partial=Data()};readFinished=true;condition.broadcast();condition.unlock()}
            }
        }
    }
    func perform(prompt:String)throws->[String:Any]{
        defer{stop()}
        guard prompt.hasPrefix(PlanningAgentPrompt.policy),let split=prompt.range(of:"\nCONTEXT_JSON_DATA:\n") else{throw PlanningAgentError.invalid}
        let systemPrompt=String(prompt[..<split.lowerBound]),requestPrompt=String(prompt[split.lowerBound...])
        try start(systemPrompt:launch.provider=="codex" ? nil:systemPrompt)
        let deadline=Date().addingTimeInterval(timeout)
        let text=try launch.provider=="codex" ? codex(prompt:requestPrompt,systemPrompt:systemPrompt,deadline:deadline):stream(prompt:requestPrompt,deadline:deadline)
        condition.lock();let stopped=cancelled;condition.unlock();if !stopped,Date()>=deadline{progress("total_timeout",0)};guard !stopped,Date()<deadline else{throw stopped ? PlanningAgentError.cancelled:PlanningAgentError.timeout}
        guard text.utf8.count<=1024*1024 else{throw PlanningAgentError.tooLarge}
        progress("parsing",0)
        var value:[String:Any]
        do{value=try PlanningStrictJSON.object(text)}
        catch PlanningAgentError.tooLarge{throw PlanningAgentError.tooLarge}
        catch{throw PlanningOutputError(code:.routeEncoding,issues:[["path":"result","code":"invalid"]],repairCandidate:text)}
        condition.lock();let cancelledAfterParse=cancelled;condition.unlock()
        if !cancelledAfterParse,Date()>=deadline{progress("total_timeout",0)};guard !cancelledAfterParse,Date()<deadline else{throw cancelledAfterParse ? PlanningAgentError.cancelled:PlanningAgentError.timeout}
        return value
    }
    func catalog()throws->[[String:Any]]{
        defer{stop()};try start();let deadline=Date().addingTimeInterval(timeout)
        let isCodex=launch.provider=="codex"
        if isCodex{try send(["id":0,"method":"initialize","params":["clientInfo":["name":"vibe_improve","version":"0.1.0"]]])}
        else{try send(["type":"control_request","request_id":"model-catalog","request":["subtype":"initialize"]])}
        var raw:[[String:Any]]=[],pages=0,currentModelID:String?
        while true {
            guard let message=try next(deadline:deadline) else{continue}
            if message["error"] != nil{throw Self.classifyJSON(message["error"],fallback:.protocolFailure)}
            if isCodex {
                if message["id"] as? Int==0{try send(["method":"initialized","params":[:]]);try send(["id":1,"method":"model/list","params":["limit":100,"includeHidden":false]])}
                if message["id"] as? Int==1,let result=message["result"] as? [String:Any],let data=result["data"] as? [[String:Any]] {
                    raw.append(contentsOf:data);pages+=1
                    if pages<3,let cursor=result["nextCursor"] as? String,!cursor.isEmpty{try send(["id":1,"method":"model/list","params":["limit":100,"cursor":cursor,"includeHidden":false]])}else{break}
                }
            }else if message["type"] as? String=="control_response",let response=message["response"] as? [String:Any],response["request_id"] as? String=="model-catalog",response["subtype"] as? String=="success",let metadata=response["response"] as? [String:Any]{raw=metadata["models"] as? [[String:Any]] ?? [];currentModelID=metadata["currentModelId"] as? String;break}
        }
        var seen=Set<String>()
        return raw.prefix(300).compactMap{item in
            guard let id=(item["model"] ?? item["value"] ?? item["id"]) as? String,id.range(of:"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$",options:.regularExpression) != nil,seen.insert(id).inserted else{return nil}
            let allowed=Set(["none","minimal","low","medium","high","xhigh","max"])
            let offered=(item["supportedReasoningEfforts"] as? [[String:Any]] ?? []).compactMap{$0["reasoningEffort"] as? String}+(item["supportedEffortLevels"] as? [String] ?? [])
            let efforts=offered.filter{allowed.contains($0)}
            return ["id":id,"name":String(((item["displayName"] as? String) ?? (item["name"] as? String) ?? id).prefix(100)),"isDefault":item["isDefault"] as? Bool ?? (id==currentModelID),"efforts":Array(NSOrderedSet(array:efforts))]
        }
    }
    private func codex(prompt:String,systemPrompt:String,deadline:Date)throws->String{
        try send(["id":0,"method":"initialize","params":["clientInfo":["name":"vibe_improve","title":"Vibe Improve","version":"0.1.0"]]])
        var stage=0,finalText:String?,previewItemID:String?
        while true{
            guard let message=try next(deadline:deadline) else{continue}
            if message["error"] != nil{throw Self.classifyJSON(message["error"],fallback:.protocolFailure)}
            if let method=message["method"] as? String,let requestID=message["id"] {
                try? send(["id":requestID,"error":["code":-32601,"message":"Text-only planner cannot grant permissions or run tools."]])
                throw method=="account/chatgptAuthTokens/refresh" ? PlanningAgentError.auth:PlanningAgentError.permission
            }
            if let id=message["id"] as? Int {
                if id==0 && stage==0 {
                    guard message["result"] is [String:Any] else{throw PlanningAgentError.protocolFailure}
                    try send(["method":"initialized","params":[:]])
                    var parameters=launch.threadStartParameters
                    if let model=options["model"] as? String{parameters["model"]=model}
                    parameters["ephemeral"]=true;parameters["sandbox"]="read-only";parameters["approvalPolicy"]="on-request"
                    parameters["developerInstructions"]=systemPrompt
                    parameters["config"]=["web_search":"disabled","mcp_servers":[:],"features":["shell_tool":false,"unified_exec":false,"apps":false,"computer_use":false,"browser_use":false,"view_image":false,"multi_agent":false,"skill_search":false,"tool_suggest":false,"sleep_tool":false,"workspace_dependencies":false]]
                    try send(["id":1,"method":"thread/start","params":parameters]);stage=1
                }else if id==1 && stage==1 {
                    guard let result=message["result"] as? [String:Any],let thread=result["thread"] as? [String:Any],let id=thread["id"] as? String,!id.isEmpty else{throw PlanningAgentError.protocolFailure}
                    threadID=id;var parameters=launch.turnStartParameters
                    if let model=options["model"] as? String{parameters["model"]=model};if let effort=options["effort"] as? String{parameters["effort"]=effort}
                    parameters["threadId"]=id;parameters["input"]=[["type":"text","text":prompt]]
                    try send(["id":2,"method":"turn/start","params":parameters]);stage=2
                    activity("waiting")
                }else if id==2 && stage==2 {
                    guard let result=message["result"] as? [String:Any],let turn=result["turn"] as? [String:Any],let id=turn["id"] as? String else{throw PlanningAgentError.protocolFailure};turnID=id;stage=3
                }
                continue
            }
            guard let method=message["method"] as? String,let parameters=message["params"] as? [String:Any] else{continue}
            if parameters["threadId"] as? String==threadID,turnID==nil || parameters["turnId"] as? String==turnID,let delta=parameters["delta"] as? String,!delta.isEmpty {
                if method=="item/agentMessage/delta",let itemID=parameters["itemId"] as? String{activity("generating",characters:delta.utf16.count);replyDelta(delta,reset:previewItemID != itemID);previewItemID=itemID}
                if ["item/reasoning/summaryTextDelta","item/reasoning/textDelta"].contains(method){activity("thinking",characters:delta.utf16.count)}
            }
            if method=="item/started" || method=="item/completed",let item=parameters["item"] as? [String:Any],let type=item["type"] as? String,!Set(["userMessage","agentMessage","reasoning","plan","contextCompaction"]).contains(type){throw PlanningAgentError.permission}
            if method=="item/completed",parameters["threadId"] as? String==threadID,let item=parameters["item"] as? [String:Any],item["type"] as? String=="agentMessage",let text=item["text"] as? String{finalText=text;replyDelta(text,reset:true)}
            if method=="error"{throw Self.classifyJSON(parameters,fallback:.failed)}
            if method=="turn/completed" {
                guard stage>=2,parameters["threadId"] as? String==threadID,let turn=parameters["turn"] as? [String:Any],let id=turn["id"] as? String,turnID==nil || turnID==id else{throw PlanningAgentError.protocolFailure}
                guard turn["status"] as? String=="completed" else{throw Self.classifyJSON(turn["error"],fallback:turn["status"] as? String=="interrupted" ? .cancelled:.failed)}
                let items=turn["items"] as? [[String:Any]] ?? []
                guard items.allSatisfy({Set(["userMessage","agentMessage","reasoning","plan","contextCompaction"]).contains($0["type"] as? String ?? "")}),let text=items.last(where:{$0["type"] as? String=="agentMessage"})?["text"] as? String ?? finalText else{throw PlanningAgentError.protocolFailure}
                return text
            }
        }
    }
    private func stream(prompt:String,deadline:Date)throws->String{
        let request="planning-init",handshakeDeadline=min(deadline,Date().addingTimeInterval(25));var initialized=false,assistant=""
        try send(["type":"control_request","request_id":request,"request":["subtype":"initialize"]])
        while true {
            guard let message=try next(deadline:initialized ? deadline:handshakeDeadline) else{continue}
            switch message["type"] as? String {
            case "control_response":
                guard !initialized,let response=message["response"] as? [String:Any],response["request_id"] as? String==request,response["subtype"] as? String=="success" else{throw PlanningAgentError.protocolFailure}
                initialized=true
                try send(["type":"user","message":["role":"user","content":[["type":"text","text":prompt]]],"session_id":"","parent_tool_use_id":NSNull()])
                activity("waiting")
            case "control_request":throw PlanningAgentError.permission
            case "stream_event":
                guard initialized,let event=message["event"] as? [String:Any] else{throw PlanningAgentError.protocolFailure}
                if event["type"] as? String=="content_block_start",let block=event["content_block"] as? [String:Any] {
                    guard ["text","thinking","redacted_thinking"].contains(block["type"] as? String ?? "") else{throw PlanningAgentError.permission}
                    if block["type"] as? String=="text"{replyDelta(block["text"] as? String ?? "",reset:true)}
                }
                if event["type"] as? String=="content_block_delta",let delta=event["delta"] as? [String:Any] {
                    if delta["type"] as? String=="text_delta",let text=delta["text"] as? String,!text.isEmpty{activity("generating",characters:text.utf16.count);replyDelta(text)}
                    if delta["type"] as? String=="thinking_delta",let text=delta["thinking"] as? String,!text.isEmpty{activity("thinking",characters:text.utf16.count)}
                }
            case "assistant":
                guard initialized,let body=message["message"] as? [String:Any],let content=body["content"] as? [[String:Any]],content.allSatisfy({["text","thinking","redacted_thinking"].contains($0["type"] as? String ?? "")}) else{throw PlanningAgentError.permission}
                assistant=content.compactMap{$0["type"] as? String=="text" ? $0["text"] as? String:nil}.joined()
                replyDelta(assistant,reset:true)
                activity("receiving")
            case "result":
                guard initialized else{throw PlanningAgentError.protocolFailure}
                if let reason=message["terminal_reason"] as? String {
                    guard !["aborted_streaming","aborted_tools"].contains(reason) else{throw PlanningAgentError.cancelled}
                    throw PlanningAgentError.protocolFailure
                }
                guard message["subtype"] as? String=="success",message["is_error"] as? Bool != true else{
                    throw Self.classifyJSON(message["errors"] ?? message["result"],fallback:.failed)
                }
                let result=(message["result"] as? String).flatMap{$0.isEmpty ? nil:$0} ?? assistant
                guard !result.isEmpty else{throw PlanningAgentError.protocolFailure}
                progress("finishing",0)
                writeLock.lock();if !closed{closed=true;try? input.fileHandleForWriting.close()};writeLock.unlock()
                let exitDeadline=min(deadline,Date().addingTimeInterval(3))
                while process.isRunning && Date()<exitDeadline{Thread.sleep(forTimeInterval:0.02)}
                guard !process.isRunning,process.terminationStatus==0 else{throw Self.classify(diagnostic,fallback:.failed)}
                return result
            case "error":throw Self.classifyJSON(message,fallback:.failed)
            default:break
            }
        }
    }
    private static func classifyJSON(_ value:Any?,fallback:PlanningAgentError)->PlanningAgentError{
        if let value,JSONSerialization.isValidJSONObject([value]),let data=try? JSONSerialization.data(withJSONObject:[value]){return classify(data,fallback:fallback)};return fallback
    }
    private static func classify(_ data:Data,fallback:PlanningAgentError)->PlanningAgentError {
        let text=String(decoding:data.prefix(65_536),as:UTF8.self).lowercased()
        if ["unauthorized","unauthenticated","not logged in","authentication","invalid_api_key","login required","401"].contains(where:text.contains){return .auth}
        if ["quota","rate limit","rate_limit","ratelimit","usage limit","usagelimit","insufficient_credit","429"].contains(where:text.contains){return .quota}
        if ["unknown model","unsupported model","invalid model","model_not_found","model not found","unsupported effort","unsupported reasoning"].contains(where:text.contains){return .options}
        if ["network","econn","enotfound","dns","connection reset","fetch failed","connection refused","failed to connect"].contains(where:text.contains){return .network}
        if ["permission denied","operation not permitted","sandbox denied"].contains(where:text.contains){return .permission}
        return fallback
    }
}

struct PlanningReplyStream {
    private var bytes:[UInt8]=[],finished=false,text=""
    mutating func append(_ delta:String)->String {
        guard !finished else{return text}
        guard bytes.count+delta.utf8.count<=1024*1024 else{finished=true;bytes=[];text="";return text}
        bytes += delta.utf8
        let value=PlanningStrictJSON.partialReply(bytes)
        text=value.text;finished=value.complete
        if finished{bytes=[]}
        return text
    }
}

enum PlanningStrictJSON {
    static func partialReply(_ bytes:[UInt8])->(text:String,complete:Bool){
        var scanner=Scanner(bytes:bytes);scanner.space()
        guard scanner.index<bytes.count,bytes[scanner.index]==123 else{return ("",false)}
        scanner.index+=1;var keys=Set<String>()
        do {
            while scanner.index<bytes.count {
                scanner.space();let key=try scanner.string()
                guard keys.insert(key).inserted else{return ("",true)}
                scanner.space();guard scanner.index<bytes.count,bytes[scanner.index]==58 else{return ("",false)};scanner.index+=1;scanner.space()
                if key=="reply" {
                    guard scanner.index<bytes.count,bytes[scanner.index]==34 else{return ("",false)}
                    let start=scanner.index;scanner.index+=1
                    while scanner.index<bytes.count {
                        if bytes[scanner.index]==92{scanner.index+=2;continue}
                        if bytes[scanner.index]==34 {
                            let data=Data(bytes[start...scanner.index])
                            guard let text=try? JSONSerialization.jsonObject(with:data,options:.fragmentsAllowed) as? String,text.utf16.count<=8000 else{return ("",true)}
                            return (text,true)
                        }
                        scanner.index+=1
                    }
                    let data=Data(bytes[start...])
                    guard data.count<=64*1024 else{return ("",true)}
                    // Keep incomplete UTF-8, escape sequences and surrogate pairs for the next delta.
                    for trim in 0...min(12,data.count-1) {
                        if let text=try? JSONSerialization.jsonObject(with:Data(data.dropLast(trim))+Data([34]),options:.fragmentsAllowed) as? String,text.utf16.count<=8000{return (text,false)}
                    }
                    return ("",false)
                }
                try scanner.value(depth:1);scanner.space()
                guard scanner.index<bytes.count,bytes[scanner.index]==44 else{return ("",false)};scanner.index+=1
            }
        }catch{}
        return ("",false)
    }
    static func object(_ text:String)throws->[String:Any]{
        let data=Data(text.utf8);guard data.count<=1024*1024 else{throw PlanningAgentError.tooLarge}
        var scanner=Scanner(bytes:Array(data));try scanner.value(depth:0);scanner.space();guard scanner.index==scanner.bytes.count,let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw PlanningAgentError.protocolFailure};return value
    }
    private struct Scanner {
        let bytes:[UInt8];var index=0
        mutating func space(){while index<bytes.count && [9,10,13,32].contains(bytes[index]){index+=1}}
        mutating func string()throws->String {
            guard index<bytes.count,bytes[index]==34 else{throw PlanningAgentError.protocolFailure};let start=index;index+=1
            while index<bytes.count {
                if bytes[index]==92{index+=2;continue}
                if bytes[index]==34{index+=1;guard let value=try? JSONSerialization.jsonObject(with:Data(bytes[start..<index]),options:.fragmentsAllowed) as? String else{throw PlanningAgentError.protocolFailure};return value}
                index+=1
            };throw PlanningAgentError.protocolFailure
        }
        mutating func value(depth:Int)throws {
            guard depth<=48 else{throw PlanningAgentError.protocolFailure};space();guard index<bytes.count else{throw PlanningAgentError.protocolFailure}
            if bytes[index]==123 {
                index+=1;space();var keys=Set<String>();if index<bytes.count && bytes[index]==125{index+=1;return}
                while true{space();let key=try string();guard keys.insert(key).inserted else{throw PlanningAgentError.protocolFailure};space();guard index<bytes.count,bytes[index]==58 else{throw PlanningAgentError.protocolFailure};index+=1;try value(depth:depth+1);space();guard index<bytes.count else{throw PlanningAgentError.protocolFailure};let separator=bytes[index];index+=1;if separator==125{return};guard separator==44 else{throw PlanningAgentError.protocolFailure}}
            }else if bytes[index]==91 {
                index+=1;space();if index<bytes.count && bytes[index]==93{index+=1;return}
                while true{try value(depth:depth+1);space();guard index<bytes.count else{throw PlanningAgentError.protocolFailure};let separator=bytes[index];index+=1;if separator==93{return};guard separator==44 else{throw PlanningAgentError.protocolFailure}}
            }else if bytes[index]==34{_ = try string()}
            else{let start=index;while index<bytes.count && ![9,10,13,32,44,93,125].contains(bytes[index]){index+=1};guard index>start else{throw PlanningAgentError.protocolFailure}}
        }
    }
}
