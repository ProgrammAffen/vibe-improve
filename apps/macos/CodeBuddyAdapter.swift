import Foundation
import Darwin

struct CodeBuddyInvocation { let executable:URL; let prefix:[String] }

final class CodeBuddyControl {
    private let process=Process(),input=Pipe(),output=Pipe(),errors=Pipe(),condition=NSCondition(),bufferLock=NSLock()
    private var buffer=Data(),result:[String:Any]?,exited=false
    func initialize(_ invocation:CodeBuddyInvocation,working:URL)throws->[String:Any] {
        process.executableURL=invocation.executable
        process.arguments=invocation.prefix+CodeBuddyAdapter.streamArguments
        process.currentDirectoryURL=working;process.environment=CodeBuddyAdapter.environment(working)
        process.standardInput=input;process.standardOutput=output;process.standardError=errors
        output.fileHandleForReading.readabilityHandler={ [self] handle in
            let data=handle.availableData;if data.isEmpty{handle.readabilityHandler=nil}else{receive(data)}
        }
        errors.fileHandleForReading.readabilityHandler={handle in if handle.availableData.isEmpty{handle.readabilityHandler=nil}}
        process.terminationHandler={ [weak self] _ in guard let self else{return};condition.lock();exited=true;condition.broadcast();condition.unlock() }
        defer {
            output.fileHandleForReading.readabilityHandler=nil;errors.fileHandleForReading.readabilityHandler=nil
            if process.isRunning{process.terminate();let pid=process.processIdentifier;DispatchQueue.global().asyncAfter(deadline:.now()+2){[process] in if process.isRunning{kill(pid,SIGKILL)}}}
        }
        try process.run()
        let message:[String:Any]=["type":"control_request","request_id":"metadata","request":["subtype":"initialize"]]
        var data=try JSONSerialization.data(withJSONObject:message);data.append(10);try input.fileHandleForWriting.write(contentsOf:data)
        condition.lock();defer{condition.unlock()}
        let deadline=Date().addingTimeInterval(20)
        while result==nil && !exited{if !condition.wait(until:deadline){throw AgentError.timeout}}
        guard let result else{throw AgentError.unavailable};return result
    }
    private func receive(_ data:Data){
        bufferLock.lock();buffer.append(data)
        if buffer.count>1_048_576{buffer.removeAll();bufferLock.unlock();condition.lock();exited=true;condition.broadcast();condition.unlock();return}
        var lines:[Data]=[]
        while let end=buffer.firstIndex(of:10){lines.append(buffer.subdata(in:0..<end));buffer.removeSubrange(0...end)}
        bufferLock.unlock()
        for line in lines{
            guard let value=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any],value["type"] as? String=="control_response",
                  let response=value["response"] as? [String:Any],response["request_id"] as? String=="metadata",response["subtype"] as? String=="success",
                  let metadata=response["response"] as? [String:Any] else{continue}
            condition.lock();result=metadata;condition.broadcast();condition.unlock()
        }
    }
    static func authenticated(_ result:[String:Any])->Bool {
        guard let account=result["account"] as? [String:Any],let id=account["uid"] as? String,!id.isEmpty,
              let token=account["token"] as? String,!token.isEmpty,!token.contains("$wbEncrypted") else{return false}
        return true
    }
}

final class CodeBuddyTerminal {
    private weak var job:AgentLogin?
    private var master:FileHandle?,slave:FileHandle?,tail="",trusted=false,methodSelected=false
    private let lock=NSLock()
    init(job:AgentLogin){self.job=job}
    func start(_ invocation:CodeBuddyInvocation,working:URL)throws {
        guard let job else{throw AgentError.unavailable}
        var readFD:Int32=0,writeFD:Int32=0,size=winsize(ws_row:40,ws_col:300,ws_xpixel:0,ws_ypixel:0)
        guard openpty(&readFD,&writeFD,nil,nil,&size)==0 else{throw AgentError.unavailable}
        let reader=FileHandle(fileDescriptor:readFD,closeOnDealloc:true),writer=FileHandle(fileDescriptor:writeFD,closeOnDealloc:true)
        master=reader;slave=writer
        job.process.executableURL=invocation.executable;job.process.arguments=invocation.prefix+Array(CodeBuddyAdapter.streamArguments.dropFirst(5))
        job.process.currentDirectoryURL=working;var env=CodeBuddyAdapter.environment(working);env["TERM"]="xterm-256color";job.process.environment=env
        job.process.standardInput=writer;job.process.standardOutput=writer;job.process.standardError=writer
        reader.readabilityHandler={ [weak self] handle in let data=handle.availableData;if data.isEmpty{handle.readabilityHandler=nil}else{self?.receive(data)} }
        job.process.terminationHandler={ [weak job,weak self] _ in self?.close();job?.stop("failed") }
        job.lock.lock()
        guard job.state=="pending" else{job.lock.unlock();close();return}
        do{try job.process.run();job.lock.unlock();try? writer.close();slave=nil}catch{job.lock.unlock();close();throw error}
    }
    private func receive(_ data:Data){
        guard let job else{return}
        let text=String(decoding:data,as:UTF8.self).replacingOccurrences(of:"\u{001B}\\[[0-?]*[ -/]*[@-~]|\u{001B}\\](?:[^\u{0007}\u{001B}]|\u{001B}(?!\\\\))*(?:\u{0007}|\u{001B}\\\\)",with:"",options:.regularExpression)
        lock.lock();tail=String((tail+text).suffix(32768));let plain=tail.lowercased();var enter=false
        if !trusted,plain.contains("trust"),(plain.contains("folder")||plain.contains("directory")||plain.contains("project")){trusted=true;enter=true;tail=""}
        if !methodSelected,(plain.contains("select login method")||plain.contains("choose login method")||plain.contains("log in via chinese site")){methodSelected=true;enter=true;tail=""}
        lock.unlock();job.observe(Data(text.utf8))
        if enter{try? master?.write(contentsOf:Data("\r".utf8))}
    }
    func close(){master?.readabilityHandler=nil;try? master?.close();try? slave?.close();master=nil;slave=nil}
    deinit{close()}
}

final class CodeBuddyAdapter {
    static let streamArguments=["-p","--input-format","stream-json","--output-format","stream-json","--tools","","--strict-mcp-config","--mcp-config","{\"mcpServers\":{}}","--setting-sources","","--no-session-persistence"]
    private let working:URL,home:URL,resources:URL,invocationOverride:(()->CodeBuddyInvocation?)?
    init(runtime:RuntimeDirectory,home:URL,resources:URL?=nil,invocation:(()->CodeBuddyInvocation?)?=nil)throws {
        self.working=try runtime.child("codebuddy").url;self.home=home
        self.resources=resources ?? Bundle.main.resourceURL!.appendingPathComponent("CodeBuddyCLI",isDirectory:true);self.invocationOverride=invocation
    }
    static func environment(_ working:URL)->[String:String] {
        var env=ProcessInfo.processInfo.environment.filter{!$0.key.hasPrefix("CODEBUDDY_") && !["NODE_OPTIONS","NODE_PATH"].contains($0.key)}
        env["CODEBUDDY_INTERNET_ENVIRONMENT"]="internal";env["CODEBUDDY_CONFIG_DIR"]=working.path;env["TMPDIR"]=working.path
        env["CODEBUDDY_DISABLE_COMPILE_CACHE"]="1";env["CODEBUDDY_DISABLE_IDE"]="1";env["DISABLE_AUTOUPDATER"]="1";env["DISABLE_TELEMETRY"]="1";env["NO_COLOR"]="1"
        return env
    }
    private func node()->URL? {
        for path in ["/usr/local/bin/node","/opt/homebrew/bin/node",home.appendingPathComponent(".local/bin/node").path]{
            let binary=URL(fileURLWithPath:path)
            guard FileManager.default.isExecutableFile(atPath:path) else{continue}
            let result=AgentManager.run(binary,args:["--version"],timeout:5,working:working,environment:Self.environment(working))
            let version=result.text.trimmingCharacters(in:.whitespacesAndNewlines).replacingOccurrences(of:"v",with:"")
            if result.status==0,version.range(of:"^[0-9]+\\.[0-9]+\\.[0-9]+$",options:.regularExpression) != nil,version.compare("18.20.8",options:.numeric) != .orderedAscending{return binary}
        };return nil
    }
    private func candidates()->[String] {
        var folders=["/usr/local/bin","/opt/homebrew/bin",home.appendingPathComponent(".local/bin").path,home.appendingPathComponent(".npm-global/bin").path]
        folders += (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator:":").map(String.init)
        return Array(Set(folders)).filter{$0.hasPrefix("/")}.flatMap{folder in ["codebuddy","codebuddy-code","cbc"].map{URL(fileURLWithPath:folder).appendingPathComponent($0).path}}
    }
    private func resolve()->(CodeBuddyInvocation?,String) {
        if let invocationOverride{return(invocationOverride(),"not-installed")}
        guard let node=node() else{return(nil,"runtime-required")}
        let response=AgentManager.run(node,args:[resources.appendingPathComponent("manager.mjs").path,"resolve",working.path]+candidates(),timeout:30,working:working,environment:Self.environment(working))
        guard response.status==0,let data=response.text.trimmingCharacters(in:.whitespacesAndNewlines).data(using:.utf8),let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{return(nil,"unknown")}
        guard let entry=result["entry"] as? String else{return(nil,result["state"] as? String ?? "unknown")}
        return(CodeBuddyInvocation(executable:node,prefix:[entry]),"installed")
    }
    func probe()->[String:Any] {
        let (invocation,state)=resolve();guard let invocation else{return["id":"codebuddy","state":state]}
        do{
            let metadata=try CodeBuddyControl().initialize(invocation,working:working)
            return["id":"codebuddy","state":CodeBuddyControl.authenticated(metadata) ? "ready":"login-required","version":"2.177.0"]
        }catch{return["id":"codebuddy","state":"unknown"]}
    }
    func beginLogin()->AgentLogin {
        let job=AgentLogin()
        DispatchQueue.global().async{ [self] in
            do{
                guard let invocation=resolve().0 else{throw AgentError.unavailable}
                if CodeBuddyControl.authenticated(try CodeBuddyControl().initialize(invocation,working:working)){job.stop("finished");return}
                let terminal=CodeBuddyTerminal(job:job);job.lock.lock();job.retained=terminal;job.lock.unlock();try terminal.start(invocation,working:working)
                while job.snapshot()["state"] as? String=="pending"{
                    Thread.sleep(forTimeInterval:3)
                    if job.snapshot()["url"] != nil,CodeBuddyControl.authenticated((try? CodeBuddyControl().initialize(invocation,working:working)) ?? [:]){job.stop("finished")}
                }
                terminal.close()
            }catch{job.stop("failed")}
        };return job
    }
    func beginInstall()->AgentLogin {
        let job=AgentLogin()
        DispatchQueue.global().async{ [self] in
            guard let node=node() else{job.lock.lock();job.failureCode=AgentError.runtime.rawValue;job.lock.unlock();job.stop("failed");return}
            job.process.executableURL=node
            job.process.arguments=[resources.appendingPathComponent("manager.mjs").path,"install",working.path,"/usr/local/bin/npm","/opt/homebrew/bin/npm"]
            job.process.currentDirectoryURL=working;job.process.environment=Self.environment(working)
            job.process.standardInput=FileHandle.nullDevice;job.process.standardOutput=job.output;job.process.standardError=job.error
            let captured=AgentOutput()
            job.output.fileHandleForReading.readabilityHandler={handle in let data=handle.availableData;if data.isEmpty{handle.readabilityHandler=nil}else{captured.append(data)}}
            job.error.fileHandleForReading.readabilityHandler={handle in if handle.availableData.isEmpty{handle.readabilityHandler=nil}}
            job.process.terminationHandler={ [weak job] process in
                guard let job else{return}
                job.output.fileHandleForReading.readabilityHandler=nil;job.error.fileHandleForReading.readabilityHandler=nil
                let final=job.output.fileHandleForReading.readDataToEndOfFile();captured.append(final)
                let codes=Set(["AGENT_RUNTIME_REQUIRED","AGENT_NETWORK_FAILED","AGENT_INTEGRITY_FAILED","AGENT_DISK_FULL","AGENT_INSTALL_FAILED"])
                for line in captured.text.split(separator:"\n"){if let data=line.data(using:.utf8),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let code=value["error"] as? String,codes.contains(code){job.lock.lock();job.failureCode=code;job.lock.unlock()}}
                job.stop(process.terminationStatus==0 ? "finished":"failed")
            }
            job.lock.lock();guard job.state=="pending" else{job.lock.unlock();return}
            do{try job.process.run();job.lock.unlock()}catch{job.lock.unlock();job.stop("failed")}
        };return job
    }
}
