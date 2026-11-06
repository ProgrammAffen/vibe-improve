import Foundation
import CoreFoundation

enum PlanningGeneration {
    static func displayOutline(_ plan:Plan)->String{
        let en=plan.locale=="en"
        var lines=[plan.title]
        for (index,chapter) in plan.chapters.enumerated(){
            lines += ["", "\(index+1). \(chapter.title)",(en ? "Stage goal: ":"阶段目标：")+chapter.stageGoal]
            for (position,lesson) in chapter.lessons.enumerated(){lines += ["\(index+1).\(position+1) \(lesson.title)",lesson.focus]}
        }
        return lines.joined(separator:"\n")
    }
    static func displayChapter(_ chapter:[String:Any],plan:Plan,index:Int,count:Int)->String{
        let en=plan.locale=="en",all=chapter["nodes"] as? [[String:Any]] ?? [],nodes=all.suffix(count)
        var lines=["\(index+1). \(plan.chapters[index].title)"]
        for (position,node) in nodes.enumerated(){
            lines += ["", "\(index+1).\(all.count-nodes.count+position+1) \(node["title"] as? String ?? "")"]
            if let minutes=node["estimatedMinutes"] as? Int{lines.append(en ? "Estimated time: \(minutes) min":"预计时长：\(minutes) 分钟")}
            lines.append(en ? "Learning objectives":"学习目标")
            lines += (node["objectives"] as? [[String:Any]] ?? []).compactMap{($0["description"] as? String).map{"• "+$0}}
            if let activities=node["activities"] as? [String],!activities.isEmpty{lines.append(en ? "Learning activities":"学习活动");lines += activities.map{"• "+$0}}
            if let assessment=node["assessment"] as? [String:Any]{
                lines.append(en ? "Assessment":"验收标准")
                if let task=assessment["task"] as? String{lines.append(task)}
                lines += (assessment["passCriteria"] as? [String] ?? []).map{"• "+$0}
                if let evaluator=assessment["evaluatorPrompt"] as? String{lines.append((en ? "Evaluation prompt: ":"评判提示词：")+evaluator)}
            }
        }
        return lines.joined(separator:"\n")
    }
    struct Lesson {
        let id:String,ref:String,title:String,focus:String
        var data:[String:Any]{["ref":ref,"title":title,"focus":focus]}
        var prerequisite:[String:Any]{["ref":ref,"title":title]}
    }
    struct Chapter {
        let id:String,title:String,stageGoal:String,lessons:[Lesson]
        var data:[String:Any]{["title":title,"stageGoal":stageGoal,"lessons":lessons.map(\.data)]}
    }
    struct Plan {
        let id:String,reply:String,title:String,locale:String,chapters:[Chapter]
        // Task references never become persistent route identifiers.
        let aliasToNodeID:[String:String]
        var orderedLessons:[Lesson]{chapters.flatMap(\.lessons)}
        var envelope:[String:Any]{["status":"ok","reply":reply,"result":["title":title,"chapters":chapters.map{["title":$0.title,"stageGoal":$0.stageGoal,"lessons":$0.lessons.map{["title":$0.title,"focus":$0.focus]}]}],"missing":[]]}
        func progress(_ chapters:[([String:Any])?])->[String:Any]{["routeId":id,"outline":envelope,"chapters":chapters.map{$0.map{$0 as Any} ?? NSNull()}]}
        func route(_ completed:[[String:Any]])->[String:Any]{
            ["format":"vibe-improve.route","schemaVersion":2,"id":id,"revision":1,"title":title,"locale":locale,"sourceLanguage":locale,"chapters":completed]
        }
        func completeRoute(_ completed:[[String:Any]])throws->[String:Any]{
            guard completed.count==chapters.count else{throw issue("chapters","count")}
            var available=Set<String>()
            for (index,chapter) in chapters.enumerated(){
                let actual=completed[index]
                guard Set(actual.keys)==["id","title","stageGoal","nodes"],actual["id"] as? String==chapter.id,actual["title"] as? String==chapter.title,actual["stageGoal"] as? String==chapter.stageGoal,let nodes=actual["nodes"] as? [[String:Any]],nodes.count==chapter.lessons.count else{throw issue("chapters.\(index)","invalid")}
                for (lessonIndex,node) in nodes.enumerated(){
                    let lesson=chapter.lessons[lessonIndex]
                    try validateNativeNode(node,lesson:lesson,available:available,path:"chapters.\(index).nodes.\(lessonIndex)")
                    available.insert(lesson.id)
                }
            }
            let result=route(completed);try bounded(result);return result
        }
    }

    static func restore(_ draft:[String:Any],locale:String)throws->(Plan,[([String:Any])?]){
        guard draft["schemaVersion"] as? Int==1,draft["policyVersion"] as? String==PlanningPromptPack.version,draft["locale"] as? String==locale,let id=draft["routeId"] as? String,id.range(of:"^route_[a-f0-9-]{36}$",options:.regularExpression) != nil,let envelope=draft["outline"] as? [String:Any],let parts=draft["chapters"] as? [Any] else{throw PlanningAgentError.invalid}
        let original=try plan(envelope,locale:locale),restored=Plan(id:id,reply:original.reply,title:original.title,locale:locale,chapters:original.chapters,aliasToNodeID:original.aliasToNodeID)
        guard parts.count==restored.chapters.count else{throw PlanningAgentError.invalid}
        var result:[([String:Any])?]=[]
        for (index,raw) in parts.enumerated(){
            if raw is NSNull{result.append(nil);continue}
            let expected=restored.chapters[index]
            guard let chapter=raw as? [String:Any],Set(chapter.keys)==["id","title","stageGoal","nodes"],chapter["id"] as? String==expected.id,chapter["title"] as? String==expected.title,chapter["stageGoal"] as? String==expected.stageGoal,let nodes=chapter["nodes"] as? [[String:Any]],!nodes.isEmpty,nodes.count<=expected.lessons.count,nodes.count==expected.lessons.count || nodes.count%3==0 else{throw PlanningAgentError.invalid}
            var available=Set(restored.chapters.prefix(index).flatMap{$0.lessons.map(\.id)})
            for (position,node) in nodes.enumerated(){let lesson=expected.lessons[position];try validateNativeNode(node,lesson:lesson,available:available,path:"chapters.\(index).nodes.\(position)");available.insert(lesson.id)}
            result.append(chapter)
        }
        return (restored,result)
    }

    static func outlinePrompt(context:[String:Any])throws->String{
        try PlanningPromptPack.make(task:"outline",data:promptData(context))
    }
    static func plan(_ envelope:[String:Any],locale:String)throws->Plan{
        guard ["zh-CN","en"].contains(locale) else{throw PlanningAgentError.invalid}
        try bounded(envelope)
        let result=try PlanningPromptPack.unwrap(envelope,task:"outline")
        guard Set(result.keys)==["title","chapters"] else{throw issue("route","invalid")}
        let reply=try text(envelope["reply"],path:"route",limit:8000),title=try text(result["title"],path:"title",limit:160)
        guard reply.utf16.count<=8000,reply.utf8.count<=24_000 else{throw issue("route","invalid")}
        guard let raw=result["chapters"] as? [[String:Any]],(1...24).contains(raw.count) else{throw issue("chapters","count")}
        var chapters:[Chapter]=[],aliases:[String:String]=[:],total=0
        for (index,value) in raw.enumerated(){
            let path="chapters.\(index)"
            guard Set(value.keys)==["title","stageGoal","lessons"] else{throw issue(path,"invalid")}
            let title=try text(value["title"],path:path+".title",limit:160),goal=try text(value["stageGoal"],path:path+".stageGoal",limit:600)
            guard let rawLessons=value["lessons"] as? [[String:Any]],(1...64).contains(rawLessons.count),total+rawLessons.count<=512 else{throw issue(path+".nodes","count")}
            var lessons:[Lesson]=[]
            for (lessonIndex,lesson) in rawLessons.enumerated(){
                let lessonPath=path+".nodes.\(lessonIndex)"
                guard Set(lesson.keys)==["title","focus"] else{throw issue(lessonPath,"invalid")}
                total+=1
                let id="node_\(index+1)_\(lessonIndex+1)",ref="L\(total)"
                lessons.append(Lesson(id:id,ref:ref,title:try text(lesson["title"],path:lessonPath+".title",limit:160),focus:try text(lesson["focus"],path:lessonPath+".objectives",limit:300)))
                aliases[ref]=id
            }
            chapters.append(Chapter(id:"ch_\(index+1)",title:title,stageGoal:goal,lessons:lessons))
        }
        return Plan(id:"route_"+UUID().uuidString.lowercased(),reply:reply,title:title,locale:locale,chapters:chapters,aliasToNodeID:aliases)
    }
    static func chapterPrompt(context:[String:Any],plan:Plan,index:Int,completed:[[String:Any]],range:Range<Int>?=nil,plannedPrerequisites:Bool=false)throws->String{
        let requested=try lessonRange(plan:plan,index:index,range:range),chapter=plan.chapters[index]
        guard completed.count==(plannedPrerequisites ? 0:index)+(requested.lowerBound>0 ? 1:0) else{throw PlanningAgentError.invalid}
        for (position,part) in completed.enumerated(){
            let chapterIndex=plannedPrerequisites ? index:position,expected=plan.chapters[chapterIndex],count=chapterIndex==index ? requested.lowerBound:expected.lessons.count
            guard part["id"] as? String==expected.id,let nodes=part["nodes"] as? [[String:Any]],nodes.count==count else{throw PlanningAgentError.invalid}
            var earlier=Set(plan.chapters.prefix(chapterIndex).flatMap{$0.lessons.map(\.id)})
            for (nodeIndex,node) in nodes.enumerated(){
                let lesson=expected.lessons[nodeIndex]
                try validateNativeNode(node,lesson:lesson,available:earlier,path:"chapters.\(chapterIndex).nodes.\(nodeIndex)")
                earlier.insert(lesson.id)
            }
        }
        var data=try promptData(context)
        guard data["locale"] as? String==plan.locale else{throw PlanningAgentError.invalid}
        let first=chapter.lessons[requested.lowerBound]
        guard let firstIndex=plan.orderedLessons.firstIndex(where:{$0.ref==first.ref}) else{throw PlanningAgentError.invalid}
        data["outline"]=["title":plan.title,"chapters":plan.chapters.map(\.data)]
        data["currentChapter"]=["title":chapter.title,"stageGoal":chapter.stageGoal]
        data["requestedLessons"]=chapter.lessons[requested].map(\.data)
        data["availablePrerequisites"]=plan.orderedLessons.prefix(firstIndex).map(\.prerequisite)
        return try PlanningPromptPack.make(task:"lessons",data:data)
    }
    static func chapter(_ envelope:[String:Any],plan:Plan,index:Int,range:Range<Int>?=nil)throws->[String:Any]{
        let requested=try lessonRange(plan:plan,index:index,range:range),chapter=plan.chapters[index],path="chapters.\(index)"
        try bounded(envelope)
        let result=try PlanningPromptPack.unwrap(envelope,task:"lessons")
        guard Set(result.keys)==["nodes"],let rawNodes=result["nodes"] as? [[String:Any]],rawNodes.count==requested.count else{throw issue(path+".nodes","count")}
        let first=chapter.lessons[requested.lowerBound]
        guard let firstIndex=plan.orderedLessons.firstIndex(where:{$0.ref==first.ref}) else{throw PlanningAgentError.invalid}
        var available=Set(plan.orderedLessons.prefix(firstIndex).map(\.ref)),nativeAvailable=Set(plan.orderedLessons.prefix(firstIndex).map(\.id)),nodes:[[String:Any]]=[]
        for (offset,raw) in rawNodes.enumerated(){
            let lessonIndex=requested.lowerBound+offset,expected=chapter.lessons[lessonIndex],nodePath=path+".nodes.\(lessonIndex)"
            guard Set(raw.keys)==["ref","objectives","prerequisites","estimatedMinutes","activities","assessment"] else{throw issue(nodePath,"invalid")}
            guard raw["ref"] as? String==expected.ref else{throw issue(nodePath+".id","identity")}
            guard let prerequisites=raw["prerequisites"] as? [String],prerequisites.count<=64,Set(prerequisites).count==prerequisites.count,prerequisites.allSatisfy({available.contains($0) && plan.aliasToNodeID[$0] != nil}) else{throw issue(nodePath+".prerequisites","dependencies")}
            let descriptions=try texts(raw["objectives"],path:nodePath+".objectives",count:1...12,limit:2000)
            let objectives=descriptions.enumerated().map{["id":expected.id+"_o\($0.offset+1)","description":$0.element]}
            var node:[String:Any]=["id":expected.id,"title":expected.title,"objectives":objectives,"prerequisites":prerequisites.map{plan.aliasToNodeID[$0]!},"estimatedMinutes":try integer(raw["estimatedMinutes"],path:nodePath+".estimatedMinutes"),"activities":try texts(raw["activities"],path:nodePath+".activities",count:1...24,limit:2000)]
            if !(raw["assessment"] is NSNull){
                guard var assessment=raw["assessment"] as? [String:Any],Set(assessment.keys)==["task","passCriteria","mode","evaluatorPrompt"] else{throw issue(nodePath+".assessment","invalid")}
                assessment["objectiveIds"]=objectives.map{$0["id"]!}
                if assessment["evaluatorPrompt"] is NSNull{assessment.removeValue(forKey:"evaluatorPrompt")}
                node["assessment"]=assessment
            }
            try validateNativeNode(node,lesson:expected,available:nativeAvailable,path:nodePath)
            nodes.append(node);available.insert(expected.ref);nativeAvailable.insert(expected.id)
        }
        return ["id":chapter.id,"title":chapter.title,"stageGoal":chapter.stageGoal,"nodes":nodes]
    }
    private static func lessonRange(plan:Plan,index:Int,range:Range<Int>?)throws->Range<Int>{
        guard plan.chapters.indices.contains(index) else{throw PlanningAgentError.invalid}
        let value=range ?? 0..<plan.chapters[index].lessons.count
        guard !value.isEmpty,value.count<=3,value.lowerBound>=0,value.upperBound<=plan.chapters[index].lessons.count else{throw PlanningAgentError.invalid}
        return value
    }
    private static func promptData(_ context:[String:Any])throws->[String:Any]{
        guard let locale=context["locale"] as? String,["zh-CN","en"].contains(locale),let questions=context["questions"] as? [[String:Any]] else{throw PlanningAgentError.invalid}
        guard questions.count<=5,questions.allSatisfy({["pending","current","needs-detail","awaiting-confirmation","complete","needs-review"].contains($0["status"] as? String ?? "")}) else{throw PlanningAgentError.invalid}
        for question in questions {
            if let raw=question["missing"] {
                guard let missing=raw as? [String],missing.count<=12,missing.allSatisfy({!$0.contains("\0") && !$0.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && $0.utf16.count<=400}),question["status"] as? String != "complete" || missing.isEmpty else{throw PlanningAgentError.invalid}
            }
            if question["status"] as? String=="complete",question["answerProposal"] != nil{throw PlanningAgentError.invalid}
        }
        let confirmed=try PlanningPromptPack.acceptedAnswers(context)
        var data:[String:Any]=["locale":locale,"confirmedBackground":confirmed,"limits":["chapters":24,"lessonsPerChapter":64,"totalLessons":512,"lessonsPerBatch":3]]
        if let resources=context["resources"]{
            guard let value=resources as? String,!value.contains("\0"),value.utf16.count<=4000 else{throw PlanningAgentError.invalid}
            data["resources"]=value
        }
        return data
    }
    private static func validateNativeNode(_ node:[String:Any],lesson:Lesson,available:Set<String>,path:String)throws{
        let required:Set<String>=["id","title","objectives","prerequisites","estimatedMinutes","activities"]
        guard required.isSubset(of:Set(node.keys)),Set(node.keys).isSubset(of:required.union(["assessment"])) else{throw issue(path,"invalid")}
        guard node["id"] as? String==lesson.id,node["title"] as? String==lesson.title else{throw issue(path+".id","identity")}
        guard let objectives=node["objectives"] as? [[String:Any]],(1...12).contains(objectives.count) else{throw issue(path+".objectives","count")}
        var objectiveIDs:[String]=[]
        for (index,objective) in objectives.enumerated(){
            guard Set(objective.keys)==["id","description"],objective["id"] as? String==lesson.id+"_o\(index+1)" else{throw issue(path+".objectives","identity")}
            _ = try text(objective["description"],path:path+".objectives.\(index).description",limit:2000)
            objectiveIDs.append(lesson.id+"_o\(index+1)")
        }
        guard let prerequisites=node["prerequisites"] as? [String],prerequisites.count<=64,Set(prerequisites).count==prerequisites.count,prerequisites.allSatisfy({available.contains($0)}) else{throw issue(path+".prerequisites","dependencies")}
        _ = try integer(node["estimatedMinutes"],path:path+".estimatedMinutes")
        _ = try texts(node["activities"],path:path+".activities",count:1...24,limit:2000)
        if let value=node["assessment"]{
            guard let assessment=value as? [String:Any],Set(assessment.keys).isSubset(of:["task","passCriteria","objectiveIds","mode","evaluatorPrompt"]),Set(["task","passCriteria","objectiveIds","mode"]).isSubset(of:Set(assessment.keys)),let mode=assessment["mode"] as? String,["quantitative","qualitative"].contains(mode),let actual=assessment["objectiveIds"] as? [String],actual==objectiveIDs else{throw issue(path+".assessment","invalid")}
            _ = try text(assessment["task"],path:path+".assessment.task",limit:2000)
            let criteria=try texts(assessment["passCriteria"],path:path+".assessment.passCriteria",count:1...24,limit:2000)
            guard Set(criteria).count==criteria.count else{throw issue(path+".assessment.passCriteria","duplicate")}
            if let prompt=assessment["evaluatorPrompt"]{_ = try text(prompt,path:path+".assessment.evaluatorPrompt",limit:4000)}
            else if mode=="qualitative"{throw issue(path+".assessment.evaluatorPrompt","required")}
        }
    }
    private static func integer(_ value:Any?,path:String)throws->Int{
        guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite,number.doubleValue.rounded(.towardZero)==number.doubleValue,(1...1440).contains(number.doubleValue) else{throw issue(path,"invalid")}
        return number.intValue
    }
    private static func texts(_ value:Any?,path:String,count:ClosedRange<Int>,limit:Int)throws->[String]{
        guard let values=value as? [String],count.contains(values.count) else{throw issue(path,"count")}
        return try values.map{try text($0,path:path,limit:limit)}
    }
    private static func text(_ value:Any?,path:String,limit:Int)throws->String{
        guard let value=value as? String,!value.contains("\0"),!value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,value.unicodeScalars.count<=limit else{throw issue(path,"required")}
        return value
    }
    private static func bounded(_ value:[String:Any])throws{
        guard JSONSerialization.isValidJSONObject(value),let data=try? JSONSerialization.data(withJSONObject:value) else{throw issue("route","invalid")}
        guard data.count<=1_048_576 else{throw PlanningAgentError.tooLarge}
    }
    private static func issue(_ path:String,_ code:String)->PlanningOutputError{PlanningOutputError(code:.rejected,issues:[["path":path,"code":code]])}
}
