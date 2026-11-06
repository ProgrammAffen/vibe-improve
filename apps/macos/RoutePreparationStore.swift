import Foundation
import JavaScriptCore
import CoreFoundation
import Darwin

enum RoutePreparationError:String,Error {
    case invalid="ROUTE_INVALID", json="ROUTE_INVALID_JSON", duplicate="ROUTE_DUPLICATE_KEYS", depth="ROUTE_DEPTH_LIMIT"
    case large="ROUTE_TOO_LARGE", version="ROUTE_VERSION_UNSUPPORTED", nodes="ROUTE_TOO_MANY_NODES"
    case utf8="ROUTE_INVALID_UTF8", read="ROUTE_READ_FAILED", storage="ROUTE_STORAGE_UNAVAILABLE"
    case conflict="ROUTE_CONFLICT", project="ROUTE_PROJECT_UNAVAILABLE", expired="ROUTE_IMPORT_EXPIRED"
}
final class RoutePreparationStore {
    private struct Pending {let projectID:String,route:[String:Any],fileName:String,created:Date}
    private let files:RuntimeDirectory,validatorURL:URL
    private let workspace:(String)throws->URL
    private var pending:[String:Pending]=[:]
    init(runtime:RuntimeDirectory,validatorURL:URL?=nil,workspace:@escaping(String)throws->URL)throws{
        files=try runtime.child("projects").child("route-preparation")
        self.validatorURL=validatorURL ?? Bundle.main.resourceURL!.appendingPathComponent("RouteValidation/route-validation.js")
        self.workspace=workspace
    }
    private func project(_ id:String)throws{
        guard id.range(of:"^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",options:.regularExpression) != nil else{throw RoutePreparationError.invalid}
        do{_ = try workspace(id)}catch{throw RoutePreparationError.project}
    }
    private func integer(_ value:Any?,minimum:Int=0)->Int?{
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue==Double(n.intValue),n.intValue>=minimum,n.intValue<1_000_000 else{return nil};return n.intValue
    }
    private func boolean(_ value:Any?)->Bool?{
        guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue
    }
    private func validate(_ text:String)throws->[String:Any]{
        guard let code=try? String(contentsOf:validatorURL,encoding:.utf8),let context=JSContext() else{throw RoutePreparationError.storage}
        context.evaluateScript(code)
        guard context.exception==nil,let parser=context.objectForKeyedSubscript("VibeRoute")?.objectForKeyedSubscript("parseRoute") else{throw RoutePreparationError.storage}
        let result=parser.call(withArguments:[text])
        if let exception=context.exception {
            let code=exception.objectForKeyedSubscript("message")?.toString() ?? ""
            throw RoutePreparationError(rawValue:code) ?? .invalid
        }
        guard let route=result?.toDictionary() as? [String:Any],JSONSerialization.isValidJSONObject(route) else{throw RoutePreparationError.invalid}
        return route
    }
    private func empty(_ id:String)->[String:Any]{["schemaVersion":1,"projectId":id,"revision":0,"agentConfirmed":false,"source":NSNull(),"aiAssisted":false]}
    private func readRaw(_ id:String)throws->[String:Any]{
        guard let data=try files.read(id+".json",maximumBytes:1_100_000) else{return empty(id)}
        guard let state=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(state.keys).isSubset(of:["schemaVersion","projectId","revision","agentConfirmed","source","aiAssisted","routeDraft"]),
              integer(state["schemaVersion"])==1,state["projectId"] as? String==id,integer(state["revision"]) != nil,
              boolean(state["agentConfirmed"]) != nil,boolean(state["aiAssisted"]) != nil,
              state["source"] is NSNull || ["create","import"].contains(state["source"] as? String ?? "") else{throw RoutePreparationError.storage}
        if let draft=state["routeDraft"] as? [String:Any]{
            guard Set(draft.keys)==["route","fileName"],let name=draft["fileName"] as? String,name.count<=255,
                  let route=draft["route"] as? [String:Any],let text=String(data:try JSONSerialization.data(withJSONObject:route),encoding:.utf8) else{throw RoutePreparationError.storage}
            _ = try validate(text)
        }else if state["routeDraft"] != nil{throw RoutePreparationError.storage}
        return state
    }
    private func write(_ id:String,_ state:[String:Any])throws{
        let data=try JSONSerialization.data(withJSONObject:state,options:.sortedKeys)
        guard data.count<=1_100_000 else{throw RoutePreparationError.large}
        try files.write(id+".json",data:data)
    }
    func read(projectID:String)throws->[String:Any]{try project(projectID);return try files.locked{try readRaw(projectID)}}
    func confirmAgent(projectID:String)throws->[String:Any]{
        try project(projectID)
        return try files.locked{var state=try readRaw(projectID);if state["agentConfirmed"] as? Bool != true{guard let revision=integer(state["revision"]),revision<999_999 else{throw RoutePreparationError.conflict};state["agentConfirmed"]=true;state["revision"]=revision+1;try write(projectID,state)};return state}
    }
    func choose(projectID:String,source:String,aiAssisted:Bool,expectedRevision:Int)throws->[String:Any]{
        try project(projectID);guard ["create","import"].contains(source),expectedRevision>=0,expectedRevision<999_999 else{throw RoutePreparationError.invalid}
        return try files.locked{
            var state=try readRaw(projectID);guard integer(state["revision"])==expectedRevision else{throw RoutePreparationError.conflict}
            guard state["agentConfirmed"] as? Bool==true else{throw RoutePreparationError.invalid}
            state["source"]=source;state["aiAssisted"]=aiAssisted;state["revision"]=expectedRevision+1;try write(projectID,state);return state
        }
    }
    func stage(projectID:String,url:URL)throws->[String:Any]{
        try project(projectID)
        let fd=open(url.path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        guard fd>=0 else{throw RoutePreparationError.read};defer{close(fd)}
        var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG else{throw RoutePreparationError.read}
        guard info.st_size>=0,info.st_size<=1_048_576 else{throw RoutePreparationError.large}
        var raw=Data(),buffer=[UInt8](repeating:0,count:16_384)
        while true{
            let count=Darwin.read(fd,&buffer,buffer.count)
            if count<0,errno==EINTR{continue};guard count>=0 else{throw RoutePreparationError.read};if count==0{break}
            raw.append(contentsOf:buffer.prefix(count));guard raw.count<=1_048_576 else{throw RoutePreparationError.large}
        }
        guard let text=String(data:raw,encoding:.utf8) else{throw RoutePreparationError.utf8}
        let route=try validate(text),token=UUID().uuidString.lowercased(),name=String(url.lastPathComponent.prefix(255))
        pending=pending.filter{Date().timeIntervalSince($0.value.created)<600&&$0.value.projectID != projectID}
        guard pending.count<16 else{throw RoutePreparationError.storage}
        pending[token]=Pending(projectID:projectID,route:route,fileName:name,created:Date())
        return ["importId":token,"route":route,"fileName":name]
    }
    func saveImport(projectID:String,importID:String,expectedRevision:Int)throws->[String:Any]{
        try project(projectID)
        guard let item=pending[importID],item.projectID==projectID,Date().timeIntervalSince(item.created)<600 else{throw RoutePreparationError.expired}
        guard expectedRevision>=0,expectedRevision<999_999 else{throw RoutePreparationError.invalid}
        let result=try files.locked{
            var state=try readRaw(projectID);guard integer(state["revision"])==expectedRevision else{throw RoutePreparationError.conflict}
            guard state["agentConfirmed"] as? Bool==true else{throw RoutePreparationError.invalid}
            state["source"]="import";state["routeDraft"]=["route":item.route,"fileName":item.fileName];state["revision"]=expectedRevision+1
            try write(projectID,state);return state
        }
        pending.removeValue(forKey:importID);return result
    }
    func removeImport(projectID:String,expectedRevision:Int,preserveCreated:Bool=false)throws->[String:Any]{
        try project(projectID)
        return try files.locked{
            var state=try readRaw(projectID)
            guard integer(state["revision"])==expectedRevision,expectedRevision<999_998 else{throw RoutePreparationError.conflict}
            state.removeValue(forKey:"routeDraft");state["source"]=preserveCreated ? "create" as Any:NSNull();state["revision"]=expectedRevision+1
            try write(projectID,state);pending=pending.filter{$0.value.projectID != projectID};return state
        }
    }
    func cancelImport(projectID:String,importID:String)throws{
        try project(projectID);if pending[importID]?.projectID==projectID{pending.removeValue(forKey:importID)}
    }
}
