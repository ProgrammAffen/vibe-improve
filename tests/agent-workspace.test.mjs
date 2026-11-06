import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import vm from 'node:vm';

test('project session preparation accepts a project ID only and sanitizes replies',async()=>{
  const domain={exports:{}};
  vm.runInNewContext(ts.transpileModule(await readFile('apps/local-ui/src/agents/domain.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:domain,exports:domain.exports});
  const calls=[],service={exports:{}};
  let response={projectId:'proj_12345678-1234-4234-8234-123456789abc',provider:'codebuddy',executable:'PRIVATE_PATH',token:'PRIVATE_TOKEN'};
  vm.runInNewContext(ts.transpileModule(await readFile('apps/local-ui/src/agents/service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:service,exports:service.exports,require:()=>domain.exports,window:{vibeNative:{agents:{request:async(action,value)=>{calls.push({action,value});return response}}}}});
  const id=response.projectId,result=await service.exports.agentService.prepare(id);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{projectId:id,provider:'codebuddy'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{action:'session.prepare',value:{projectId:id}}]);
  await assert.rejects(service.exports.agentService.prepare('/arbitrary/path'),/AGENT_INVALID/);
  response={projectId:id,provider:'trae'};
  await assert.rejects(service.exports.agentService.prepare(id),/AGENT_INVALID/);
});

test('native prepared sessions use the selected workspace while auth and temp files retain runtime scope',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
  const parent=resolve('tmp/checks/agent-workspace');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
  const fixture=join(dir,'cli-fixture.py');
  await writeFile(fixture,String.raw`#!/usr/bin/python3
import os,json,sys
for line in sys.stdin:
    message=json.loads(line)
    if message.get('type')=='control_request':
        print(json.dumps({'type':'control_response','response':{'request_id':'metadata','subtype':'success','response':{'account':{'uid':'synthetic','token':'SYNTHETIC_ONLY'}}}}),flush=True)
    else:
        print(json.dumps({'cwd':os.getcwd(),'tmp':os.environ.get('TMPDIR'),'config':os.environ.get('CODEBUDDY_CONFIG_DIR'),'args':sys.argv[1:]}),flush=True)
        break
`);
  const source=join(dir,'main.swift'),binary=join(dir,'verify');
  await writeFile(source,`import Foundation
import Darwin
func check(_ condition:Bool){precondition(condition)}
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
let runtime=try RuntimeDirectory(url:base.appendingPathComponent("runtime"))
let workspace=base.appendingPathComponent("旅程 空格 $(not-a-command)",isDirectory:true)
try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
let id="proj_12345678-1234-4234-8234-123456789abc"
var provider="codex",calls=0
let manager=try AgentManager(runtime:runtime,resolver:{_ in URL(fileURLWithPath:"/synthetic/verified-cli")},runner:{_,args,_ in
 calls += 1
 if args==["--version"]{return AgentCommandResult(status:0,text:"2.1.209",diagnostic:"",timedOut:false)}
 return AgentCommandResult(status:0,text:provider=="codex" ? "Logged in using ChatGPT":"{\\"loggedIn\\":true}",diagnostic:"",timedOut:false)
},projectWorkspace:{value in guard value==id else{throw AgentError.project};return workspace})
try manager.save(id,choice:"manual")
let manual=try manager.prepareSession(projectID:id)
check(manual.provider=="manual" && manual.launch==nil && calls==0)
check(Set(manual.summary.keys)==Set(["projectId","provider"]))
do{_ = try manager.prepareSession(projectID:"default");preconditionFailure()}catch AgentError.invalid{}
do{_ = try manager.prepareSession(projectID:"proj_00000000-0000-4000-8000-000000000000");preconditionFailure()}catch AgentError.project{}
try manager.save(id,choice:"codex")
let codex=try manager.prepareSession(projectID:id).launch!
check(codex.arguments==["--cd",workspace.path,"app-server"])
check(codex.threadStartParameters["cwd"] as? String==workspace.path)
check(codex.turnStartParameters["cwd"] as? String==workspace.path)
check(codex.environment["TMPDIR"]==runtime.url.appendingPathComponent("agents").path)
let process=Process();try codex.configure(process)
check(process.currentDirectoryURL?.path==workspace.path)
check(!codex.arguments.contains("--add-dir") && !codex.arguments.contains("--dangerously-bypass-approvals-and-sandbox"))
provider="claude-code";try manager.save(id,choice:provider)
let claude=try manager.prepareSession(projectID:id).launch!
check(claude.workspace==workspace && !claude.arguments.contains("--add-dir") && !claude.arguments.contains("--cwd"))
check(claude.environment["CLAUDE_CODE_TMPDIR"]==runtime.url.appendingPathComponent("agents").path)
let fixture=URL(fileURLWithPath:CommandLine.arguments[2])
let adapter=try CodeBuddyAdapter(runtime:try runtime.child("agents"),home:base,invocation:{CodeBuddyInvocation(executable:URL(fileURLWithPath:"/usr/bin/python3"),prefix:[fixture.path])})
let buddy=try adapter.prepareSession(projectID:id,workspace:workspace)
check(!buddy.arguments.contains("--cwd") && !buddy.arguments.contains("--add-dir"))
let child=Process(),input=Pipe(),output=Pipe();try buddy.configure(child)
child.standardInput=input;child.standardOutput=output;child.standardError=FileHandle.nullDevice
try child.run();try input.fileHandleForWriting.write(contentsOf:Data("{\\"type\\":\\"workspace-check\\"}\\n".utf8));try input.fileHandleForWriting.close()
let data=output.fileHandleForReading.readDataToEndOfFile();child.waitUntilExit();check(child.terminationStatus==0)
let record=try JSONSerialization.jsonObject(with:data) as! [String:Any]
check(record["cwd"] as? String==workspace.path)
let config=runtime.url.appendingPathComponent("agents/codebuddy").path
check(record["tmp"] as? String==config && record["config"] as? String==config)
check(!String(decoding:data,as:UTF8.self).contains("SYNTHETIC_ONLY"))
let moved=base.appendingPathComponent("moved")
try FileManager.default.moveItem(at:workspace,to:moved)
try FileManager.default.createSymbolicLink(at:workspace,withDestinationURL:moved)
do{try buddy.configure(Process());preconditionFailure()}catch AgentError.project{}
print("PASS native workspace configuration")
`);
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift',source,'-o',binary],{encoding:'utf8',timeout:210_000});
  assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(binary,[join(dir,'data'),fixture],{encoding:'utf8',timeout:30_000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS native workspace configuration/);
});
