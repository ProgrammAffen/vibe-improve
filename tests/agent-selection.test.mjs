import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const compile=async file=>ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};vm.runInNewContext(await compile('apps/local-ui/src/agents/domain.ts'),{module,exports:module.exports});
test('manual choice remains available during failed or incomplete detection; unavailable agents cannot advance',()=>{
  const {canContinue,isChoice,parseProbe}=module.exports;
  assert.equal(canContinue('manual',[]),true);assert.equal(canContinue(null,[]),false);
  for(const state of ['checking','login-required','unknown','not-installed','unverified','desktop-required','runtime-required'])assert.equal(canContinue('codex',[{id:'codex',state}]),false);
  assert.equal(canContinue('codex',[{id:'codex',state:'ready'}]),true);
  assert.equal(isChoice('$(arbitrary command)'),false);
  assert.equal(parseProbe({id:'codex',state:'ready'},'claude-code').state,'unknown');
  assert.equal(isChoice('trae'),false);assert.equal(isChoice('workbuddy'),false);assert.equal(isChoice('codebuddy'),true);
  assert.equal(module.exports.PROVIDERS.length,6);
});
test('agent preferences use provider IDs and scopes; raw diagnostic text is not returned',async()=>{
  const calls=[],exports={exports:{}};
  vm.runInNewContext(await compile('apps/local-ui/src/agents/service.ts'),{module:exports,exports:exports.exports,window:{vibeNative:{agents:{request:async(action,value)=>{calls.push({action,value});if(action==='probe')return{id:'claude-code',state:'login-required',email:'PRIVATE_EMAIL',token:'PRIVATE_TOKEN'};throw new Error('AGENT_AUTH_REQUIRED PRIVATE_TOKEN')}}}},require:()=>module.exports});
  const {agentService}=exports.exports;
  const result=await agentService.probe('claude-code');assert.equal(result.state,'login-required');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await assert.rejects(agentService.save('codex','proj_12345678-1234-4234-8234-123456789abc'),/^Error: AGENT_AUTH_REQUIRED$/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{action:'choice.save',value:{scope:'proj_12345678-1234-4234-8234-123456789abc',choice:'codex'}});
});
test('native auth states, local choice persistence, cancellation and bounded process timeout',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
  const base='tmp/checks/agent-implementation';await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'native-')),source=join(dir,'main.swift'),binary=join(dir,'test');
  await writeFile(join(dir,'sdk-fixture.py'),String.raw`import sys,json,time,select
from pathlib import Path
marker=Path(__file__).parent/'wb-auth-complete'
if '--version' in sys.argv:
 print('2.177.0');sys.exit(0)
if '--input-format' not in sys.argv:
 print('Do you trust this folder?',flush=True);sys.stdin.readline()
 print('Log in via Chinese site',flush=True);sys.stdin.readline()
 print('https://evil.example/login',flush=True)
 print('https://www.codebuddy.cn/login?state=SYNTHETIC',flush=True)
 while not marker.exists():time.sleep(.05)
 print('Login successful',flush=True)
 while True:time.sleep(1)
login=None
while True:
 if login and marker.exists():
  print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':login,'response':{'success':True,'userinfo':{'token':'SYNTHETIC_PRIVATE_TOKEN'}}}}),flush=True);login=None
 readable,_,_=select.select([sys.stdin],[],[],.05)
 if not readable:continue
 line=sys.stdin.readline()
 if not line:break
 m=json.loads(line);i=m['request_id'];kind=m['request']['subtype']
 if kind=='authenticate':
  login=i
  for url in ['https://evil.example/login','https://www.codebuddy.cn/login?state=SYNTHETIC']:
   print(json.dumps({'type':'control_request','request':{'subtype':'auth_url_callback','authState':{'authUrl':url}}}),flush=True)
  continue
 result={'account':{'uid':'synthetic','token':'SYNTHETIC_PRIVATE_TOKEN'} if marker.exists() else {'uid':'synthetic'}} if kind=='initialize' else {'authMethods':[{'id':'codebuddy-desktop'}]}
 print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':i,'response':result}}),flush=True)
`);
  await writeFile(source,`import Foundation
import Darwin
func check(_ value:Bool){precondition(value)}
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
let runtime=try RuntimeDirectory(url:base)
func result(_ code:Int32,_ text:String,_ timed:Bool=false)->AgentCommandResult{AgentCommandResult(status:code,text:text,diagnostic:"",timedOut:timed)}
check(AgentManager.authentication(id:"claude-code",result:result(1,"{\\"loggedIn\\":false}"))=="login-required")
check(AgentManager.authentication(id:"claude-code",result:result(1,"network failed"))=="unknown")
check(AgentManager.authentication(id:"claude-code",result:result(0,"{\\"loggedIn\\":1}"))=="unknown")
check(AgentManager.authentication(id:"claude-code",result:result(0,"{\\"loggedIn\\":true}"))=="ready")
check(AgentManager.authentication(id:"codex",result:result(0,"Logged in using ChatGPT"))=="ready")
var calls=0,logged=true
let manager=try AgentManager(runtime:runtime,resolver:{_ in URL(fileURLWithPath:"/synthetic/official")},runner:{_,args,_ in calls += 1;return args==["--version"] ? result(0,"2.1.209"):result(logged ? 0:1,logged ? "{\\"loggedIn\\":true}":"{\\"loggedIn\\":false}")})
try manager.save("default",choice:"manual");check(calls==0)
check(try manager.choice("default") as? String=="manual")
let project="proj_12345678-1234-4234-8234-123456789abc"
try manager.save(project,choice:"claude-code");check(try manager.choice(project) as? String=="claude-code")
logged=false
do{try manager.save(project,choice:"claude-code");preconditionFailure()}catch AgentError.auth{}
check(try manager.choice(project) as? String=="claude-code")
do{try manager.save("../escape",choice:"manual");preconditionFailure()}catch AgentError.invalid{}
let restored=try AgentManager(runtime:runtime);check(try restored.choice(project) as? String=="claude-code")
let fixture=base.appendingPathComponent("login-fixture")
try "#!/bin/sh\\necho 'https://evil.example/oauth/steal'\\necho 'https://claude.ai/oauth/authorize?state=SYNTHETIC'\\necho 'Paste code'\\nread code\\nexit 0\\n".write(to:fixture,atomically:true,encoding:.utf8)
chmod(fixture.path,0o700)
let auth=try AgentManager(runtime:runtime,resolver:{_ in fixture})
let started=try auth.beginLogin("claude-code"),id=started["id"] as! String
for _ in 0..<100{if try auth.loginState(id)["url"] != nil{break};usleep(10_000)}
check((try auth.loginState(id)["url"] as? String)?.hasPrefix("https://claude.ai/")==true)
try auth.sendCode(id,code:"SYNTHETIC_CODE")
for _ in 0..<100{if try auth.loginState(id)["state"] as? String != "pending"{break};usleep(10_000)}
check(try auth.loginState(id)["state"] as? String=="finished")
let second=try auth.beginLogin("claude-code")["id"] as! String;try auth.cancelLogin(second);check(try auth.loginState(second)["state"] as? String=="cancelled")
let timeout=AgentManager.run(URL(fileURLWithPath:"/bin/sleep"),args:["5"],timeout:0.05,working:base);check(timeout.timedOut)
let fakeHome=base.appendingPathComponent("synthetic-home",isDirectory:true)
let detector=try AgentManager(runtime:runtime,home:fakeHome)
for removed in ["trae","workbuddy"] {
 do{_ = try detector.probe(removed);preconditionFailure()}catch AgentError.invalid{}
 do{try detector.save("default",choice:removed);preconditionFailure()}catch AgentError.invalid{}
}
let choices=try runtime.child("agents")
try choices.write("choices.json",data:Data("{\\"default\\":\\"workbuddy\\"}".utf8))
check(try detector.choice("default") is NSNull)
check(String(decoding:try choices.read("choices.json",maximumBytes:4096)!,as:UTF8.self).contains("workbuddy"))
let wbInvocation=CodeBuddyInvocation(executable:URL(fileURLWithPath:"/usr/bin/python3"),prefix:[base.deletingLastPathComponent().appendingPathComponent("sdk-fixture.py").path])
let wb=try CodeBuddyAdapter(runtime:runtime,home:fakeHome,invocation:{wbInvocation})
check(wb.probe()["state"] as? String=="login-required")
check(!CodeBuddyControl.authenticated(["account":["uid":"synthetic","token":["$wbEncrypted":1,"envelope":"PRIVATE"]]]))
check(!CodeBuddyControl.authenticated(["account":["uid":"synthetic","token":"{\\"$wbEncrypted\\":1}"]]))
let wbLogin=wb.beginLogin()
for _ in 0..<500{if wbLogin.snapshot()["url"] != nil{break};usleep(10_000)}
check((wbLogin.snapshot()["url"] as? String)?.hasPrefix("https://www.codebuddy.cn/login")==true)
let marker=base.deletingLastPathComponent().appendingPathComponent("wb-auth-complete")
try Data().write(to:marker)
for _ in 0..<500{if wbLogin.snapshot()["state"] as? String != "pending"{break};usleep(10_000)}
check(wbLogin.snapshot()["state"] as? String=="finished")
check(!String(describing:wbLogin.snapshot()).contains("SYNTHETIC_PRIVATE_TOKEN"))
check(wb.probe()["state"] as? String=="ready")
let already=wb.beginLogin()
for _ in 0..<500{if already.snapshot()["state"] as? String != "pending"{break};usleep(10_000)}
check(already.snapshot()["state"] as? String=="finished");check(already.snapshot()["url"]==nil)
try FileManager.default.removeItem(at:marker)
let cancelled=wb.beginLogin();cancelled.stop("cancelled");usleep(150_000);check(cancelled.snapshot()["state"] as? String=="cancelled")
check(!AgentLogin.permitsAuthURL(URL(string:"http://www.codebuddy.cn/login")!))
check(!AgentLogin.permitsAuthURL(URL(string:"https://www.codebuddy.cn:8443/login")!))
check(!AgentLogin.permitsAuthURL(URL(string:"https://www.codebuddy.cn/other")!))
check(AgentLogin.permitsAuthURL(URL(string:"https://www.codebuddy.cn/login?state=SYNTHETIC")!))
print("PASS native agent flow")
`);
  const build=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift',source,'-o',binary],{encoding:'utf8',timeout:210_000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[join(dir,'runtime')],{encoding:'utf8',timeout:45_000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS native agent flow/);
});
