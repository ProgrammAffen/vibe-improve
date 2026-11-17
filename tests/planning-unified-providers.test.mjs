import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';

test('Codex, Claude Code and CodeBuddy share prompt tasks, local references, validation and atomic generation outcomes',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
 const parent=resolve('tmp/checks/unified-planning-2026-11-04/providers');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const fixture=join(dir,'fixture.py'),validator=join(dir,'route.js'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 await build({entryPoints:['packages/domain/route-validation.mjs'],bundle:true,format:'iife',globalName:'VibeRoute',outfile:validator,target:'safari15',logLevel:'silent'});
 await writeFile(fixture,String.raw`import hashlib,json,os,sys,time,traceback
provider,mode=sys.argv[1:3]
def record_error(kind,value,trace):
 with open('fixture-error.log','a') as output:traceback.print_exception(kind,value,trace,file=output)
sys.excepthook=record_error
def emit(value):print(json.dumps(value),flush=True)
def record(value):
 with open('requests.ndjson','a') as output:output.write(json.dumps(value)+'\n')
if provider!='codex':
 assert sys.argv[sys.argv.index('--tools')+1]==''
 assert sys.argv[sys.argv.index('--model')+1]=='synthetic-model'
 if provider=='codebuddy':assert json.loads(sys.argv[sys.argv.index('--settings')+1])=={'effort':'high'}
 else:assert sys.argv[sys.argv.index('--effort')+1]=='high'
system_arg=sys.argv[sys.argv.index('--system-prompt')+1] if '--system-prompt' in sys.argv else None
def answer(text):
 if system_arg is not None:
  assert 'CONTEXT_JSON_DATA:' not in system_arg
  assert text.lstrip().startswith('CONTEXT_JSON_DATA:')
  system=system_arg
 else:system=text.split('CONTEXT_JSON_DATA:',1)[0]
 context=json.loads(text.split('CONTEXT_JSON_DATA:',1)[1]);lessons=context.get('requestedLessons')
 assert 'generation' not in context and 'routeDraft' not in context and 'messages' not in context
 stage='review' if 'TASK: review' in system else 'lessons' if lessons is not None else 'outline'
 previous=[json.loads(line) for line in open('requests.ndjson')] if os.path.exists('requests.ndjson') else []
 refs=[lesson['ref'] for lesson in lessons] if lessons is not None else []
 current={'stage':stage,'refs':refs,'repair':'repair' in context,'cwd':os.getcwd(),'systemHash':hashlib.sha256(system.strip().encode()).hexdigest()}
 record(current)
 if stage=='review':
  assert 'node_' not in json.dumps(context) and 'route_' not in json.dumps(context)
  result={'ready':True,'issues':[]};reply='The complete route is ready.'
 elif lessons is not None:
  assert 1<=len(lessons)<=3 and all(set(lesson)=={'ref','title','focus'} for lesson in lessons)
  assert 'node_' not in json.dumps(context) and 'route_' not in json.dumps(context)
  if mode=='cancel':time.sleep(5)
  if mode=='network' and refs[0]=='L1':return None,'network'
  if mode=='permission' and refs[0]=='L1':return None,'permission'
  available=[item['ref'] for item in context['availablePrerequisites']];nodes=[]
  for lesson in lessons:
   prereqs=available[-1:]
   if mode=='unknown-reference' and refs[0]=='L1':prereqs=['L99']
   nodes.append({'ref':lesson['ref'],'objectives':['Explain the named concept and solve a fresh example.'],'prerequisites':prereqs,'estimatedMinutes':20,'activities':['Work through a concrete example.','Solve a new case and explain the result.'],'assessment':None})
   available.append(lesson['ref'])
  result={'nodes':nodes};reply='Requested lessons are ready.'
 else:
  result={'title':'Synthetic tutorial','chapters':[{'title':'Foundations','stageGoal':'Explain and apply four related concepts.','lessons':[{'title':'Concept '+str(index),'focus':'Explain and practice this named concept.'} for index in range(1,5)]},{'title':'Transfer','stageGoal':'Apply the method to a new case.','lessons':[{'title':'Fresh case','focus':'Apply earlier concepts to a new case.'}]}]};reply='The fixed outline is ready.'
  if mode in ['needs_input','cannot_complete']:
   return json.dumps({'status':mode,'reply':'What specific outcome would you like to achieve?','result':None,'missing':['Confirmed learning outcome'] if mode=='needs_input' else []}),None
 envelope={'status':'ok','reply':reply,'result':result}
 if mode not in ['success','aborted_streaming']:envelope['missing']=[]
 payload=json.dumps(envelope)
 if mode=='repair-once' and refs and refs[0]=='L1' and not any(item['refs']==refs for item in previous):payload=payload[:-1]
 return payload,None
for line in sys.stdin:
 message=json.loads(line)
 if provider=='codex':
  method=message.get('method')
  if method=='initialize':emit({'id':0,'result':{}})
  elif method=='thread/start':
   params=message['params'];assert params['cwd']==os.getcwd() and params['model']=='synthetic-model'
   assert params['sandbox']=='read-only' and params['ephemeral'] is True
   system_arg=params['developerInstructions']
   emit({'id':1,'result':{'thread':{'id':'synthetic-thread'}}})
  elif method=='turn/start':
   params=message['params'];assert params['cwd']==os.getcwd() and params['model']=='synthetic-model' and params['effort']=='high'
   emit({'id':2,'result':{'turn':{'id':'synthetic-turn'}}})
   payload,error=answer(params['input'][0]['text'])
   if error=='network':emit({'method':'error','params':{'message':'network connection reset'}})
   elif error=='permission':emit({'id':70,'method':'item/tool/call','params':{}})
   else:emit({'method':'turn/completed','params':{'threadId':'synthetic-thread','turn':{'id':'synthetic-turn','status':'interrupted' if mode=='aborted_streaming' else 'completed','items':[{'type':'agentMessage','text':payload}]}}})
 else:
  if message.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':message['request_id'],'subtype':'success','response':{}}})
  elif message.get('type')=='user':
   payload,error=answer(message['message']['content'][0]['text'])
   if error=='permission':emit({'type':'control_request','request_id':'blocked','request':{'subtype':'can_use_tool'}})
   elif error=='network':emit({'type':'result','subtype':'error_during_execution','is_error':True,'result':'network connection reset'})
   else:
    emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}})
    terminal={'type':'result','subtype':'success','is_error':False,'result':payload}
    if mode=='aborted_streaming':terminal['terminal_reason']='aborted_streaming'
    emit(terminal)
   for line in sys.stdin:pass
   sys.exit(0)
`);
 await writeFile(source,`import Foundation
import Darwin
import JavaScriptCore
func check(_ value:Bool,_ message:String){if !value{fputs(message+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1]),fixture=CommandLine.arguments[2],validator=try String(contentsOfFile:CommandLine.arguments[3],encoding:.utf8)
let project="proj_12345678-1234-4234-8234-123456789abc"
func records(_ directory:URL)->[[String:Any]]{guard let text=try? String(contentsOf:directory.appendingPathComponent("requests.ndjson"),encoding:.utf8) else{return []};return text.split(separator:"\\n").compactMap{try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:Any]}}
let omitted:[String:Any]=["status":"ok","reply":"Route checked.","result":["ready":true,"issues":[]]]
func equivalent(_ left:[String:Any],_ right:[String:Any])->Bool{NSDictionary(dictionary:left).isEqual(to:right)}
func rejectsStrictly(_ envelope:[String:Any],_ task:String)->Bool{
 do{_ = try PlanningPromptPack.unwrap(envelope,task:task);return false}catch PlanningPromptPackError.invalid{return true}catch{return false}
}
for kind in ["outline","lessons","review","revision"]{
 var expected=omitted;expected["missing"]=[] as [String]
 check(equivalent(PlanningAgentManager.generationEnvelope(omitted,kind:kind),expected),"did not default exact successful generation envelope: \\(kind)")
}
for kind in ["edit","interview","consistency"]{
 check(equivalent(PlanningAgentManager.generationEnvelope(omitted,kind:kind),omitted),"defaulting escaped generation: \\(kind)")
}
let malformedEnvelopes:[[String:Any]]=[
 ["status":"ok","reply":"Route checked."],
 omitted.merging(["result":NSNull()]){_,new in new},
 omitted.merging(["result":[] as [String]]){_,new in new},
 omitted.merging(["extra":true]){_,new in new},
 omitted.merging(["missing":NSNull()]){_,new in new},
 omitted.merging(["missing":""]){_,new in new},
 omitted.merging(["missing":["Required fact"]]){_,new in new},
 ["status":"needs_input","reply":"What outcome do you want?","result":NSNull()],
 ["status":"cannot_complete","reply":"Scope unavailable.","result":NSNull()]
]
for (index,altered) in malformedEnvelopes.enumerated(){
 let result=PlanningAgentManager.generationEnvelope(altered,kind:"review")
 check(equivalent(result,altered) && rejectsStrictly(result,"review"),"defaulting repaired malformed envelope \\(index)")
}
let invalidContentFields:[[String:Any]]=[["result":["ready":false]],["reply":42]]
for invalidFields in invalidContentFields{
 let invalidContent=omitted.merging(invalidFields){_,new in new}
 check(rejectsStrictly(PlanningAgentManager.generationEnvelope(invalidContent,kind:"review"),"review"),"defaulting bypassed strict task validation")
}
var sharedOutline:String?,sharedLessons:String?,sharedReview:String?
for provider in ["codex","claude-code","codebuddy"] {
 for mode in ["success","repair-once","unknown-reference","cancel","network","permission","needs_input","cannot_complete","aborted_streaming"] {
  let directory=base.appendingPathComponent(provider+"-"+mode);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
  let runtime=try RuntimeDirectory(url:directory.appendingPathComponent("runtime")),agents=try AgentManager(runtime:runtime,projectWorkspace:{_ in directory})
  let launch=try AgentSessionLaunch(provider:provider,projectID:project,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,provider,mode]+(provider=="codex" ? []:["--tools",""]),workspace:directory,environment:ProcessInfo.processInfo.environment)
  let manager=PlanningAgentManager(agents:agents,idleTimeout:8,prepare:{_ in AgentSessionPreparation(projectID:project,provider:provider,launch:launch)})
  let context:[String:Any]=["projectId":project,"provider":provider,"locale":"en","questions":[],"messages":[],"agentOptions":["model":"synthetic-model","effort":"high"]]
  var applies=0,finalValidations=0,saved:[String:Any]?
  let validationLock=NSLock()
  let job=try manager.begin(projectID:project,intent:"generate",context:context,validateRoute:{route in
   validationLock.lock();defer{validationLock.unlock()}
   let js=JSContext()!;js.evaluateScript("Object.hasOwn = Object.hasOwn || ((o,k)=>Object.prototype.hasOwnProperty.call(o,k));");js.evaluateScript(validator);_ = js.objectForKeyedSubscript("VibeRoute")?.objectForKeyedSubscript("validateRoute")?.call(withArguments:[route])
   if js.exception != nil{throw NSError(domain:"VibeImprove.PlanningValidation",code:1,userInfo:["issues":[["path":"chapters","code":"invalid"]]])}
   if (route["chapters"] as! [[String:Any]]).count==2{finalValidations+=1}
  }){value in applies+=1;saved=value["route"] as? [String:Any];return ["saved":true]}
  let deadline=Date().addingTimeInterval(12);var result:[String:Any]=[:],cancelled=false
  while Date()<deadline {
   result=try manager.state(projectID:project,jobID:job["id"] as! String)
   if mode=="cancel",!cancelled,records(directory).contains(where:{$0["stage"] as? String=="lessons"}){try manager.cancel(projectID:project,jobID:job["id"] as! String);cancelled=true}
   if result["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.01)
  }
  let calls=records(directory),repairs=calls.filter{$0["repair"] as? Bool==true}
  check(calls.first?["stage"] as? String=="outline" && calls.allSatisfy{$0["cwd"] as? String==directory.path},"task order or project cwd changed")
  if ["success","repair-once"].contains(mode) {
   check(result["state"] as? String=="completed" && applies==1 && finalValidations==1,"unified success did not validate and apply once: "+provider+" "+mode+" "+String(describing:result))
   let progress=result["diagnostic"] as? [String:Any]
   check(result["generationPhase"] as? String=="complete" && progress?["completedLessons"] as? Int==5 && progress?["lessonCount"] as? Int==5,"completed phase or saved lesson count missing")
   let output=result["generationOutput"] as? [[String:Any]] ?? [],content=output.filter{$0["form"] as? String=="content"}
   check(output.count==(mode=="success" ? 9:10) && Set(output.compactMap{$0["sequence"] as? Int}).count==output.count,"generation segments were replaced or lost")
   check(content.count==4 && content.allSatisfy{$0["state"] as? String=="complete"},"validated outline or lesson content missing")
   let allOutput=output.compactMap{$0["text"] as? String}.joined(separator:"\\n")
   check(allOutput.contains("The fixed outline is ready.") && allOutput.contains("Concept 1") && allOutput.contains("Fresh case") && allOutput.contains("Solve a new case"),"full generation output was not retained")
   if mode=="repair-once"{check(output.contains{$0["state"] as? String=="incomplete"},"failed partial reply disappeared during correction")}

   check(calls.count==(mode=="success" ? 5:6) && repairs.count==(mode=="success" ? 0:1) && calls.last?["stage"] as? String=="review","task count or bounded repair differs by provider")
   let batches=calls.filter{$0["stage"] as? String=="lessons" && $0["repair"] as? Bool==false},coverage=batches.flatMap{$0["refs"] as! [String]}.sorted()
   check(coverage==["L1","L2","L3","L4","L5"] && batches.allSatisfy{($0["refs"] as! [String]).count<=3},"lesson coverage changed across providers")
   let route=saved!,chapters=route["chapters"] as! [[String:Any]],nodes=chapters.flatMap{$0["nodes"] as! [[String:Any]]}
   check(route["revision"] as? Int==1 && route["locale"] as? String=="en" && route["sourceLanguage"] as? String=="en","host route identity metadata missing")
   check(nodes.map{$0["id"] as! String}==["node_1_1","node_1_2","node_1_3","node_1_4","node_2_1"],"task aliases leaked into persistent IDs")
   check((nodes[4]["prerequisites"] as! [String])==["node_1_4"],"cross chapter dependency was not translated")
   if mode=="success" {
    let outline=calls[0]["systemHash"] as! String,lessons=batches[0]["systemHash"] as! String,review=calls.last!["systemHash"] as! String
    if let sharedOutline,let sharedLessons,let sharedReview{check(outline==sharedOutline && lessons==sharedLessons && review==sharedReview,"provider received different teaching rules")}else{sharedOutline=outline;sharedLessons=lessons;sharedReview=review}
   }
  }else{
   check(applies==0 && saved==nil && finalValidations==0,"partial, cancelled or invalid route applied")
   check(result["generationPhase"] as? String != "complete","failed or interrupted generation displayed as saved")
   if mode=="cancel"{check(result["generationPhase"] as? String=="lessons","cancel lost the last active stage")}
   let expected=mode=="unknown-reference" ? "PLANNING_AGENT_RESULT_REJECTED":["cancel","aborted_streaming"].contains(mode) ? "PLANNING_AGENT_CANCELLED":mode=="network" ? "PLANNING_AGENT_NETWORK":mode=="needs_input" ? "PLANNING_NEEDS_INPUT":mode=="cannot_complete" ? "PLANNING_CANNOT_COMPLETE":"PLANNING_AGENT_PERMISSION_REQUIRED"
   check(result["errorCode"] as? String==expected,"provider error outcome diverged: "+provider+" "+mode+" "+String(describing:result))
   check(repairs.count==(mode=="unknown-reference" ? 1:0),"nonformat fault retried or bad reference was not bounded")
   if ["needs_input","cannot_complete"].contains(mode){
    check(result["state"] as? String=="failed" && result["userReply"] as? String=="What specific outcome would you like to achieve?","business outcome lost its concrete user reply")
    check(calls.count==1 && result["result"]==nil && result["partialReply"]==nil,"business outcome was retried, partially applied or displayed as an unfinished successful reply")
   }
   if mode=="aborted_streaming"{check(calls.count==1 && result["state"] as? String != "completed" && result["result"]==nil,"aborted success-shaped terminal was retried or accepted")}
  }
  manager.shutdown();print("PASS unified "+provider+" "+mode+" applies="+String(applies))
 }
}
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:200_000});
 await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'data'),fixture,validator],{encoding:'utf8',timeout:60_000});
 await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr+run.stdout);assert.match(run.stdout,/PASS unified codebuddy aborted_streaming applies=0/);
 console.log('Unified provider evidence: '+dir);
});
