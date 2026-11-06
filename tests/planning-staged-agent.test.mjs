import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';

test('shared generation batches preserve chapters and apply once after bounded retries and complete validation',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
 const parent=resolve('tmp/checks/unified-planning-2026-11-04/staged');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const fixture=join(dir,'fixture.py'),validator=join(dir,'route.js'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 await build({entryPoints:['packages/domain/route-validation.mjs'],bundle:true,format:'iife',globalName:'VibeRoute',outfile:validator,target:'safari15',logLevel:'silent'});
 await writeFile(fixture,String.raw`import json,os,sys,time
mode=sys.argv[1]
def event(value):
 with open('events.ndjson','a') as output:output.write(json.dumps({**value,'at':time.time(),'pid':os.getpid()})+'\n')
assert '--json-schema' not in sys.argv
assert sys.argv[sys.argv.index('--tools')+1]==''
assert sys.argv[sys.argv.index('--model')+1]=='synthetic-model'
assert json.loads(sys.argv[sys.argv.index('--settings')+1])=={'effort':'high'}
system=sys.argv[sys.argv.index('--system-prompt')+1]
assert 'learning-route planner' in system and 'CONTEXT_JSON_DATA:' not in system
def emit(value):print(json.dumps(value),flush=True)
for line in sys.stdin:
 message=json.loads(line)
 if message.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':message['request_id'],'subtype':'success','response':{}}})
 elif message.get('type')=='user':
  text=message['message']['content'][0]['text'];assert text.lstrip().startswith('CONTEXT_JSON_DATA:') and 'learning-route planner' not in text
  context=json.loads(text.split('CONTEXT_JSON_DATA:',1)[1]);generation=context if 'requestedLessons' in context else None
  previous=[json.loads(line) for line in open('requests.ndjson')] if os.path.exists('requests.ndjson') else []
  record={'stage':'chapter' if generation else 'outline','cwd':os.getcwd(),'repair':'repair' in context}
  if generation:
   lessons=generation['requestedLessons'];assert 1<=len(lessons)<=3
   record.update({'chapter':{'Foundations':'ch_1','Application':'ch_2','Transfer':'ch_3'}[generation['currentChapter']['title']],'ids':[n['ref'] for n in lessons],'available':[n['ref'] for n in generation['availablePrerequisites']]})
   assert 'node_' not in json.dumps(generation) and all(n['ref'].startswith('L') for n in lessons)
  with open('requests.ndjson','a') as output:output.write(json.dumps(record)+'\n')
  event({**record,'event':'start'})
  first_batch=generation and record['chapter']=='ch_1' and lessons[0]['ref']=='L1'
  attempt=sum(p.get('ids')==record.get('ids') and p.get('chapter')==record.get('chapter') for p in previous)
  if mode=='deadline':time.sleep(.6)
  elif generation:
   if mode=='cancel' or mode in ['bad-twice','network','auth'] and record['chapter']=='ch_2':time.sleep(10)
   else:time.sleep(.25 if record['chapter']=='ch_1' else .55)
  if mode in ['network','auth'] and generation and record['chapter']=='ch_1':
   emit({'type':'result','subtype':'error_during_execution','is_error':True,'result':'network connection reset' if mode=='network' else 'authentication required'})
  else:
   if not generation:
    value={'reply':'Synthetic outline ready.','title':'Synthetic tutorial','chapters':[{'title':'Foundations','stageGoal':'Apply five named concepts.','lessons':[{'title':'Concept '+str(i),'focus':'Study a worked example, practice and explain the result.'} for i in range(1,6)]},{'title':'Application','stageGoal':'Apply two combined techniques.','lessons':[{'title':'Task '+str(i),'focus':'Apply the learned concepts independently.'} for i in range(1,3)]},{'title':'Transfer','stageGoal':'Transfer the method to a fresh case.','lessons':[{'title':'New case','focus':'Solve an unfamiliar case.'}]}]}
   else:
    nodes=[];available=[n['ref'] for n in generation['availablePrerequisites']]
    for lesson in lessons:
     nodes.append({'ref':lesson['ref'],'objectives':['Explain the named example and complete the practice.'],'prerequisites':available[-1:],'estimatedMinutes':30,'activities':['Read the worked example.','Solve a different case and compare the result.'],'assessment':None});available.append(lesson['ref'])
    value={'reply':'Batch complete.','nodes':nodes}
    if mode=='domain-once' and first_batch and attempt==0:value['nodes'][0]['estimatedMinutes']=0
   reply=value.pop('reply');value={'status':'ok','reply':reply,'result':value,'missing':[]}
   payload=json.dumps(value)
   if first_batch and (mode=='bad-twice' or mode=='bad-once' and attempt==0):payload=payload[:-1]
   emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}})
   emit({'type':'result','subtype':'success','is_error':False,'result':payload})
  event({**record,'event':'end'})
  for line in sys.stdin:pass
  sys.exit(0)
`);
 await writeFile(source,`import Foundation
import Darwin
import JavaScriptCore
func check(_ value:Bool,_ note:String){if !value{fputs(note+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),fixture=CommandLine.arguments[2],code=try String(contentsOfFile:CommandLine.arguments[3],encoding:.utf8)
let id="proj_12345678-1234-4234-8234-123456789abc"
func records(_ directory:URL,_ file:String="requests.ndjson")->[[String:Any]]{
 guard let text=try? String(contentsOf:directory.appendingPathComponent(file),encoding:.utf8) else{return []}
 return text.split(separator:"\\n").compactMap{try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:Any]}
}
for mode in ["success","bad-once","bad-twice","domain-once","network","auth","cancel","deadline"] {
 let directory=base.appendingPathComponent(mode,isDirectory:true);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
 let runtime=try RuntimeDirectory(url:directory.appendingPathComponent("runtime")),agent=try AgentManager(runtime:runtime,projectWorkspace:{_ in directory})
 let launch=try AgentSessionLaunch(provider:"codebuddy",projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,mode,"--tools",""],workspace:directory,environment:ProcessInfo.processInfo.environment)
 let manager=PlanningAgentManager(agents:agent,timeout:mode=="deadline" ? 1.5:8,prepare:{_ in AgentSessionPreparation(projectID:id,provider:"codebuddy",launch:launch)})
 let context:[String:Any]=["projectId":id,"provider":"codebuddy","locale":"en","questions":[],"messages":[],"agentOptions":["model":"synthetic-model","effort":"high"]]
 var applies=0,checkedCounts:[Int]=[],saved:[String:Any]?;let validationLock=NSLock()
 let validate:([String:Any])throws->Void={route in
  validationLock.lock();defer{validationLock.unlock()}
  let chapters=route["chapters"] as! [[String:Any]],nodes=chapters.flatMap{$0["nodes"] as! [[String:Any]]},count=nodes.count;checkedCounts.append(count)
  if chapters.count==1{check(nodes.allSatisfy{($0["prerequisites"] as! [String]).isEmpty},"batch schema check unexpectedly has unresolved prerequisites")}else{check(count==8 && nodes.dropFirst().allSatisfy{!($0["prerequisites"] as! [String]).isEmpty},"final graph lost prerequisites")}
  let js=JSContext()!;js.evaluateScript("Object.hasOwn = Object.hasOwn || ((o,k)=>Object.prototype.hasOwnProperty.call(o,k));");js.evaluateScript(code)
  check(js.exception==nil,"validator failed to load")
  _ = js.objectForKeyedSubscript("VibeRoute")?.objectForKeyedSubscript("validateRoute")?.call(withArguments:[route])
  if js.exception != nil{throw NSError(domain:"VibeImprove.PlanningValidation",code:1,userInfo:["issues":[["path":"chapters.0.nodes.0.estimatedMinutes","code":"invalid"]]])}
 }
 let job=try manager.begin(projectID:id,intent:"generate",context:context,validateRoute:validate){value in
  applies+=1;saved=value["route"] as? [String:Any];return ["saved":true]
 }
 let jobID=job["id"] as! String,deadline=Date().addingTimeInterval(12);var result:[String:Any]=[:],didCancel=false
 while Date()<deadline {
  result=try manager.state(projectID:id,jobID:jobID)
  if mode=="cancel",!didCancel,records(directory).count>=3{try manager.cancel(projectID:id,jobID:jobID);didCancel=true}
  if result["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.01)
 }
 let calls=records(directory)
 for call in calls{check(call["cwd"] as? String==directory.path,"cwd changed");if let ids=call["ids"] as? [String]{check(ids.count<=3,"batch exceeded three")}}
 if ["success","bad-once","domain-once"].contains(mode) {
  check(result["state"] as? String=="completed" && applies==1,mode+" did not apply once: "+String(describing:result))
  let chapters=saved!["chapters"] as! [[String:Any]]
  check(chapters.count==3 && (chapters[0]["nodes"] as! [[String:Any]]).count==5 && (chapters[1]["nodes"] as! [[String:Any]]).count==2 && (chapters[2]["nodes"] as! [[String:Any]]).count==1,"batching changed chapter boundaries")
  check(chapters.map{$0["title"] as! String}==["Foundations","Application","Transfer"],"chapter order changed")
  check(checkedCounts.sorted()==[1,2,3,5,8] && checkedCounts.last==8,"cumulative validation missing: "+String(describing:checkedCounts))
  check(calls.count==(mode=="success" ? 5:6),"wrong successful request count")
  check(calls.filter{$0["repair"] as? Bool==true}.count==(mode=="success" ? 0:1),"repair must be bounded and local")
  let second=calls.first{$0["chapter"] as? String=="ch_2"}!;check(second["available"] as? [String]==["L1","L2","L3","L4","L5"],"planned prerequisite references missing before prior chapter completes")
  let events=records(directory,"events.ndjson").filter{$0["stage"] as? String=="chapter"}.sorted{($0["at"] as! Double)<($1["at"] as! Double)}
  var active=Set<String>(),peak=0
  for event in events{let ch=event["chapter"] as! String;if event["event"] as? String=="start"{check(!active.contains(ch),"same chapter batches overlap");active.insert(ch);peak=max(peak,active.count)}else{active.remove(ch)}}
  check(peak==2 && active.isEmpty,"chapter concurrency was not bounded to two")
  let firstEnd=events.first{$0["chapter"] as? String=="ch_1" && $0["event"] as? String=="end"}!["at"] as! Double,secondStart=events.first{$0["chapter"] as? String=="ch_2" && $0["event"] as? String=="start"}!["at"] as! Double
  check(secondStart<firstEnd,"later chapter waited for previous chapter output")
 }else{
  check(applies==0 && saved==nil,"partial generation applied")
  let expected=mode=="bad-twice" ? "PLANNING_AGENT_ROUTE_ENCODING":mode=="network" ? "PLANNING_AGENT_NETWORK":mode=="auth" ? "PLANNING_AGENT_AUTH_REQUIRED":mode=="cancel" ? "PLANNING_AGENT_CANCELLED":"PLANNING_AGENT_TIMEOUT"
  check(result["errorCode"] as? String==expected,mode+" wrong failure: "+String(describing:result))
  if mode=="bad-twice"{check(calls.count==4 && calls.filter{$0["repair"] as? Bool==true}.count==1,"invalid batch retried more than once")}
  if ["network","auth","cancel"].contains(mode){check(calls.count==3 && calls.allSatisfy{$0["repair"] as? Bool==false},"nonformat failure retried")}
  if mode=="deadline"{let d=result["diagnostic"] as! [String:Any];check((d["durationMs"] as! Int)<2400 && calls.count>=2,"total deadline reset between batches")}
  let processIDs=Set(records(directory,"events.ndjson").compactMap{$0["pid"] as? Int32}),exitDeadline=Date().addingTimeInterval(2)
  while processIDs.contains(where:{kill($0,0)==0}) && Date()<exitDeadline{Thread.sleep(forTimeInterval:0.02)}
  check(processIDs.allSatisfy{kill($0,0) != 0},"failed group left a CLI process running")
 }
 manager.shutdown()
 print("PASS staged "+mode+" requests="+String(calls.count)+" validations="+String(describing:checkedCounts)+" applies="+String(applies))
}
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:200_000});
 await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'data'),fixture,validator],{encoding:'utf8',timeout:60_000});
 await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS staged deadline/);
 console.log('Staged evidence: '+dir);
});
