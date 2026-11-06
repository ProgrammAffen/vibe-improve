import Foundation
import CoreFoundation

enum PlanningPromptPackError:String,Error,CustomStringConvertible,CustomDebugStringConvertible {
    case invalid="PLANNING_RESPONSE_INVALID", evidence="PLANNING_EVIDENCE_INVALID", tooLarge="PLANNING_AGENT_OUTPUT_TOO_LARGE"
    var description:String{rawValue}
    var debugDescription:String{rawValue}
}

// Business outcomes are separate from malformed output and transport failures.
// Logging this error prints only the fixed code, never model text or identifiers.
struct PlanningTaskOutcome:Error,CustomStringConvertible,CustomDebugStringConvertible {
    let code:String,userReply:String,missing:[String]
    let consistency:[String:Any]?
    init(code:String,userReply:String,missing:[String],consistency:[String:Any]?=nil){self.code=code;self.userReply=userReply;self.missing=missing;self.consistency=consistency}
    var description:String{code}
    var debugDescription:String{code}
}

enum PlanningPromptPack {
    private static let fieldsByQuestion:[String:Set<String>]=[
        "goal":["topic","outcome"],"purpose":["context","criteria","aids"],
        "baseline":["experience","support","strategy"],"time":["weekly","session","schedule","deadline","deadlineType"],
        "constraints":["scope","conditions","strategy"]
    ]
    private static let systems=decode(taskSystemsJSON) as? [String:String] ?? [:]
    private static let repairSystems=decode(taskRepairSystemsJSON) as? [String:String] ?? [:]
    private static let schemas=decode(taskSchemasJSON) as? [String:[String:Any]] ?? [:]

    static func make(task:String,data:[String:Any],repair:Bool=false)throws->String {
        guard let instructions=(repair ? repairSystems:systems)[task],let locale=data["locale"] as? String,["zh-CN","en"].contains(locale) else{throw PlanningPromptPackError.invalid}
        let serialized=try bounded(data,maximum:768*1024)
        return instructions+"\nCONTEXT_JSON_DATA:\n"+String(decoding:serialized,as:UTF8.self)
    }

    static func unwrap(_ response:[String:Any],task:String)throws->[String:Any] {
        _ = try bounded(response,maximum:1024*1024)
        guard let reply=response["reply"] as? String,reply.utf16.count<=8000,reply.utf8.count<=24_000,
              let schema=schemas[task],matches(response,schema,root:schema) else{throw PlanningPromptPackError.invalid}
        if task=="edit"{return response}
        guard let status=response["status"] as? String,let missing=response["missing"] as? [String] else{throw PlanningPromptPackError.invalid}
        if status != "ok"{
            throw PlanningTaskOutcome(code:status=="needs_input" ? "PLANNING_NEEDS_INPUT":"PLANNING_CANNOT_COMPLETE",userReply:reply,missing:missing,consistency:response["consistency"] as? [String:Any])
        }
        guard let result=response["result"] as? [String:Any] else{throw PlanningPromptPackError.invalid}
        if task=="outline",let chapters=result["chapters"] as? [[String:Any]],chapters.reduce(0,{$0+(($1["lessons"] as? [Any])?.count ?? 0)})>512{throw PlanningPromptPackError.invalid}
        if task=="review",result["ready"] as? Bool==true,(result["issues"] as? [[String:Any]] ?? []).contains(where:{$0["blocking"] as? Bool==true}){throw PlanningPromptPackError.invalid}
        return result
    }

    static func interviewInput(_ context:[String:Any])throws->[String:Any] {
        try interviewContext(context).input
    }

    static func acceptedAnswers(_ context:[String:Any])throws->[String:Any] {
        guard let questions=context["questions"] as? [[String:Any]],questions.count<=5 else{throw PlanningPromptPackError.invalid}
        var result:[String:Any]=[:],seen=Set<String>()
        for question in questions {
            guard let id=question["id"] as? String,let allowed=fieldsByQuestion[id],seen.insert(id).inserted,
                  let status=question["status"] as? String,["pending","current","needs-detail","awaiting-confirmation","complete","needs-review"].contains(status) else{throw PlanningPromptPackError.invalid}
            let source:[String:Any],acceptedRevision:Int
            if let raw=question["acceptedSnapshot"] {
                guard let snapshot=raw as? [String:Any],let revision=snapshot["revision"],let number=integer(revision),number>=0 else{throw PlanningPromptPackError.invalid};source=snapshot;acceptedRevision=number
            }else if question["status"] as? String=="complete"{source=question;acceptedRevision=0}else{continue}
            guard let summary=source["summary"] as? String,text(summary,maximum:2000,empty:acceptedRevision==0),let fields=source["fields"] as? [String:String],!fields.isEmpty,fields.keys.allSatisfy({allowed.contains($0)}),fields.values.allSatisfy({text($0,maximum:2000)}) else{throw PlanningPromptPackError.invalid}
            result[id]=["summary":summary,"fields":fields]
        }
        return result
    }

    static func consistencyInput(_ context:[String:Any])throws->[String:Any] {
        guard let locale=context["locale"] as? String,["zh-CN","en"].contains(locale) else{throw PlanningPromptPackError.invalid}
        let answers=try acceptedAnswers(context)
        var input:[String:Any]=["locale":locale,"acceptedAnswers":answers]
        if let raw=context["resources"]{guard let resources=raw as? String,text(resources,maximum:4000,empty:true) else{throw PlanningPromptPackError.invalid};input["resources"]=resources}
        if let consistency=context["consistency"] as? [String:Any],let anchor=consistency["anchorQuestionId"] as? String {
            guard answers[anchor] != nil else{throw PlanningPromptPackError.invalid};input["anchorQuestionId"]=anchor
        }
        return input
    }

    static func consistencyResult(_ envelope:[String:Any],context:[String:Any])throws->[String:Any] {
        let assessment=try unwrap(envelope,task:"consistency")
        try checkAssessmentTargets(assessment,answers:acceptedAnswers(context))
        return ["reply":envelope["reply"]!,"consistency":assessment]
    }

    private static func checkAssessmentTargets(_ assessment:[String:Any],answers:[String:Any])throws {
        guard let issues=assessment["issues"] as? [[String:Any]] else{throw PlanningPromptPackError.invalid}
        var seen=Set<String>()
        for issue in issues {
            guard let question=issue["questionId"] as? String,answers[question] != nil,seen.insert(question).inserted,
                  let fields=issue["fields"] as? [String],!fields.isEmpty,Set(fields).count==fields.count,
                  let allowed=fieldsByQuestion[question],Set(fields).isSubset(of:allowed) else{throw PlanningPromptPackError.invalid}
            guard let reason=issue["reason"] as? String,text(reason,maximum:2000) else{throw PlanningPromptPackError.invalid}
            if let suggestion=issue["suggestion"] as? [String:Any] {
                guard let summary=suggestion["summary"] as? String,text(summary,maximum:2000),let proposed=suggestion["fields"] as? [String:String],!proposed.isEmpty,Set(proposed.keys).isSubset(of:Set(fields)),proposed.values.allSatisfy({text($0,maximum:2000)}) else{throw PlanningPromptPackError.invalid}
            }
        }
    }

    static func interviewResult(_ envelope:[String:Any],context:[String:Any])throws->[String:Any] {
        let result=try unwrap(envelope,task:"interview"),mapping=try interviewContext(context)
        guard let questionID=result["questionId"] as? String,questionID==mapping.input["currentQuestion"] as? String,
              let fields=result["fields"] as? [String:String],let evidence=result["evidence"] as? [[String:Any]],
              let complete=result["complete"] as? Bool,let unresolved=result["unresolved"] as? [String],let summary=result["summary"] as? String else{throw PlanningPromptPackError.evidence}
        guard fields.keys.allSatisfy({field in evidence.filter{$0["field"] as? String==field}.count==1}),evidence.count==fields.count else{throw PlanningPromptPackError.evidence}
        var linked:[[String:Any]]=[]
        for item in evidence {
            guard let field=item["field"] as? String,fields[field] != nil,let reference=item["messageRef"] as? String,
                  let source=mapping.references[reference],source.role=="user",let quote=item["quote"] as? String else{throw PlanningPromptPackError.evidence}
            var converted:[String:Any]=["field":field,"messageId":source.id,"quote":quote]
            if let proposal=item["proposalRef"] as? String {
                guard let suggestion=mapping.references[proposal],suggestion.role=="assistant",suggestion.index<source.index else{throw PlanningPromptPackError.evidence}
                converted["proposalMessageId"]=suggestion.id
            }
            linked.append(converted)
        }
        let existing=mapping.input["currentFields"] as? [String:String] ?? [:]
        if complete && fields.isEmpty && existing.isEmpty{throw PlanningPromptPackError.invalid}
        let update:[String:Any]=["id":questionID,"fields":fields,"evidence":linked,"missing":unresolved,"complete":complete]
        var output:[String:Any]=["reply":envelope["reply"]!,"summary":summary,"updates":[update]]
        if let assessment=result["consistency"] as? [String:Any] {
            var answers=try acceptedAnswers(context)
            var merged=existing;for (key,value) in fields{merged[key]=value}
            if !merged.isEmpty{answers[questionID]=["summary":summary,"fields":merged]}
            try checkAssessmentTargets(assessment,answers:answers);output["consistency"]=assessment
        }
        return output
    }

    private struct MessageReference {let id:String,role:String,index:Int}
    private static func interviewContext(_ context:[String:Any])throws->(input:[String:Any],references:[String:MessageReference]) {
        guard let locale=context["locale"] as? String,["zh-CN","en"].contains(locale),let questionID=context["currentQuestion"] as? String,fieldsByQuestion[questionID] != nil,
              let questions=context["questions"] as? [[String:Any]],questions.count<=5,
              let messages=context["messages"] as? [[String:Any]],messages.count<=128 else{throw PlanningPromptPackError.invalid}
        var questionIDs=Set<String>(),accepted:[String:Any]=[:],current:[String:Any]?
        for question in questions {
            guard let id=question["id"] as? String,let allowed=fieldsByQuestion[id],questionIDs.insert(id).inserted,
                  let status=question["status"] as? String,["pending","current","needs-detail","awaiting-confirmation","complete","needs-review"].contains(status),
                  let fields=question["fields"] as? [String:String],fields.keys.allSatisfy({allowed.contains($0)}),fields.values.allSatisfy({text($0,maximum:2000)}),
                  let summary=question["summary"] as? String,text(summary,maximum:2000,empty:true) else{throw PlanningPromptPackError.invalid}
            if id==questionID{current=question}
        }
        accepted=try acceptedAnswers(context)
        guard let current else{throw PlanningPromptPackError.invalid}
        var start=0
        if let raw=current["conversationFrom"]{
            guard let value=integer(raw),value>=0,value<=messages.count else{throw PlanningPromptPackError.invalid};start=value
        }
        var ids=Set<String>(),userCount=0,assistantCount=0,wire:[[String:Any]]=[],references:[String:MessageReference]=[:]
        for (index,message) in messages.enumerated() {
            guard let id=message["id"] as? String,id.range(of:"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$",options:.regularExpression) != nil,ids.insert(id).inserted,
                  let role=message["role"] as? String,["user","assistant"].contains(role),let value=message["text"] as? String,text(value,maximum:8000) else{throw PlanningPromptPackError.invalid}
            if let raw=message["questionId"]{guard let id=raw as? String,fieldsByQuestion[id] != nil else{throw PlanningPromptPackError.invalid}}
            guard index>=start,message["questionId"] as? String==questionID else{continue}
            let reference:String
            if role=="user"{userCount+=1;reference="U\(userCount)"}else{assistantCount+=1;reference="A\(assistantCount)"}
            wire.append(["ref":reference,"role":role,"text":value]);references[reference]=MessageReference(id:id,role:role,index:index)
        }
        var input:[String:Any]=["locale":locale,"currentQuestion":questionID,"acceptedAnswers":accepted,"currentFields":current["fields"]!,"messages":wire]
        if let adopted=accepted[questionID]{input["acceptedAnswer"]=adopted}
        if let consistency=context["consistency"] as? [String:Any],let anchor=consistency["anchorQuestionId"] as? String,accepted[anchor] != nil{input["anchorQuestionId"]=anchor}
        if let resources=context["resources"]{
            guard let value=resources as? String,text(value,maximum:4000,empty:true) else{throw PlanningPromptPackError.invalid};input["resources"]=value
        }
        _ = try bounded(input,maximum:768*1024)
        return (input,references)
    }

    private static func text(_ value:String,maximum:Int,empty:Bool=false)->Bool {
        !value.contains("\0") && value.utf16.count<=maximum && (empty || !value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
    }
    private static func decode(_ value:String)->Any?{try? JSONSerialization.jsonObject(with:Data(value.utf8))}
    private static func bounded(_ value:[String:Any],maximum:Int)throws->Data {
        guard JSONSerialization.isValidJSONObject(value),let data=try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys) else{throw PlanningPromptPackError.invalid}
        guard data.count<=maximum else{throw PlanningPromptPackError.tooLarge};return data
    }
    private static func boolean(_ value:Any)->Bool {
        guard let number=value as? NSNumber else{return false};return CFGetTypeID(number)==CFBooleanGetTypeID()
    }
    private static func integer(_ value:Any)->Int? {
        guard !boolean(value),let number=value as? NSNumber else{return nil}
        let numeric=number.doubleValue
        guard numeric.isFinite,numeric.rounded()==numeric,abs(numeric)<=9_007_199_254_740_991 else{return nil};return Int(numeric)
    }
    private static func equal(_ first:Any,_ second:Any)->Bool {
        if boolean(first) != boolean(second){return false}
        guard let a=try? JSONSerialization.data(withJSONObject:first,options:[.sortedKeys,.fragmentsAllowed]),let b=try? JSONSerialization.data(withJSONObject:second,options:[.sortedKeys,.fragmentsAllowed]) else{return false};return a==b
    }
    private static func matches(_ value:Any,_ rule:[String:Any],root:[String:Any],depth:Int=0)->Bool {
        guard depth<=64 else{return false}
        let next:(Any,[String:Any])->Bool={matches($0,$1,root:root,depth:depth+1)}
        if let reference=rule["$ref"] as? String {
            guard reference.hasPrefix("#/$defs/"),let definitions=root["$defs"] as? [String:[String:Any]],let target=definitions[String(reference.dropFirst(8))],next(value,target) else{return false}
        }
        if let choices=rule["anyOf"] as? [[String:Any]],!choices.contains(where:{next(value,$0)}){return false}
        if let choices=rule["oneOf"] as? [[String:Any]],choices.filter({next(value,$0)}).count != 1{return false}
        if let rules=rule["allOf"] as? [[String:Any]],!rules.allSatisfy({next(value,$0)}){return false}
        if let condition=rule["if"] as? [String:Any],next(value,condition),let consequent=rule["then"] as? [String:Any],!next(value,consequent){return false}
        if let excluded=rule["not"] as? [String:Any],next(value,excluded){return false}
        if let constant=rule["const"],!equal(value,constant){return false}
        if let choices=rule["enum"] as? [Any],!choices.contains(where:{equal(value,$0)}){return false}
        if let type=rule["type"] as? String {
            switch type {
            case "object":if !(value is [String:Any]){return false}
            case "array":if !(value is [Any]){return false}
            case "string":if !(value is String){return false}
            case "boolean":if !boolean(value){return false}
            case "integer":if integer(value)==nil{return false}
            case "null":if !(value is NSNull){return false}
            default:return false
            }
        }
        if let value=value as? String {
            let count=value.unicodeScalars.count
            if value.contains("\0"){return false}
            if let minimum=rule["minLength"] as? Int,count<minimum{return false}
            if let maximum=rule["maxLength"] as? Int,count>maximum{return false}
            if let pattern=rule["pattern"] as? String,value.range(of:pattern,options:.regularExpression)==nil{return false}
        }
        if !boolean(value),let number=value as? NSNumber {
            let numeric=number.doubleValue;if !numeric.isFinite{return false}
            if let minimum=rule["minimum"] as? NSNumber,numeric<minimum.doubleValue{return false}
            if let maximum=rule["maximum"] as? NSNumber,numeric>maximum.doubleValue{return false}
        }
        if let array=value as? [Any] {
            if let minimum=rule["minItems"] as? Int,array.count<minimum{return false}
            if let maximum=rule["maxItems"] as? Int,array.count>maximum{return false}
            if rule["uniqueItems"] as? Bool==true {
                for index in array.indices {if array[..<index].contains(where:{equal($0,array[index])}){return false}}
            }
            if let item=rule["items"] as? [String:Any],!array.allSatisfy({next($0,item)}){return false}
        }
        if let object=value as? [String:Any] {
            let properties=rule["properties"] as? [String:[String:Any]] ?? [:]
            if let required=rule["required"] as? [String],!required.allSatisfy({object[$0] != nil}){return false}
            if rule["additionalProperties"] as? Bool==false,!object.keys.allSatisfy({properties[$0] != nil}){return false}
            if let names=rule["propertyNames"] as? [String:Any],!object.keys.allSatisfy({next($0,names)}){return false}
            for (key,item) in object {if let property=properties[key],!next(item,property){return false}}
        }
        return true
    }
}
