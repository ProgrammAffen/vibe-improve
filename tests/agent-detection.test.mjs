import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
const transpile=async path=>ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('agent discovery scans once, joins concurrent entries, restores persisted results and refreshes only on request',async()=>{
 const d={exports:{}};vm.runInNewContext(await transpile('apps/local-ui/src/agents/domain.ts'),{module:d,exports:d.exports});
 const source=await transpile('apps/local-ui/src/agents/service.ts');let calls=0;const cache=new Map();
 const bridge={request:async(action,value)=>{
  if(action==='detection.read')return [...cache.values()];
  if(action==='probe'){calls++;await new Promise(resolve=>setTimeout(resolve,5));const result={id:value.id,state:value.id==='codex'?'ready':'not-installed',version:'1.2.3'};cache.set(value.id,result);return result}
  if(action==='choice.read')return 'codex';throw Error('AGENT_INVALID');
 }};
 function load(){const m={exports:{}};vm.runInNewContext(source,{module:m,exports:m.exports,require:()=>d.exports,window:{vibeNative:{agents:bridge}}});return m.exports.agentService}
 const first=load();await Promise.all([first.discovery(false,()=>{}),first.discovery(false,()=>{})]);assert.equal(calls,6);
 assert.equal((await first.discovery(false,()=>{})).length,6);assert.equal(calls,6);
 const restarted=load();assert.equal(await restarted.choice(),'codex');await restarted.discovery(false,()=>{});assert.equal(calls,6);
 await restarted.discovery(true,()=>{});assert.equal(calls,12);await restarted.probe('codex');assert.equal(calls,13);
});
test('native detection survives restart and reads without invoking a CLI',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
 const root=resolve('tmp/checks/agent-detection');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'run-')),file=join(dir,'main.swift'),binary=join(dir,'verify');
 await writeFile(file,`import Foundation
let base=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
let runtime=try RuntimeDirectory(url:base.appendingPathComponent("runtime"));var calls=0
let manager=try AgentManager(runtime:runtime,resolver:{_ in URL(fileURLWithPath:"/synthetic/verified-cli")},runner:{_,args,_ in calls+=1;return AgentCommandResult(status:0,text:args==["--version"] ? "1.2.3":"Logged in using ChatGPT",diagnostic:"",timedOut:false)})
precondition(try manager.detection().isEmpty)
for id in AgentManager.ids{_ = try manager.probe(id)}
let before=calls
try manager.save("default",choice:"manual")
let next=try AgentManager(runtime:runtime,resolver:{_ in preconditionFailure("cached read must not resolve CLI")},runner:{_,_,_ in preconditionFailure("cached read must not execute CLI")})
let values=try next.detection();precondition(values.count==6 && calls==before)
precondition(try next.choice("default") as? String=="manual")
let stored=String(data:try runtime.child("agents").read("detection.json",maximumBytes:16384)!,encoding:.utf8)!
precondition(!stored.contains("/synthetic") && !stored.contains("Logged in"))
print("PASS persistent detection")
`);
 // Swift precondition autoclosures do not allow throws.
 let swift=await readFile(file,'utf8');swift=swift.replace('precondition(try manager.detection().isEmpty)','let empty=try manager.detection();precondition(empty.isEmpty)').replace('precondition(try next.choice("default") as? String=="manual")','let choice=try next.choice("default");precondition(choice as? String=="manual")');await writeFile(file,swift);
 const compiled=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift',file,'-o',binary],{encoding:'utf8',timeout:150000});assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(binary,[join(dir,'data')],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS persistent detection/);
});
