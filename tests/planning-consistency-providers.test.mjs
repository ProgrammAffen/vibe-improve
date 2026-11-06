import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('three provider protocols share adopted snapshots, consistency outcomes, bounded repair and late generation review',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
 const parent=resolve('tmp/checks/answer-consistency-2026-11-04/providers');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const fixture=join(dir,'fixture.py'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 await writeFile(fixture,String.raw`import hashlib,json,os,sys,time,traceback
provider,mode=sys.argv[1:3]
def record_error(kind,value,trace):
 with open('fixture-error.log','a') as output:traceback.print_exception(kind,value,trace,file=output)
sys.excepthook=record_error
def emit(value):print(json.dumps(value),flush=True)
def record(value):
 with open('requests.ndjson','a') as output:output.write(json.dumps(value)+'\n')
system_arg=sys.argv[sys.argv.index('--system-prompt')+1] if '--system-prompt' in sys.argv else None
if provider!='codex':
 assert sys.argv[sys.argv.index('--tools')+1]==''
 assert sys.argv[sys.argv.index('--model')+1]=='synthetic-model'
 if provider=='codebuddy':assert json.loads(sys.argv[sys.argv.index('--settings')+1])=={'effort':'high'}
 else:assert sys.argv[sys.argv.index('--effort')+1]=='high'
def conflict(question='purpose'):
 return {'status':'requires_review','issues':[{'questionId':question,'fields':['experience'] if question=='baseline' else ['criteria'],'kind':'incompatible','reason':'SYNTHETIC_BAD_REFERENCE' if question=='baseline' else 'The adopted success criteria still describe image classification while the new goal is text generation.','suggestion':None if question=='baseline' else {'summary':'Review generated text and observed training behavior.','fields':{'criteria':'Show generated samples and explain training/validation loss trends and limitations.'}}}]}
def envelope(result,reply='Review the consistency result.'):
 return json.dumps({'status':'ok','reply':reply,'result':result,'missing':[]})
def answer(text):
 assert system_arg is not None and 'CONTEXT_JSON_DATA:' not in system_arg
 assert text.startswith('\nCONTEXT_JSON_DATA:\n') and 'learning-route planner' not in text
 context=json.loads(text.split('\nCONTEXT_JSON_DATA:\n',1)[1])
 task=next(task for task in ['interview','consistency','outline','lessons'] if 'TASK: '+task+'\n' in system_arg)
 assert 'DRAFT_DO_NOT_SEND' not in json.dumps(context)
 assert 'PRIVATE_' not in json.dumps(context) and 'private_original_user' not in json.dumps(context)
 assert 'SYNTHETIC_BAD_REFERENCE' not in system_arg
 facts=context.get('acceptedAnswers',context.get('confirmedBackground'))
 assert facts['purpose']['fields']['criteria'].startswith('ADOPTED_')
 assert 'revision' not in json.dumps(facts) and 'evidence' not in json.dumps(facts)
 assert 'routeDraft' not in context and 'projectId' not in context
 record({'task':task,'repair':'repair' in context,'refs':[item['ref'] for item in context.get('requestedLessons',[])],'systemHash':hashlib.sha256(system_arg.encode()).hexdigest(),'facts':facts})
 if task=='consistency':
  assert context['anchorQuestionId']=='goal' and 'messages' not in context
  if mode=='consistent':return envelope({'status':'consistent','issues':[]})
  if mode in ['unknown-target','repair-once'] and (mode=='unknown-target' or 'repair' not in context):return envelope(conflict('baseline'))
  if 'repair' in context:
   candidate=json.loads(context['repair']['candidate']);assert candidate['result']['issues'][0]['questionId']=='baseline'
   assert context['repair']['issues']==[{'path':'result','code':'invalid'}]
  return envelope(conflict())
 if task=='interview':
  assert context['currentQuestion']=='goal' and context['acceptedAnswer']['fields']['topic']=='ADOPTED_IMAGE_TOPIC'
  assert context['messages']==[{'ref':'U1','role':'user','text':'I now want to train a character-level language model on my text.'}]
  assert context['currentFields']=={}
  fields={'topic':'Character-level language models','outcome':'Train on my text and explain generated samples'}
  return envelope({'questionId':'goal','complete':True,'summary':'Train a character-level language model on my text.','fields':fields,'evidence':[{'field':field,'messageRef':'U1','proposalRef':None,'quote':'The user explicitly changed the goal.'} for field in fields],'unresolved':[],'consistency':conflict()},'Please review the new goal and the affected success criteria.')
 if mode=='late-outline' or task=='lessons' and context['requestedLessons'][0]['ref']=='L1':
  return json.dumps({'status':'needs_input','reply':'Review the success criteria before generating the route.','result':None,'missing':['Success criteria need to match the adopted goal'],'consistency':conflict()})
 if task=='outline':
  return envelope({'title':'Synthetic small text model','chapters':[{'title':'Encoding','stageGoal':'Trace a character encoding example.','lessons':[{'title':'Encode text','focus':'Map a small text sample to character indices and back.'}]},{'title':'Prediction','stageGoal':'Explain a next-character prediction.','lessons':[{'title':'Inspect predictions','focus':'Trace the predicted scores for a short sequence.'}]}]},'Outline ready.')
 time.sleep(.15)
 return envelope({'nodes':[{'ref':item['ref'],'objectives':['Trace the named operation in a small text example.'],'prerequisites':[],'estimatedMinutes':20,'activities':['Trace a worked example, attempt a new example, and correct discrepancies.'],'assessment':None} for item in context['requestedLessons']]},'Batch ready.')
for line in sys.stdin:
 message=json.loads(line)
 if provider=='codex':
  method=message.get('method')
  if method=='initialize':emit({'id':0,'result':{}})
  elif method=='thread/start':
   params=message['params'];assert params['cwd']==os.getcwd() and params['model']=='synthetic-model'
   assert params['sandbox']=='read-only' and params['ephemeral'] is True
   system_arg=params['developerInstructions'];emit({'id':1,'result':{'thread':{'id':'consistency-thread'}}})
  elif method=='turn/start':
   params=message['params'];assert params['cwd']==os.getcwd() and params['effort']=='high' and params['model']=='synthetic-model'
   emit({'id':2,'result':{'turn':{'id':'consistency-turn'}}})
   payload=answer(params['input'][0]['text'])
   emit({'method':'turn/completed','params':{'threadId':'consistency-thread','turn':{'id':'consistency-turn','status':'completed','items':[{'type':'agentMessage','text':payload}]}}})
 else:
  if message.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':message['request_id'],'subtype':'success','response':{}}})
  elif message.get('type')=='user':
   payload=answer(message['message']['content'][0]['text'])
   emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}})
   emit({'type':'result','subtype':'success','is_error':False,'result':payload})
   for line in sys.stdin:pass
   sys.exit(0)
`);
 await writeFile(source,String.raw`import Foundation
import Darwin
func check(_ value:Bool,_ message:String){if !value{fputs(message+"\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1]),fixture=CommandLine.arguments[2],project="proj_12345678-1234-4234-8234-123456789abc"
func records(_ directory:URL)->[[String:Any]]{guard let text=try? String(contentsOf:directory.appendingPathComponent("requests.ndjson"),encoding:.utf8) else{return []};return text.split(separator:"\n").compactMap{try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:Any]}}
let acceptedFields:[String:[String:String]]=["goal":["topic":"ADOPTED_TEXT_TOPIC","outcome":"ADOPTED_TEXT_OUTCOME"],"purpose":["context":"ADOPTED_PERSONAL_CONTEXT","criteria":"ADOPTED_IMAGE_CRITERIA"],"baseline":["experience":"ADOPTED_REAL_IMAGE_HISTORY"],"time":["weekly":"Five hours","session":"One hour"],"constraints":["conditions":"CPU laptop","scope":"Small local experiments"]]
var systemHashes:[String:String]=[:]
for provider in ["codex","claude-code","codebuddy"] {
 for mode in ["consistent","requires-review","unknown-target","repair-once","interview-conflict","late-outline","late-lessons"] {
  let directory=base.appendingPathComponent(provider+"-"+mode);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
  let runtime=try RuntimeDirectory(url:directory.appendingPathComponent("runtime")),agents=try AgentManager(runtime:runtime,projectWorkspace:{_ in directory})
  let launch=try AgentSessionLaunch(provider:provider,projectID:project,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,provider,mode]+(provider=="codex" ? []:["--tools",""]),workspace:directory,environment:ProcessInfo.processInfo.environment)
  let manager=PlanningAgentManager(agents:agents,timeout:8,prepare:{_ in AgentSessionPreparation(projectID:project,provider:provider,launch:launch)})
  let intent=mode=="interview-conflict" ? "interview":mode.hasPrefix("late-") ? "generate":"consistency"
  var questions:[[String:Any]]=[]
  for id in ["goal","purpose","baseline","time","constraints"] {
   var adopted=acceptedFields[id]!
   if intent=="interview",id=="goal"{adopted=["topic":"ADOPTED_IMAGE_TOPIC","outcome":"ADOPTED_IMAGE_OUTCOME"]}
   if mode=="consistent",id=="purpose"{adopted["criteria"]="ADOPTED_TEXT_CRITERIA"}
   let draft=Dictionary(uniqueKeysWithValues:adopted.keys.map{($0,"DRAFT_DO_NOT_SEND")})
   var question:[String:Any]=["id":id,"status":intent=="interview" && id=="goal" ? "current":"complete","summary":"DRAFT_DO_NOT_SEND","fields":draft,"missing":[],"acceptedSnapshot":["revision":2,"summary":"Adopted "+id,"fields":adopted,"evidence":["PRIVATE_SNAPSHOT_EVIDENCE"]]]
   if ["unknown-target","repair-once"].contains(mode),id=="baseline"{question["status"]="pending";question.removeValue(forKey:"acceptedSnapshot")}
   if intent=="interview",id=="goal"{question["fields"]=[String:String]();question["summary"]="";question["conversationFrom"]=0}
   questions.append(question)
  }
  let messages:[[String:Any]]=intent=="interview" ? [["id":"private_original_user","role":"user","questionId":"goal","text":"I now want to train a character-level language model on my text."]]:[]
  let oldRoute:[String:Any]=["id":"PRESERVED_OLD_ROUTE","chapters":[["title":"PRESERVED_OLD_CHAPTER"]]]
  let context:[String:Any]=["projectId":project,"provider":provider,"locale":"en","currentQuestion":"goal","questions":questions,"messages":messages,"routeDraft":oldRoute,"consistency":["anchorQuestionId":"goal","anchorRevision":2,"factsHash":"PRIVATE_FACT_HASH","epoch":7],"agentOptions":["model":"synthetic-model","effort":"high"]]
  var commits=0,replacements=0,savedRoute=oldRoute,payload:[String:Any]?
  let job=try manager.begin(projectID:project,intent:intent,context:context){result in
   commits+=1;payload=result
   if let route=result["route"] as? [String:Any]{replacements+=1;savedRoute=route}
   return ["committed":true]
  }
  let deadline=Date().addingTimeInterval(12);var final:[String:Any]=[:]
  while Date()<deadline {
   final=try manager.state(projectID:project,jobID:job["id"] as! String)
   if final["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.01)
  }
  let calls=records(directory),repairs=calls.filter{$0["repair"] as? Bool==true}
  let fixtureError=(try? String(contentsOf:directory.appendingPathComponent("fixture-error.log"),encoding:.utf8)) ?? ""
  check(fixtureError.isEmpty,"fixture failed "+provider+" "+mode+" "+fixtureError)
  check(!calls.isEmpty,"provider received no task "+provider+" "+mode)
  for call in calls where call["repair"] as? Bool==false {
   let task=call["task"] as! String,hash=call["systemHash"] as! String
   if let prior=systemHashes[task]{check(hash==prior,"provider or mode changed the fixed system for "+task)}else{systemHashes[task]=hash}
  }
  if mode=="unknown-target" {
   check(final["state"] as? String=="failed" && final["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED","unknown adopted target was accepted: "+provider+" "+String(describing:final))
   check(commits==0 && calls.count==2 && repairs.count==1,"unknown target escaped one-repair budget")
  }else {
   check(final["state"] as? String=="completed" && commits==1,"valid consistency flow did not commit exactly once: "+provider+" "+mode+" "+String(describing:final))
   if mode.hasPrefix("late-") {
    check(payload?["generationBlocked"] as? Bool==true && payload?["route"]==nil,"late conflict was treated as a route")
    check((payload?["consistency"] as? [String:Any])?["status"] as? String=="requires_review","late conflict lost structured review")
    check(replacements==0 && savedRoute["id"] as? String=="PRESERVED_OLD_ROUTE","blocked generation replaced old route")
    check(repairs.isEmpty,"business conflict triggered repair")
    if mode=="late-outline"{check(calls.count==1 && calls[0]["task"] as? String=="outline","late outline continued into lessons")}
    else{check(calls.first?["task"] as? String=="outline" && calls.contains{$0["task"] as? String=="lessons"},"late lesson fixture never expanded lessons")}
   }else if mode=="interview-conflict" {
    check((payload?["consistency"] as? [String:Any])?["status"] as? String=="requires_review","interview lost same-call consistency")
    let update=(payload?["updates"] as! [[String:Any]])[0],evidence=update["evidence"] as! [[String:Any]]
    check(update["id"] as? String=="goal" && update["complete"] as? Bool==true && evidence.count==2 && evidence.allSatisfy{$0["messageId"] as? String=="private_original_user"},"interview aliases did not map to actual supporting user")
    check(calls.count==1 && repairs.isEmpty,"same-call interview assessment made an extra model request")
   }else {
    check((payload?["consistency"] as? [String:Any])?["status"] as? String==(mode=="consistent" ? "consistent":"requires_review"),"preflight outcome changed")
    check(calls.count==(mode=="repair-once" ? 2:1) && repairs.count==(mode=="repair-once" ? 1:0),"preflight retry count changed")
   }
  }
  let diagnostic=final["diagnostic"] as? [String:Any] ?? [:],diagnosticText=String(describing:diagnostic)
  for marker in ["PRIVATE_","DRAFT_DO_NOT_SEND","SYNTHETIC_BAD_REFERENCE","ADOPTED_"]{check(!diagnosticText.contains(marker),"fact or candidate leaked into diagnostics")}
  manager.shutdown();print("PASS consistency "+provider+" "+mode+" commits="+String(commits))
 }
}
check(Set(systemHashes.keys)==Set(["consistency","interview","outline","lessons"]),"not all consistency-related shared task systems were compared")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:180_000});
 await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'data'),fixture],{encoding:'utf8',timeout:75_000});
 await writeFile(join(dir,'run.log'),run.stdout+run.stderr);
 if(run.status!==0){
  const errors=[];for(const provider of ['codex','claude-code','codebuddy'])for(const mode of ['consistent','requires-review','unknown-target','repair-once','interview-conflict','late-outline','late-lessons']){
   try{errors.push(await readFile(join(dir,'data',provider+'-'+mode,'fixture-error.log'),'utf8'))}catch{}
  }
  assert.fail(run.stderr+run.stdout+errors.join('\n'));
 }
 assert.match(run.stdout,/PASS consistency codebuddy late-lessons commits=1/);
 console.log('Consistency provider evidence: '+dir);
});
