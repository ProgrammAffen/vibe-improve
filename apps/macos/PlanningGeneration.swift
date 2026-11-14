import Foundation
import CoreFoundation

enum PlanningGeneration {
    private static let codeIdentifier = #"(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+"#

    static func displayOutline(_ plan:Plan)->String{
        let en=plan.locale=="en"
        var lines=[plan.title]
        for (index,chapter) in plan.chapters.enumerated(){
            lines += ["", "\(index+1). \(chapter.title)",(en ? "Stage goal: ":"阶段目标：")+chapter.stageGoal]
            for (position,lesson) in chapter.lessons.enumerated(){lines.append("\(index+1).\(position+1) \(lesson.title)")}
        }
        return lines.joined(separator:"\n")
    }
    static func displayChapter(_ chapter:[String:Any],plan:Plan,index:Int,count:Int)->String{
        let nodes=chapter["nodes"] as? [[String:Any]] ?? []
        return displayChapter(chapter,plan:plan,index:index,range:max(0,nodes.count-count)..<nodes.count)
    }
    static func displayChapter(_ chapter:[String:Any],plan:Plan,index:Int,range:Range<Int>)->String{
        let en=plan.locale=="en",all=chapter["nodes"] as? [[String:Any]] ?? []
        var lines=["\(index+1). \(plan.chapters[index].title)"]
        for position in range where all.indices.contains(position){
            let node=all[position]
            lines += ["", "\(index+1).\(position+1) \(node["title"] as? String ?? "")"]
            if let minutes=node["estimatedMinutes"] as? Int{lines.append(en ? "Estimated time: \(minutes) min":"预计时长：\(minutes) 分钟")}
            lines.append(en ? "Learning objectives":"学习目标")
            lines += (node["objectives"] as? [[String:Any]] ?? []).compactMap{($0["description"] as? String).map{"• "+$0}}
            if let activities=node["activities"] as? [String],!activities.isEmpty{lines.append(en ? "Learning activities":"学习活动");lines += activities.map{"• "+$0}}
            if let assessment=node["assessment"] as? [String:Any]{
                lines.append(en ? "Assessment":"验收标准")
                if let task=assessment["task"] as? String{lines.append(task)}
                lines += (assessment["passCriteria"] as? [String] ?? []).map{"• "+$0}
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
        let prerequisiteChapters:[Int]?
        func outline(includeRefs:Bool)->[String:Any]{
            let entries=lessons.map{includeRefs ? $0.data : ["title":$0.title,"focus":$0.focus]}
            var value:[String:Any]=["title":title,"stageGoal":stageGoal,"lessons":entries]
            if let prerequisiteChapters{value["prerequisiteChapters"]=prerequisiteChapters.map{$0+1}}
            return value
        }
    }
    struct Plan {
        let id:String,reply:String,title:String,locale:String,chapters:[Chapter]
        // Task references never become persistent route identifiers.
        let aliasToNodeID:[String:String]
        let practiceRules:[String]
        var orderedLessons:[Lesson]{chapters.flatMap(\.lessons)}
        var taskOutline:[String:Any]{outline(chapters.map{$0.outline(includeRefs:true)})}
        var envelope:[String:Any]{
            let savedChapters=chapters.map{$0.outline(includeRefs:false)}
            return ["status":"ok","reply":reply,"result":outline(savedChapters),"missing":[]]
        }
        private func outline(_ chapters:[[String:Any]])->[String:Any]{
            var value:[String:Any]=["title":title,"chapters":chapters]
            if !practiceRules.isEmpty{value["practiceRules"]=practiceRules}
            return value
        }
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

    struct QualityTarget: Equatable {
        let index:Int
        let range:Range<Int>
    }
    struct QualityReview {
        let repairTargets:[QualityTarget]?
        let reason:String?
        let summary:String?
        fileprivate let renameableRefs:Set<String>
        fileprivate let blockers:[[String:Any]]
        var issueKeys:Set<String>{
            Set(blockers.compactMap{issue in
                guard let code=issue["code"] as? String,let refs=issue["targetRefs"] as? [String] else{return nil}
                return ([code]+refs.sorted()).joined(separator:"/")
            })
        }

        func renameableRefs(in target:QualityTarget,plan:Plan)->Set<String>{
            renameableRefs.intersection(plan.chapters[target.index].lessons[target.range].map(\.ref))
        }
    }

    static func reviewPrompt(context:[String:Any],plan:Plan,chapters:[[String:Any]],previousReview:QualityReview?=nil)throws->String{
        var data=try promptData(context)
        guard data["locale"] as? String==plan.locale else{throw PlanningAgentError.invalid}
        data["outline"]=plan.taskOutline
        data["knownRefs"]=plan.chapters.indices.map{chapterRef($0)}+plan.orderedLessons.map(\.ref)
        data["candidate"]=["title":plan.title,"chapters":try reviewChapters(plan:plan,chapters:chapters)]
        if let previousReview{data["previousBlockingIssues"]=previousReview.blockers}
        return try PlanningPromptPack.make(task:"review",data:data)
    }

    static func review(_ envelope:[String:Any],plan:Plan,chapters:[[String:Any]]?=nil)throws->QualityReview{
        var normalized=envelope
        if var result=envelope["result"] as? [String:Any],let rawSummary=result["summary"]{
            result["summary"]=learnerSummary(rawSummary)
            normalized["result"]=result
        }
        let result=try PlanningPromptPack.unwrap(normalized,task:"review")
        guard let ready=result["ready"] as? Bool,let issues=result["issues"] as? [[String:Any]] else{throw issue("result","invalid")}
        let chapterRefs=Dictionary(uniqueKeysWithValues:plan.chapters.indices.map{(chapterRef($0),$0)})
        let lessonRefs=Set(plan.aliasToNodeID.keys)
        var blockers:[[String:Any]]=[],selected=Set<String>(),renameable=Set<String>(),unscoped=false
        for (index,reviewIssue) in issues.enumerated(){
            let path="result.issues.\(index)"
            guard let refs=reviewIssue["targetRefs"] as? [String],Set(refs).count==refs.count,
                  refs.allSatisfy({chapterRefs[$0] != nil || lessonRefs.contains($0)}),
                  let blocking=reviewIssue["blocking"] as? Bool,let code=reviewIssue["code"] as? String else{throw issue(path+".targetRefs","identity")}
            _ = try text(reviewIssue["message"],path:path+".message",limit:2000)
            _ = try text(reviewIssue["fixHint"],path:path+".fixHint",limit:2000)
            if blocking{
                blockers.append(reviewIssue)
                if refs.isEmpty{unscoped=true}
                for ref in refs{
                    if let index=chapterRefs[ref]{selected.formUnion(plan.chapters[index].lessons.map(\.ref))}
                    else{
                        selected.insert(ref)
                        if code=="learning_language"{renameable.insert(ref)}
                    }
                }
            }
        }
        guard ready==blockers.isEmpty else{throw issue("result.ready","invalid")}
        let modelReason=blockers.first?["code"] as? String
        if let chapters{
            if hasCodeIdentifier(plan.title) || plan.chapters.contains(where:{hasCodeIdentifier($0.title)||hasCodeIdentifier($0.stageGoal)}){
                unscoped=true
                if blockers.count<24{blockers.append(learningWordingIssue(ref:nil,message:"The route or chapter heading uses an implementation identifier."))}
            }
            for (index,chapter) in plan.chapters.enumerated(){
                let nodes=chapters[index]["nodes"] as! [[String:Any]]
                for (lesson,node) in zip(chapter.lessons,nodes){
                    let titleNeedsChange=hasCodeIdentifier(lesson.title)
                    let goals=(node["objectives"] as! [[String:String]]).compactMap{$0["description"]}
                    guard titleNeedsChange || goals.contains(where:hasCodeIdentifier) else{continue}
                    selected.insert(lesson.ref)
                    if titleNeedsChange{renameable.insert(lesson.ref)}
                    let alreadyReported=blockers.contains{issue in issue["code"] as? String=="learning_language" && (issue["targetRefs"] as? [String])?.contains(lesson.ref)==true}
                    if alreadyReported{continue}
                    if blockers.count<24{
                        blockers.append(learningWordingIssue(ref:lesson.ref,message:"The lesson title or learning goal uses an implementation identifier."))
                    }else{unscoped=true}
                }
            }
        }
        var targets:[QualityTarget]?=nil
        if !unscoped,selected.count<=12{
            var batches:[QualityTarget]=[]
            for (index,chapter) in plan.chapters.enumerated(){
                for (offset,lesson) in chapter.lessons.enumerated() where selected.contains(lesson.ref){
                    if let last=batches.last,last.index==index,last.range.upperBound==offset,last.range.count<3{
                        batches[batches.count-1]=QualityTarget(index:index,range:last.range.lowerBound..<(offset+1))
                    }else{batches.append(QualityTarget(index:index,range:offset..<(offset+1)))}
                }
            }
            if batches.count<=6{targets=batches}
        }
        let reason=blockers.first?["code"] as? String
        return QualityReview(repairTargets:targets,reason:reason,summary:modelReason==nil ? nil : result["summary"] as? String,renameableRefs:renameable,blockers:blockers)
    }

    private static func learningWordingIssue(ref:String?,message:String)->[String:Any]{
        ["code":"learning_language","targetRefs":ref.map{[$0]} ?? [],"message":message,
         "fixHint":"Describe the reusable skill in the title and goal. Keep concrete identifiers in the activities that use them.","blocking":true]
    }

    private static func learnerSummary(_ raw:Any?)->String?{
        guard let value=raw as? String else{return nil}
        let summary=value.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !summary.isEmpty,summary.unicodeScalars.count<=160,
              summary.rangeOfCharacter(from:.controlCharacters.union(.newlines))==nil,
              summary.range(of:#"[\x60_*=\[\]{}<>\\]|\b[LC][0-9]+\b|\b[A-Z]{2,}-[0-9]+\b"#,options:.regularExpression)==nil else{return nil}
        return summary
    }

    static func revisionPrompt(context:[String:Any],plan:Plan,chapters:[[String:Any]],target:QualityTarget,review:QualityReview)throws->String{
        guard review.repairTargets?.contains(target)==true else{throw issue("result.issues","identity")}
        var data=try chapterPromptData(context:context,plan:plan,index:target.index,range:target.range)
        let candidate=try reviewChapters(plan:plan,chapters:chapters)
        let current=candidate[target.index]["lessons"] as! [[String:Any]]
        let refs=Set(plan.chapters[target.index].lessons[target.range].map(\.ref)+[chapterRef(target.index)])
        let blocking=review.blockers.filter{issue in
            (issue["targetRefs"] as? [String])?.contains(where:refs.contains)==true
        }
        var revision:[String:Any]=[
            "requestedCandidate":Array(current[target.range]),
            "blockingIssues":blocking,
            "routeCandidate":candidate
        ]
        let renameable=review.renameableRefs(in:target,plan:plan)
        if !renameable.isEmpty{revision["renameableLessonRefs"]=plan.chapters[target.index].lessons[target.range].map(\.ref).filter{renameable.contains($0)}}
        data["qualityRevision"]=revision
        do{return try PlanningPromptPack.make(task:"lessons",data:data)}
        catch PlanningPromptPackError.tooLarge{
            // Keep exact bodies for every involved lesson in the bounded fallback.
            let related=Set(blocking.flatMap{($0["targetRefs"] as? [String]) ?? []})
            revision.removeValue(forKey:"routeCandidate")
            revision["relatedCandidate"]=candidate.flatMap{chapter->[[String:Any]] in
                let lessons=chapter["lessons"] as! [[String:Any]]
                if let ref=chapter["ref"] as? String,related.contains(ref){return lessons}
                return lessons.filter{lesson in (lesson["ref"] as? String).map(related.contains)==true}
            }
            data["qualityRevision"]=revision
            return try PlanningPromptPack.make(task:"lessons",data:data)
        }
    }

    static func replacingLessonTitles(in plan:Plan,at target:QualityTarget,with nodes:[[String:Any]])->Plan{
        let chapter=plan.chapters[target.index]
        var lessons=chapter.lessons
        for offset in target.range{
            let lesson=lessons[offset]
            let title=nodes[offset]["title"] as! String
            if title != lesson.title{lessons[offset]=Lesson(id:lesson.id,ref:lesson.ref,title:title,focus:lesson.focus)}
        }
        var chapters=plan.chapters
        chapters[target.index]=Chapter(id:chapter.id,title:chapter.title,stageGoal:chapter.stageGoal,lessons:lessons,prerequisiteChapters:chapter.prerequisiteChapters)
        return Plan(id:plan.id,reply:plan.reply,title:plan.title,locale:plan.locale,chapters:chapters,aliasToNodeID:plan.aliasToNodeID,practiceRules:plan.practiceRules)
    }

    private static func chapterRef(_ index:Int)->String{"C\(index+1)"}

    private static func reviewChapters(plan:Plan,chapters:[[String:Any]])throws->[[String:Any]]{
        _ = try plan.completeRoute(chapters)
        let nodeRefs=Dictionary(uniqueKeysWithValues:plan.orderedLessons.map{($0.id,$0.ref)})
        return plan.chapters.enumerated().map{index,chapter in
            let nodes=chapters[index]["nodes"] as! [[String:Any]]
            let lessons=zip(chapter.lessons,nodes).map{lesson,node -> [String:Any] in
                var value=lesson.prerequisite
                value["objectives"]=(node["objectives"] as! [[String:Any]]).map{$0["description"]!}
                value["prerequisites"]=(node["prerequisites"] as! [String]).compactMap{nodeRefs[$0]}
                value["estimatedMinutes"]=node["estimatedMinutes"]
                value["activities"]=node["activities"]
                value["assessment"]=(node["assessment"] as? [String:Any]).map{$0.filter{$0.key != "objectiveIds"}} as Any? ?? NSNull()
                return value
            }
            return ["ref":chapterRef(index),"title":chapter.title,"stageGoal":chapter.stageGoal,"lessons":lessons]
        }
    }

    static func restore(_ draft:[String:Any],locale:String)throws->(Plan,[([String:Any])?]){
        guard draft["schemaVersion"] as? Int==1,draft["policyVersion"] as? String==PlanningPromptPack.generationCheckpointVersion,draft["locale"] as? String==locale,let id=draft["routeId"] as? String,id.range(of:"^route_[a-f0-9-]{36}$",options:.regularExpression) != nil,let envelope=draft["outline"] as? [String:Any],let parts=draft["chapters"] as? [Any] else{throw PlanningAgentError.invalid}
        let original=try plan(envelope,locale:locale,learnerTitles:false),restored=Plan(id:id,reply:original.reply,title:original.title,locale:locale,chapters:original.chapters,aliasToNodeID:original.aliasToNodeID,practiceRules:original.practiceRules)
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
    static func plan(_ envelope:[String:Any],locale:String,learnerTitles:Bool=true)throws->Plan{
        guard ["zh-CN","en"].contains(locale) else{throw PlanningAgentError.invalid}
        try bounded(envelope)
        let result=try PlanningPromptPack.unwrap(envelope,task:"outline")
        let reply=try text(envelope["reply"],path:"route",limit:8000),title=try text(result["title"],path:"title",limit:160)
        let practiceRules=try result["practiceRules"].map{try texts($0,path:"result.practiceRules",count:1...8,limit:400)} ?? []
        var wordingPaths:[String]=[]
        if learnerTitles,hasCodeIdentifier(title){wordingPaths.append("result.title")}
        guard reply.utf16.count<=8000,reply.utf8.count<=24_000 else{throw issue("route","invalid")}
        guard let raw=result["chapters"] as? [[String:Any]],(1...24).contains(raw.count) else{throw issue("chapters","count")}
        var chapters:[Chapter]=[],aliases:[String:String]=[:],total=0
        for (index,value) in raw.enumerated(){
            let path="chapters.\(index)"
            let prerequisiteChapters=try (value["prerequisiteChapters"] as? [Int]).map{positions in
                guard positions.allSatisfy({$0>0 && $0<=index}) else{throw issue("result."+path+".prerequisiteChapters","dependencies")}
                return positions.map{$0-1}
            }
            let title=try text(value["title"],path:path+".title",limit:160),goal=try text(value["stageGoal"],path:path+".stageGoal",limit:600)
            if learnerTitles,hasCodeIdentifier(title){wordingPaths.append("result."+path+".title")}
            if learnerTitles,hasCodeIdentifier(goal){wordingPaths.append("result."+path+".stageGoal")}
            guard let rawLessons=value["lessons"] as? [[String:Any]],(1...64).contains(rawLessons.count),total+rawLessons.count<=512 else{throw issue(path+".nodes","count")}
            var lessons:[Lesson]=[]
            for (lessonIndex,lesson) in rawLessons.enumerated(){
                let lessonPath=path+".nodes.\(lessonIndex)"
                guard Set(lesson.keys)==["title","focus"] else{throw issue(lessonPath,"invalid")}
                total+=1
                let id="node_\(index+1)_\(lessonIndex+1)",ref="L\(total)"
                let lessonTitle=try text(lesson["title"],path:lessonPath+".title",limit:160)
                if learnerTitles,hasCodeIdentifier(lessonTitle){wordingPaths.append("result."+path+".lessons.\(lessonIndex).title")}
                lessons.append(Lesson(id:id,ref:ref,title:lessonTitle,focus:try text(lesson["focus"],path:lessonPath+".objectives",limit:300)))
                aliases[ref]=id
            }
            chapters.append(Chapter(id:"ch_\(index+1)",title:title,stageGoal:goal,lessons:lessons,prerequisiteChapters:prerequisiteChapters))
        }
        guard wordingPaths.isEmpty else{throw PlanningLearningLanguageError(paths:wordingPaths)}
        return Plan(id:"route_"+UUID().uuidString.lowercased(),reply:reply,title:title,locale:locale,chapters:chapters,aliasToNodeID:aliases,practiceRules:practiceRules)
    }
    static func chapterPrompt(context:[String:Any],plan:Plan,index:Int,completed:[[String:Any]],range:Range<Int>?=nil,plannedPrerequisites:Bool=false,earlierChapters:[[String:Any]] = [])throws->String{
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
        let first=chapter.lessons[requested.lowerBound]
        guard let firstIndex=plan.orderedLessons.firstIndex(where:{$0.ref==first.ref}) else{throw PlanningAgentError.invalid}
        var data=try chapterPromptData(context:context,plan:plan,index:index,range:requested)
        let requiredChapterIDs=Set((chapter.prerequisiteChapters ?? []).map{plan.chapters[$0].id})
        let priority=completed + earlierChapters.filter{requiredChapterIDs.contains($0["id"] as? String ?? "")}
        let previous=priorPractice(chapters:earlierChapters+completed,priority:priority,available:plan.orderedLessons.prefix(firstIndex))
        if !previous.isEmpty{
            data["priorPractice"]=previous
            do{return try PlanningPromptPack.make(task:"lessons",data:data)}
            catch PlanningPromptPackError.tooLarge{data.removeValue(forKey:"priorPractice")}
        }
        return try PlanningPromptPack.make(task:"lessons",data:data)
    }
    private static func chapterPromptData(context:[String:Any],plan:Plan,index:Int,range:Range<Int>)throws->[String:Any]{
        let requested=try lessonRange(plan:plan,index:index,range:range),chapter=plan.chapters[index]
        var data=try promptData(context)
        guard data["locale"] as? String==plan.locale,
              let firstIndex=plan.orderedLessons.firstIndex(where:{$0.ref==chapter.lessons[requested.lowerBound].ref}) else{throw PlanningAgentError.invalid}
        data["outline"]=plan.taskOutline
        data["currentChapter"]=["title":chapter.title,"stageGoal":chapter.stageGoal]
        data["requestedLessons"]=chapter.lessons[requested].map(\.data)
        data["availablePrerequisites"]=plan.orderedLessons.prefix(firstIndex).map(\.prerequisite)
        return data
    }
    private static func priorPractice(chapters:[[String:Any]],priority:[[String:Any]],available:ArraySlice<Lesson>)->[[String:Any]]{
        let lessons=Dictionary(uniqueKeysWithValues:available.map{($0.id,$0)})
        var selected:[[String:Any]]=[],seen=Set<String>(),remaining=24*1024-2
        for chapter in Array(priority.reversed())+chapters.reversed(){
            for node in (chapter["nodes"] as? [[String:Any]] ?? []).reversed(){
                guard let id=node["id"] as? String,let lesson=lessons[id],seen.insert(id).inserted,
                      let activities=node["activities"] as? [String] else{continue}
                var entry=lesson.prerequisite
                entry["activities"]=activities
                if let assessment=node["assessment"] as? [String:Any]{
                    entry["task"]=assessment["task"]
                    entry["passCriteria"]=assessment["passCriteria"]
                }
                guard let bytes=try? JSONSerialization.data(withJSONObject:entry).count,bytes+1<=remaining else{continue}
                remaining-=bytes+1;selected.append(entry)
            }
        }
        let order=Dictionary(uniqueKeysWithValues:available.enumerated().map{($0.element.ref,$0.offset)})
        return selected.sorted{order[$0["ref"] as! String]! < order[$1["ref"] as! String]!}
    }
    static func chapter(_ envelope:[String:Any],plan:Plan,index:Int,range:Range<Int>?=nil,renameableRefs:Set<String>=[],revising:Bool=false)throws->[String:Any]{
        let requested=try lessonRange(plan:plan,index:index,range:range),chapter=plan.chapters[index],path="chapters.\(index)"
        try bounded(envelope)
        let result=try PlanningPromptPack.unwrap(envelope,task:"lessons")
        guard Set(result.keys)==["nodes"],let rawNodes=result["nodes"] as? [[String:Any]],rawNodes.count==requested.count else{throw issue(path+".nodes","count")}
        let first=chapter.lessons[requested.lowerBound]
        guard let firstIndex=plan.orderedLessons.firstIndex(where:{$0.ref==first.ref}) else{throw PlanningAgentError.invalid}
        var available=Set(plan.orderedLessons.prefix(firstIndex).map(\.ref)),nativeAvailable=Set(plan.orderedLessons.prefix(firstIndex).map(\.id)),nodes:[[String:Any]]=[]
        var wordingPaths:[String]=[]
        for (offset,raw) in rawNodes.enumerated(){
            let lessonIndex=requested.lowerBound+offset,expected=chapter.lessons[lessonIndex],nodePath=path+".nodes.\(lessonIndex)"
            let fields:Set<String>=["ref","objectives","prerequisites","estimatedMinutes","activities","assessment"]
            guard fields.isSubset(of:Set(raw.keys)),Set(raw.keys).isSubset(of:fields.union(["title"])) else{throw issue(nodePath,"invalid")}
            guard raw["ref"] as? String==expected.ref else{throw issue(nodePath+".id","identity")}
            var lesson=expected
            if let title=raw["title"]{
                guard renameableRefs.contains(expected.ref) else{throw issue(nodePath+".title","identity")}
                let renamed=try text(title,path:nodePath+".title",limit:160)
                if hasCodeIdentifier(renamed){wordingPaths.append("result.nodes.\(offset).title")}
                lesson=Lesson(id:expected.id,ref:expected.ref,title:renamed,focus:expected.focus)
            }
            guard let prerequisites=raw["prerequisites"] as? [String],prerequisites.count<=64,Set(prerequisites).count==prerequisites.count,prerequisites.allSatisfy({available.contains($0) && plan.aliasToNodeID[$0] != nil}) else{throw issue(nodePath+".prerequisites","dependencies")}
            let descriptions=try texts(raw["objectives"],path:nodePath+".objectives",count:1...12,limit:2000)
            if revising{
                for (goal,description) in descriptions.enumerated() where hasCodeIdentifier(description){
                    wordingPaths.append("result.nodes.\(offset).objectives.\(goal)")
                }
            }
            let objectives=descriptions.enumerated().map{["id":expected.id+"_o\($0.offset+1)","description":$0.element]}
            var node:[String:Any]=["id":expected.id,"title":lesson.title,"objectives":objectives,"prerequisites":prerequisites.map{plan.aliasToNodeID[$0]!},"estimatedMinutes":try integer(raw["estimatedMinutes"],path:nodePath+".estimatedMinutes"),"activities":try texts(raw["activities"],path:nodePath+".activities",count:1...24,limit:2000)]
            if !(raw["assessment"] is NSNull){
                guard var assessment=raw["assessment"] as? [String:Any],Set(assessment.keys)==["task","passCriteria","mode","evaluatorPrompt"] else{throw issue(nodePath+".assessment","invalid")}
                assessment["objectiveIds"]=objectives.map{$0["id"]!}
                if assessment["evaluatorPrompt"] is NSNull{assessment.removeValue(forKey:"evaluatorPrompt")}
                node["assessment"]=assessment
            }
            try validateNativeNode(node,lesson:lesson,available:nativeAvailable,path:nodePath)
            nodes.append(node);available.insert(expected.ref);nativeAvailable.insert(expected.id)
        }
        guard wordingPaths.isEmpty else{throw PlanningLearningLanguageError(paths:wordingPaths)}
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
        guard questions.count<=7,questions.allSatisfy({["pending","current","needs-detail","awaiting-confirmation","complete","needs-review"].contains($0["status"] as? String ?? "")}) else{throw PlanningAgentError.invalid}
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
    private static func hasCodeIdentifier(_ value:String)->Bool{
        value.range(of:codeIdentifier,options:.regularExpression) != nil
    }
    private static func bounded(_ value:[String:Any])throws{
        guard JSONSerialization.isValidJSONObject(value),let data=try? JSONSerialization.data(withJSONObject:value) else{throw issue("route","invalid")}
        guard data.count<=1_048_576 else{throw PlanningAgentError.tooLarge}
    }
    private static func issue(_ path:String,_ code:String)->PlanningOutputError{PlanningOutputError(code:.rejected,issues:[["path":path,"code":code]])}
}
