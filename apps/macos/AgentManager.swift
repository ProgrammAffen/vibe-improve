import Foundation
import Darwin
import CoreFoundation

enum AgentError: String, Error { case invalid="AGENT_INVALID", unavailable="AGENT_UNAVAILABLE", auth="AGENT_AUTH_REQUIRED", busy="AGENT_BUSY", login="AGENT_LOGIN_FAILED", timeout="AGENT_TIMEOUT", runtime="AGENT_RUNTIME_REQUIRED", install="AGENT_INSTALL_FAILED" }
struct AgentCommandResult { let status: Int32; let text: String; let diagnostic: String; let timedOut: Bool }
final class AgentOutput {
    private let lock=NSLock()
    private var data=Data()
    func append(_ value: Data) { lock.lock(); defer {lock.unlock()}; if data.count<65_536 {data.append(value.prefix(65_536-data.count))} }
    var text: String {lock.lock();defer{lock.unlock()};return String(decoding:data,as:UTF8.self)}
}
final class AgentLogin {
    let id=UUID().uuidString.lowercased()
    let process=Process(), input=Pipe(), output=Pipe(), error=Pipe()
    let lock=NSLock()
    var state="pending", url: String?, awaitingCode=false, tail=""
    var failureCode:String?
    var retained:AnyObject?
    static func permitsAuthURL(_ url:URL)->Bool {
        guard url.scheme=="https",url.user==nil,url.password==nil,url.port==nil || url.port==443 else{return false}
        let host=url.host?.lowercased() ?? ""
        if ["copilot.tencent.com","www.codebuddy.cn","www.codebuddy.ai"].contains(host){return url.path=="/login" || url.path.hasPrefix("/login/")}
        return ["claude.ai","console.anthropic.com","platform.claude.com","auth.openai.com","chatgpt.com"].contains(host) && url.path.contains("oauth")
    }
    func snapshot()->[String:Any] {lock.lock();defer{lock.unlock()};var value:[String:Any]=["id":id,"state":state,"awaitingCode":awaitingCode];if let url {value["url"]=url};if let failureCode {value["errorCode"]=failureCode};return value}
    func observe(_ data:Data) {
        let text=String(decoding:data,as:UTF8.self)
        lock.lock();defer{lock.unlock()}
        tail=String((tail+text).suffix(8192))
        if tail.localizedCaseInsensitiveContains("paste code") || tail.localizedCaseInsensitiveContains("enter code") {awaitingCode=true}
        if let regex=try? NSRegularExpression(pattern:"https://[^\\s\\u001B<>\"']+"), let match=regex.matches(in:tail,range:NSRange(tail.startIndex...,in:tail)).last, let range=Range(match.range,in:tail) {
            let candidate=String(tail[range])
            if let parsed=URL(string:candidate),Self.permitsAuthURL(parsed){url=candidate}
        }
    }
    func stop(_ next:String) {lock.lock();guard state=="pending" else{lock.unlock();return};state=next;tail="";url=nil;lock.unlock();if process.isRunning{process.terminate();DispatchQueue.global().asyncAfter(deadline:.now()+2){[self] in if process.isRunning{kill(process.processIdentifier,SIGKILL)}}}}
}

final class AgentManager {
    static let ids=["codex","claude-code","codebuddy","qoder","openclaw","hermes"]
    private let runtime:RuntimeDirectory
    private let jobsLock=NSLock(), preferenceLock=NSLock()
    private var jobs:[String:AgentLogin]=[:]
    private let home:URL
    private let command: (URL,[String],TimeInterval)->AgentCommandResult
    private let resolverOverride: ((String)->URL?)?
    private let codebuddy:CodeBuddyAdapter
    init(runtime:RuntimeDirectory,home:URL=FileManager.default.homeDirectoryForCurrentUser,resolver:((String)->URL?)?=nil,runner:((URL,[String],TimeInterval)->AgentCommandResult)?=nil) throws {
        self.runtime=try runtime.child("agents");self.home=home;self.resolverOverride=resolver
        self.codebuddy=try CodeBuddyAdapter(runtime:self.runtime,home:home)
        let working=self.runtime.url
        self.command=runner ?? {url,args,timeout in AgentManager.run(url,args:args,timeout:timeout,working:working)}
    }
    static func run(_ executable:URL,args:[String],timeout:TimeInterval,working:URL,environment:[String:String]?=nil)->AgentCommandResult {
        let process=Process(),output=Pipe(),errorPipe=Pipe(),done=DispatchSemaphore(value:0),reads=DispatchGroup(),out=AgentOutput(),err=AgentOutput()
        process.executableURL=executable;process.arguments=args;process.currentDirectoryURL=working
        var env=environment ?? ProcessInfo.processInfo.environment
        env["TMPDIR"]=working.path;env["CLAUDE_CODE_TMPDIR"]=working.path;env["DISABLE_AUTOUPDATER"]="1";env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]="1";env["NO_COLOR"]="1"
        process.environment=env;process.standardInput=FileHandle.nullDevice;process.standardOutput=output;process.standardError=errorPipe
        for (pipe,capture) in [(output,out),(errorPipe,err)] {
            reads.enter();DispatchQueue.global().async{while true{let data=pipe.fileHandleForReading.availableData;if data.isEmpty{break};capture.append(data)};reads.leave()}
        }
        process.terminationHandler={_ in done.signal()}
        do{try process.run()}catch{try? output.fileHandleForWriting.close();try? errorPipe.fileHandleForWriting.close();return AgentCommandResult(status:-1,text:"",diagnostic:"",timedOut:false)}
        let timed=done.wait(timeout:.now()+timeout) == .timedOut
        if timed && process.isRunning{process.terminate();if done.wait(timeout:.now()+1) == .timedOut && process.isRunning{kill(process.processIdentifier,SIGKILL);_ = done.wait(timeout:.now()+1)}}
        _ = reads.wait(timeout:.now()+1)
        return AgentCommandResult(status:process.isRunning ? -1:process.terminationStatus,text:out.text,diagnostic:err.text,timedOut:timed)
    }
    private func candidates(_ id:String)->[URL] {
        let names:[String:[String]]=["codex":["codex"],"claude-code":["claude"],"qoder":["qoder","qodercli"],"codebuddy":["codebuddy","codebuddy-code","cbc"],"openclaw":["openclaw"],"hermes":["hermes"]]
        var paths:[URL]=[]
        if id=="codex"{paths.append(URL(fileURLWithPath:"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))}
        if id=="claude-code"{
            let folder=home.appendingPathComponent("Library/Application Support/Claude/claude-code")
            let children:[String]=(try? FileManager.default.contentsOfDirectory(atPath:folder.path)) ?? []
            let validVersions=children.filter{$0.range(of:"^[0-9]+\\.[0-9]+\\.[0-9]+$",options:.regularExpression) != nil}
            let versions=validVersions.sorted{$0.compare($1,options:.numeric) == .orderedDescending}
            paths += versions.map{folder.appendingPathComponent($0+"/claude.app/Contents/MacOS/claude")}
        }
        var dirs:[String]=["/usr/local/bin","/opt/homebrew/bin"]
        dirs.append(home.appendingPathComponent(".local/bin").path)
        dirs.append(home.appendingPathComponent(".npm-global/bin").path)
        let environmentPath:String=ProcessInfo.processInfo.environment["PATH"] ?? ""
        dirs.append(contentsOf:environmentPath.split(separator:":").map{String($0)})
        for dir in Array(Set(dirs)).filter({$0.hasPrefix("/")}){for name in names[id] ?? []{paths.append(URL(fileURLWithPath:dir).appendingPathComponent(name))}}
        return paths.filter{FileManager.default.isExecutableFile(atPath:$0.path)}
    }
    private func installedApplication(_ id:String)->URL? {
        let names:[String:[String]]=["qoder":["Qoder"],"openclaw":["OpenClaw"],"hermes":["Hermes"]]
        for root in [URL(fileURLWithPath:"/Applications",isDirectory:true),home.appendingPathComponent("Applications",isDirectory:true)] {
            for name in names[id] ?? [] {
                let path=root.appendingPathComponent(name+".app",isDirectory:true)
                var directory:ObjCBool=false
                if FileManager.default.fileExists(atPath:path.path,isDirectory:&directory),directory.boolValue{return path}
            }
        }
        return nil
    }
    private func resolve(_ id:String)->URL? {
        if let resolverOverride{return resolverOverride(id)}
        guard let team=["codex":"2DC432GLL2","claude-code":"Q6L2SF6YDW"][id] else{return nil}
        for path in candidates(id){
            let real=path.resolvingSymlinksInPath()
            let check=command(URL(fileURLWithPath:"/usr/bin/codesign"),["--verify","--strict",real.path],6)
            if check.status != 0{continue}
            let info=command(URL(fileURLWithPath:"/usr/bin/codesign"),["-dv","--verbose=2",real.path],6)
            if info.status==0&&(info.text+info.diagnostic).split(separator:"\n").contains(Substring("TeamIdentifier="+team)){return real}
        }
        return nil
    }
    func probe(_ id:String)throws->[String:Any] {
        guard Self.ids.contains(id) else{throw AgentError.invalid}
        if id=="codebuddy",resolverOverride==nil{return codebuddy.probe()}
        guard let binary=resolve(id) else{
            let commands=candidates(id),application=installedApplication(id)
            return ["id":id,"state":commands.isEmpty && application == nil ? "not-installed":"unverified"]
        }
        let version=command(binary,["--version"],8)
        guard version.status==0,!version.timedOut else{return["id":id,"state":"unknown"]}
        let auth=command(binary,id=="claude-code" ? ["auth","status","--json"]:["login","status"],12)
        let state=Self.authentication(id:id,result:auth)
        let pattern="[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+.][A-Za-z0-9.]+)?"
        let text=version.text
        var result:[String:Any]=["id":id,"state":state]
        if let range=text.range(of:pattern,options:.regularExpression){result["version"]=String(text[range])}
        return result
    }
    static func authentication(id:String,result:AgentCommandResult)->String {
        if result.timedOut{return "unknown"}
        if id=="claude-code"{
            guard let data=result.text.data(using:.utf8),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let number=value["loggedIn"] as? NSNumber,CFGetTypeID(number)==CFBooleanGetTypeID() else{return "unknown"}
            let logged=number.boolValue
            if logged && result.status==0{return "ready"}
            if !logged && result.status==1{return "login-required"}
            return "unknown"
        }
        let text=(result.text+result.diagnostic).lowercased()
        if result.status==0 && text.contains("logged in using"){return "ready"}
        if result.status==1 && text.contains("not logged in"){return "login-required"}
        return "unknown"
    }
    private func validScope(_ scope:String)->Bool {scope=="default" || scope.range(of:"^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",options:.regularExpression) != nil}
    func choice(_ scope:String)throws->Any {
        guard validScope(scope) else{throw AgentError.invalid};preferenceLock.lock();defer{preferenceLock.unlock()}
        return try runtime.locked{ () -> Any in guard let data=try runtime.read("choices.json",maximumBytes:131_072),let values=try JSONSerialization.jsonObject(with:data) as? [String:String] else{return NSNull()};if let value=values[scope] ?? values["default"],Self.ids.contains(value)||value=="manual"{return value};return NSNull()}
    }
    func save(_ scope:String,choice:String)throws {
        guard validScope(scope),Self.ids.contains(choice)||choice=="manual" else{throw AgentError.invalid}
        if choice != "manual"{guard try probe(choice)["state"] as? String=="ready" else{throw AgentError.auth}}
        preferenceLock.lock();defer{preferenceLock.unlock()}
        try runtime.locked{
            var values:[String:String]=[:]
            if let data=try runtime.read("choices.json",maximumBytes:131_072){guard let parsed=try JSONSerialization.jsonObject(with:data) as? [String:String] else{throw AgentError.unavailable};values=parsed}
            guard values.count<513 || values[scope] != nil else{throw AgentError.unavailable}
            values[scope]=choice;try runtime.write("choices.json",data:JSONSerialization.data(withJSONObject:values,options:.sortedKeys))
        }
    }
    func beginLogin(_ id:String)throws->[String:Any] {
        if id=="codebuddy" {
            jobsLock.lock();defer{jobsLock.unlock()}
            if jobs.values.contains(where:{$0.snapshot()["state"] as? String=="pending"}){throw AgentError.busy}
            jobs=jobs.filter{$0.value.snapshot()["state"] as? String=="pending"}
            let job=codebuddy.beginLogin();jobs[job.id]=job
            DispatchQueue.global().asyncAfter(deadline:.now()+600){job.stop("timeout")}
            return job.snapshot()
        }
        guard ["claude-code","codex"].contains(id),let binary=resolve(id) else{throw AgentError.unavailable}
        jobsLock.lock();defer{jobsLock.unlock()}
        if jobs.values.contains(where:{$0.snapshot()["state"] as? String=="pending"}){throw AgentError.busy}
        jobs=jobs.filter{$0.value.snapshot()["state"] as? String=="pending"}
        let job=AgentLogin();job.process.executableURL=binary;job.process.arguments=id=="claude-code" ? ["auth","login"]:["login"];job.process.currentDirectoryURL=runtime.url
        var env=ProcessInfo.processInfo.environment;env["CLAUDE_CODE_TMPDIR"]=runtime.url.path;env["TMPDIR"]=runtime.url.path;env["DISABLE_AUTOUPDATER"]="1";env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]="1"
        job.process.environment=env;job.process.standardInput=job.input;job.process.standardOutput=job.output;job.process.standardError=job.error
        for pipe in [job.output,job.error]{pipe.fileHandleForReading.readabilityHandler={handle in let data=handle.availableData;if !data.isEmpty{job.observe(data)}else{handle.readabilityHandler=nil}}}
        job.process.terminationHandler={process in
            job.output.fileHandleForReading.readabilityHandler=nil;job.error.fileHandleForReading.readabilityHandler=nil
            job.lock.lock();if job.state=="pending"{job.state=process.terminationStatus==0 ? "finished":"failed"};job.tail="";job.url=nil;job.lock.unlock()
        }
        do{try job.process.run()}catch{job.output.fileHandleForReading.readabilityHandler=nil;job.error.fileHandleForReading.readabilityHandler=nil;throw AgentError.login}
        jobs[job.id]=job
        DispatchQueue.global().asyncAfter(deadline:.now()+600){job.stop("timeout")}
        return job.snapshot()
    }
    func beginInstall(_ id:String)throws->[String:Any] {
        guard id=="codebuddy" else{throw AgentError.invalid}
        jobsLock.lock();defer{jobsLock.unlock()}
        if jobs.values.contains(where:{$0.snapshot()["state"] as? String=="pending"}){throw AgentError.busy}
        jobs=jobs.filter{$0.value.snapshot()["state"] as? String=="pending"}
        let job=codebuddy.beginInstall();jobs[job.id]=job
        DispatchQueue.global().asyncAfter(deadline:.now()+600){job.stop("timeout")}
        return job.snapshot()
    }
    private func job(_ id:String)throws->AgentLogin {jobsLock.lock();defer{jobsLock.unlock()};guard let job=jobs[id] else{throw AgentError.invalid};return job}
    func loginState(_ id:String)throws->[String:Any]{try job(id).snapshot()}
    func cancelLogin(_ id:String)throws {try job(id).stop("cancelled")}
    func sendCode(_ id:String,code:String)throws {
        guard !code.isEmpty,code.utf8.count<=4096,!code.unicodeScalars.contains(where:{$0.value<32||$0.value==127}) else{throw AgentError.invalid}
        let job=try job(id);guard job.snapshot()["state"] as? String=="pending" else{throw AgentError.invalid}
        try job.input.fileHandleForWriting.write(contentsOf:Data((code+"\n").utf8))
    }
    func shutdown(){jobsLock.lock();let active=Array(jobs.values);jobsLock.unlock();for job in active{job.stop("cancelled")}}
}
