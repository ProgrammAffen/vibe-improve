import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const streamAssertions=String.raw`let samples:[(String,String)]=[
 (#"{"reply":"你好，世界！","route":null}"#,"你好，世界！"),
 (#"{"reply":"line\nquote \"yes\" and \\path","route":null}"#,"line\nquote \"yes\" and \\path"),
 (#"{"reply":"face \uD83D\uDE00 and \u4F60\u597D","updates":[]}"#,"face 😀 and 你好"),
 (#"{"route":{"title":"nested reply","reply":"DO NOT SHOW","chapters":[{}]},"reply":"Visible reply"}"#,"Visible reply"),
 (#"{"route":[1,true,null,"quote \\\""],"\u0072eply":"Root reply"}"#,"Root reply")
]
for (wire,expected) in samples {
 for chunk in [1,2,5,21,300] {
  let chars=Array(wire);var stream=PlanningReplyStream(),partial=""
  for start in stride(from:0,to:chars.count,by:chunk) {
   partial=stream.append(String(chars[start..<min(start+chunk,chars.count)]))
   check(expected.hasPrefix(partial),"invalid prefix or JSON leak: "+partial)
  }
  check(partial==expected,"incomplete reply: "+partial)
 }
}
for wire in [#"LOG {"reply":"HIDDEN"}"#,#"{"route":{"reply":"HIDDEN"}}"#,#"{"thinking":"HIDDEN","updates":[]}"#,#"[ {"reply":"HIDDEN"} ]"#,#"{"reply":null}"#] {
 var stream=PlanningReplyStream();check(stream.append(wire)=="","non-reply leaked")
}
var large=PlanningReplyStream();check(large.append("{\"reply\":\""+String(repeating:"a",count:8001)+"\"}")=="","reply budget missing")
var bounded=PlanningReplyStream();check(bounded.append(String(repeating:"x",count:1024*1024+1))=="","prefix budget missing")
`;

test('planning jobs accept only successful protocol finals, reject tools and malformed output, and cannot commit cancelled work',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
  const parent=resolve('tmp/checks/unified-planning-2026-11-04/planning-agent');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
  const fixture=join(dir,'fixture.py');
  await writeFile(fixture,String.raw`import json,os,sys,time
mode=sys.argv[1]
provider=sys.argv[2]
if mode.startswith('options') and provider!='codex':
 assert sys.argv[sys.argv.index('--model')+1]=='synthetic-model'
 if provider=='claude-code':assert sys.argv[sys.argv.index('--effort')+1]=='high'
 else:assert json.loads(sys.argv[sys.argv.index('--settings')+1])['effort']=='high'
context={}
system=''
def envelope(result,reply='What is your target?'):return {'status':'ok','reply':reply,'result':result,'missing':[]}
def interview():return envelope({'questionId':'goal','complete':False,'summary':'','fields':{},'evidence':[],'unresolved':['What useful task would you like to complete?']})
payload=json.dumps(interview())
def emit(value):print(json.dumps(value),flush=True)
def respond():
 global payload
 if provider!='codex':
  assert '--include-partial-messages' in sys.argv
  assert '--json-schema' not in sys.argv
  if provider=='codebuddy':assert sys.argv[sys.argv.index('--tools')+1]==''
 assert 'learning-route planner' in system and 'CONTEXT_JSON_DATA:' not in system and 'Learn Python' not in system
 task='outline' if 'TASK: outline' in system else 'lessons' if 'TASK: lessons' in system else 'edit' if 'TASK: edit' in system else 'interview'
 if task=='interview':
  assert context['currentQuestion']=='goal' and context['messages'][0]['ref']=='U1'
  assert 'id' not in context['messages'][0] and 'questions' not in context
  payload=json.dumps(interview())
 elif task=='outline':
  assert 'messages' not in context and 'routeDraft' not in context
  payload=json.dumps(envelope({'title':'Synthetic route','chapters':[{'title':'Concepts','stageGoal':'Explain and apply a small example.','lessons':[{'title':'First concept','focus':'Trace and apply the named concept in a small example.'}]}]},'Outline ready'))
 elif task=='lessons':
  payload=json.dumps(envelope({'nodes':[{'ref':lesson['ref'],'objectives':['Explain the named concept using a small independent example.'],'prerequisites':[],'estimatedMinutes':30,'activities':['Study the example, trace its operations, then attempt independently and correct discrepancies.'],'assessment':None} for lesson in context['requestedLessons']]},'Batch ready'))
 if mode in ['stream','stream-large','stream-idle','stream-heartbeat','stream-tools','stream-no-final','stream-activity','stream-deadline']:
  emit({'type':'stream_event','event':{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','name':'Bash'} if mode=='stream-tools' else {'type':'text'}}})
  for i in range(80 if mode=='stream-activity' else 40 if mode=='stream-deadline' else 8 if mode!='stream-large' else 30):
   time.sleep(.005 if mode in ['stream-large','stream-activity'] else .06)
   emit({'type':'system'} if mode=='stream-heartbeat' else {'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'x'*(75000 if mode=='stream-large' else 5)}}})
   if mode=='stream-activity':emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'thinking_delta','thinking':'SENSITIVE_REASONING'}}})
   if mode=='stream-idle':time.sleep(1)
  if mode=='stream-no-final':sys.exit(0)
 if mode=='slow':
  open('slow-started','w').write('synthetic')
  time.sleep(.6)
 if mode=='duplicate':payload='{"reply":"one","reply":"two","updates":[]}'
 if mode=='mixed':payload='INFO: completed\n'+payload
 if mode=='stderr':
  print(payload,file=sys.stderr,flush=True);sys.exit(1)
 if mode=='large':payload='x'*2200000
 if mode=='chat':payload=json.dumps({'reply':'The first chapter prepares data; the second presents results.','route':None})
 if mode in ['reply-only','failed']:payload=json.dumps({'reply':'What would you like to know about the route?'})
 if mode=='bad-edit':payload=json.dumps({'reply':'Answer','route':[]})
 if mode.startswith('encoded-'):
  route={'format':'vibe-improve.route','schemaVersion':2,'id':'synthetic-route','revision':1,'title':'Synthetic route','locale':'en','sourceLanguage':'en','chapters':[{'id':'ch-one','title':'Concepts','stageGoal':'Explain and apply a small example.','nodes':[{'id':'lesson-one','title':'First concept','objectives':[{'id':'objective-one','description':'Explain the example.'}],'prerequisites':[],'estimatedMinutes':30}]}]}
  encoded=json.dumps(route)
  if mode=='encoded-duplicate':encoded='{"format":"vibe-improve.route","format":"vibe-improve.route"}'
  if mode=='encoded-truncated':encoded=encoded[:-1]
  if mode=='encoded-prose':encoded='Here is the route: '+encoded
  if mode=='encoded-trailing':encoded+=' trailing'
  if mode=='encoded-nested':encoded=json.dumps(encoded)
  if mode=='encoded-array':encoded='[]'
  if mode=='encoded-depth':encoded='{"nested":'*50+'{}'+'}'*50
  if mode=='encoded-shape':encoded='{"format":"vibe-improve.route","schemaVersion":2,"chapters":"SENSITIVE_ROUTE"}'
  if mode=='encoded-domain':route['chapters'][0]['nodes'][0]['prerequisites']=['missing'];encoded=json.dumps(route)
  payload=json.dumps({'reply':'Summary','route':encoded})
 if mode.startswith('preview'):
  payload=json.dumps({'reply':'Streaming reply arrives before completion.','route':None})
  if provider!='codex':emit({'type':'stream_event','event':{'type':'content_block_start','index':0,'content_block':{'type':'text'}}})
  for offset in range(0,len(payload),5):
   part=payload[offset:offset+5]
   if provider=='codex':emit({'method':'item/agentMessage/delta','params':{'threadId':'thread-1','turnId':'turn-1','itemId':'item-stream','delta':part}})
   else:emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':part}}})
   time.sleep(.04)
  time.sleep(.2)
  if mode=='preview-reset-failed':
   emit({'type':'stream_event','event':{'type':'content_block_start','index':2,'content_block':{'type':'text'}}});sys.exit(1)
  if mode=='preview-failed':sys.exit(1)
 if provider=='codex':
  if mode=='permission':emit({'id':55,'method':'item/commandExecution/requestApproval','params':{}});return
  if mode in ['network','auth','quota']:
   emit({'method':'error','params':{'message':{'network':'network connection reset','auth':'authentication required','quota':'quota exceeded'}[mode]}});return
  emit({'method':'item/completed','params':{'threadId':'thread-1','turnId':'turn-1','item':{'type':'agentMessage','id':'item-1','text':payload}}})
  emit({'method':'turn/completed','params':{'threadId':'thread-1','turn':{'id':'turn-1','status':'failed' if mode=='failed' else 'completed','items':[]}}})
 else:
  if mode=='permission':emit({'type':'control_request','request_id':'tool','request':{'subtype':'can_use_tool'}});return
  if mode=='forbidden-result-tool':emit({'type':'assistant','message':{'content':[{'type':'tool_use','name':'StructuredOutput','input':{'reply':'Not permitted','route':None}}]}});return
  emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}})
  failures=['failed','encoded-failed','encoded-network']
  emit({'type':'result','subtype':'error_during_execution' if mode in failures else 'success','is_error':mode in failures,'result':'network connection reset' if mode=='encoded-network' else payload})
  for line in sys.stdin:pass
  sys.exit(7 if mode in ['badexit','encoded-badexit'] else 0)
for line in sys.stdin:
 m=json.loads(line)
 if provider=='codex':
  method=m.get('method')
  if method=='initialize':emit({'id':0,'result':{}})
  elif method=='model/list':emit({'id':1,'result':{'data':[{'model':'synthetic-model','displayName':'Synthetic','isDefault':True,'supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'high'}]},{'model':'--not-a-model'}],'nextCursor':None}})
  elif method=='thread/start':
   system=m['params']['developerInstructions']
   p=m['params'];assert p['cwd']==os.getcwd();assert p['sandbox']=='read-only';assert p['approvalPolicy']=='on-request';assert p['config']['features']['shell_tool'] is False
   if mode.startswith('options'):assert p['model']=='synthetic-model'
   emit({'id':1,'result':{'thread':{'id':'thread-1'}}})
  elif method=='turn/start':
   emit({'method':'item/started','params':{'threadId':'thread-1','item':{'type':'userMessage','id':'user-1','content':[]}}})
   text=m['params']['input'][0]['text'];assert m['params']['cwd']==os.getcwd();assert text.startswith('\nCONTEXT_JSON_DATA:\n')
   assert 'learning-route planner' not in text
   context=json.loads(text.split('\nCONTEXT_JSON_DATA:\n',1)[1])
   if mode.startswith('options'):assert m['params']['effort']=='high';assert m['params']['model']=='synthetic-model'
   emit({'id':2,'result':{'turn':{'id':'turn-1'}}});respond()
 else:
  if m.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':m['request_id'],'subtype':'success','response':{'currentModelId':'synthetic-model','models':[{'value':'synthetic-model','displayName':'Synthetic','isDefault':True,'supportedEffortLevels':['low','high']}] if provider!='codebuddy' else [{'id':'synthetic-model','name':'Synthetic','supportedEffortLevels':['low','high']}]}}})
  elif m.get('type')=='user':
   text=m['message']['content'][0]['text'];assert 'CONTEXT_JSON_DATA' in text
   assert 'learning-route planner' not in text and text.lstrip().startswith('CONTEXT_JSON_DATA:')
   system=sys.argv[sys.argv.index('--system-prompt')+1]
   context=json.loads(text.split('\nCONTEXT_JSON_DATA:\n',1)[1])
   respond()
`);
  const source=join(dir,'main.swift'),binary=join(dir,'verify');
  await writeFile(source,`import Foundation
import Darwin
func check(_ condition:Bool,_ note:String="check failed"){if !condition{fputs(note+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),fixture=CommandLine.arguments[2]
try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
let runtime=try RuntimeDirectory(url:base.appendingPathComponent("runtime"))
let workspace=base.appendingPathComponent("synthetic project",isDirectory:true)
try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
let id="proj_12345678-1234-4234-8234-123456789abc"
let agent=try AgentManager(runtime:runtime,projectWorkspace:{_ in workspace})
var authMode="unknown"
let detector=try AgentManager(runtime:runtime,resolver:{_ in URL(fileURLWithPath:"/synthetic/verified-cli")},runner:{_,args,_ in
 if args==["--version"]{return AgentCommandResult(status:0,text:"0.165.0",diagnostic:"",timedOut:false)}
 return AgentCommandResult(status:1,text:authMode=="unknown" ? "network failed":"Not logged in",diagnostic:"",timedOut:false)
})
do{try detector.save(id,choice:"codex");check(false,"unknown cannot be authentication required")}catch AgentError.unavailable{}
authMode="signed-out"
do{try detector.save(id,choice:"codex");check(false,"signed out needs authentication")}catch AgentError.auth{}
let context:[String:Any]=["projectId":id,"locale":"en","currentQuestion":"goal","questions":[["id":"goal","status":"current","fields":[String:String](),"summary":"","conversationFrom":0]],"messages":[["id":"msg-user","role":"user","questionId":"goal","text":"Learn Python"]]]
var scoped=context
scoped["currentQuestion"]="goal";scoped["routeDraft"]=["id":"OLD_ROUTE"];scoped["proposal"]=["reply":"UNADOPTED"]
scoped["questions"]=[["id":"goal","status":"current","fields":[:],"summary":"","missing":[],"conversationFrom":1,"answerProposal":["summary":"UNADOPTED"]]]
scoped["messages"]=[["id":"old","role":"user","questionId":"goal","text":"OLD_ATTEMPT"],["id":"other","role":"user","questionId":"time","text":"OTHER_QUESTION"],["id":"fresh","role":"user","questionId":"goal","text":"CURRENT_ANSWER"]]
let interviewPrompt=try PlanningAgentPrompt.make(intent:"interview",context:scoped)
let scopedData=try JSONSerialization.jsonObject(with:Data(interviewPrompt.components(separatedBy:"CONTEXT_JSON_DATA:").last!.utf8)) as! [String:Any]
check((scopedData["messages"] as! [[String:Any]]).count==1,"interview leaked other questions or old attempt")
check(scopedData["routeDraft"]==nil && scopedData["proposal"]==nil,"interview included the old route")
let generatedPrompt=try PlanningAgentPrompt.make(intent:"generate",context:scoped)
let generatedData=try JSONSerialization.jsonObject(with:Data(generatedPrompt.components(separatedBy:"CONTEXT_JSON_DATA:").last!.utf8)) as! [String:Any]
check(generatedData["messages"]==nil && generatedData["routeDraft"]==nil,"generation reused old chat or draft")

func manager(_ mode:String,_ provider:String="codex",_ timeout:TimeInterval=2,_ idleTimeout:TimeInterval=180)throws->PlanningAgentManager {
 let launch=try AgentSessionLaunch(provider:provider,projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,mode,provider]+(provider=="codebuddy" ? ["--tools",""]:[]),workspace:workspace,environment:ProcessInfo.processInfo.environment)
 return PlanningAgentManager(agents:agent,timeout:timeout,idleTimeout:idleTimeout,prepare:{_ in AgentSessionPreparation(projectID:id,provider:provider,launch:launch)})
}
func awaitJob(_ manager:PlanningAgentManager,_ job:String)throws->[String:Any] {
 let deadline=Date().addingTimeInterval(8)
 while Date()<deadline {let value=try manager.state(projectID:id,jobID:job);if value["state"] as? String != "pending"{return value};Thread.sleep(forTimeInterval:0.01)}
 throw PlanningAgentError.timeout
}
for provider in ["codex","claude-code","codebuddy"] {
 let m=try manager("success",provider);var calls=0
 let job=try m.begin(projectID:id,intent:"interview",context:context){value in calls+=1;check(value["updates"] is [[String:Any]]);return ["revision":2]}
 let value=try awaitJob(m,job["id"] as! String)
 check(value["state"] as? String=="completed",provider+" success "+String(describing:value))
 check(calls==1 && (value["result"] as? [String:Any])?["revision"] as? Int==2)
 m.shutdown()
 for mode in ["chat"] {
  let chat=try manager(mode,provider),job=try chat.begin(projectID:id,intent:"edit",context:context){value in check(value["reply"] is String);return ["replySaved":true]}
  let value=try awaitJob(chat,job["id"] as! String)
  check(value["state"] as? String=="completed",provider+" chat "+String(describing:value));chat.shutdown()
 }
}
check(PlanningAgentManager.requestTimeout(provider:"codebuddy",intent:"edit")==600)
check(PlanningAgentManager.requestTimeout(provider:"codebuddy",intent:"generate")==1800)
check(PlanningAgentManager.requestTimeout(provider:"codebuddy",intent:"interview")==180)
for provider in ["codex","claude-code","codebuddy"]{check(PlanningAgentManager.requestTimeout(provider:provider,intent:"edit")==600);check(PlanningAgentManager.requestTimeout(provider:provider,intent:"generate")==1800);check(PlanningAgentManager.requestTimeout(provider:provider,intent:"interview")==180)}
for provider in ["codex","claude-code","codebuddy"] {
 for mode in ["preview","preview-failed","preview-cancel"]+(provider=="codebuddy" ? ["preview-reset-failed"]:[]) {
  let m=try manager(mode,provider,4);var calls=0
  let job=try m.begin(projectID:id,intent:"edit",context:context){_ in calls+=1;return ["saved":true]}
  let jobID=job["id"] as! String,deadline=Date().addingTimeInterval(5)
  var previews=Set<String>(),last:[String:Any]=[:]
  while Date()<deadline {
   last=try m.state(projectID:id,jobID:jobID)
   if let text=last["partialReply"] as? String {
    check(last["state"] as? String != "completed" && last["result"]==nil,"preview became a committed result")
    check("Streaming reply arrives before completion.".hasPrefix(text),"raw JSON leaked")
    previews.insert(text)
    if mode=="preview-cancel"{try m.cancel(projectID:id,jobID:jobID)}
   }
   if last["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.01)
  }
  check(!previews.isEmpty && (mode=="preview-cancel" || previews.count>1),provider+" no streaming preview")
  check(mode=="preview" ? last["partialReply"]==nil : last["partialReply"] != nil,"failed preview not retained or completed preview duplicated")
  check(last["state"] as? String==(mode=="preview" ? "completed":mode.contains("failed") ? "failed":"cancelled"),provider+" wrong preview final")
  check(calls==(mode=="preview" ? 1:0));m.shutdown()
 }
}
for (mode,expected) in [("stream","completed"),("stream-activity","completed"),("stream-large","completed"),("stream-idle","PLANNING_AGENT_TIMEOUT"),("stream-heartbeat","PLANNING_AGENT_TIMEOUT"),("stream-tools","PLANNING_AGENT_PERMISSION_REQUIRED"),("stream-no-final","PLANNING_AGENT_FAILED")] {
 let m=try manager(mode,"codebuddy",3,0.2)
 let job=try m.begin(projectID:id,intent:"interview",context:context){_ in ["saved":true]}
 let value=try awaitJob(m,job["id"] as! String),diagnostic=value["diagnostic"] as! [String:Any]
 check((value["errorCode"] as? String ?? value["state"] as? String)==expected,mode+" "+String(describing:value))
 check(diagnostic["provider"] as? String=="codebuddy" && diagnostic["intent"] as? String=="interview");if mode=="stream-idle" || mode=="stream-heartbeat"{check(diagnostic["stage"] as? String=="idle_timeout","idle timeout not identified")}
 check(diagnostic["traceId"] as? String==job["id"] as? String)
 if expected=="completed"{check((diagnostic["receivedCharacters"] as? Int ?? 0)>0)}
 if mode=="stream-activity"{let a=value["activity"] as! [String:Any],events=a["events"] as! [[String:Any]];check((a["thinkingCharacters"] as! Int)>0 && (a["outputCharacters"] as! Int)>0,"activity counters missing");check(events.count==60 && (events.last!["sequence"] as! Int)>60,"activity list not bounded");check(!String(describing:a).contains("SENSITIVE_REASONING"),"reasoning leaked into activity")}
 m.shutdown()
}
for intent in ["generate","edit"] {
 let m=try manager("reply-only","codebuddy"),job=try m.begin(projectID:id,intent:intent,context:context){_ in preconditionFailure("incomplete task shape applied")}
 let result=try awaitJob(m,job["id"] as! String)
 check(result["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED",intent+" "+String(describing:result))
 let diagnostic=result["diagnostic"] as! [String:Any]
 check(!(diagnostic["validationIssues"] as? [[String:String]] ?? []).isEmpty,"missing shape diagnosis");m.shutdown()
}
for provider in ["codex","claude-code","codebuddy"] {
 for mode in provider=="codebuddy" ? ["valid","duplicate","truncated","prose","trailing","nested","array","depth","shape","domain"]:["valid"] {
  let encoded=try manager("encoded-"+mode,provider)
  let job=try encoded.begin(projectID:id,intent:"edit",context:context){_ in preconditionFailure("string route was implicitly decoded")}
  let result=try awaitJob(encoded,job["id"] as! String),diagnostic=result["diagnostic"] as! [String:Any]
  check(result["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED",provider+" string route "+mode+" "+String(describing:result))
  check(!String(describing:diagnostic).contains("SENSITIVE"),"route content leaked into diagnostic");encoded.shutdown()
 }
}
for (mode,expected) in [("failed","PLANNING_AGENT_FAILED"),("network","PLANNING_AGENT_NETWORK"),("badexit","PLANNING_AGENT_FAILED")] {
 let encoded=try manager("encoded-"+mode,"codebuddy")
 let job=try encoded.begin(projectID:id,intent:"edit",context:context){_ in preconditionFailure("failed protocol result applied")}
 let result=try awaitJob(encoded,job["id"] as! String)
 check(result["errorCode"] as? String==expected,mode+" "+String(describing:result));encoded.shutdown()
}
for (mode,expected) in [("permission","PLANNING_AGENT_PERMISSION_REQUIRED"),("forbidden-result-tool","PLANNING_AGENT_PERMISSION_REQUIRED"),("failed","PLANNING_AGENT_FAILED"),("badexit","PLANNING_AGENT_FAILED"),("duplicate","PLANNING_AGENT_ROUTE_ENCODING"),("mixed","PLANNING_AGENT_ROUTE_ENCODING")] {
 let m=try manager(mode,"codebuddy"),job=try m.begin(projectID:id,intent:"edit",context:context){_ in preconditionFailure("unsafe result accepted")}
 let final=try awaitJob(m,job["id"] as! String);check(final["errorCode"] as? String==expected,mode+" "+String(describing:final));m.shutdown()
}
let streamingDeadline=try manager("stream-deadline","codebuddy",1,3)
let streamingJob=try streamingDeadline.begin(projectID:id,intent:"interview",context:context){_ in preconditionFailure("active stream bypassed total timeout")}
let timedStream=try awaitJob(streamingDeadline,streamingJob["id"] as! String);check(timedStream["errorCode"] as? String=="PLANNING_AGENT_TIMEOUT");check((timedStream["diagnostic"] as? [String:Any])?["stage"] as? String=="total_timeout","active stream did not report total deadline");streamingDeadline.shutdown()
for provider in ["codex","claude-code","codebuddy"] {
 let metadata=try manager("models",provider),catalog=try metadata.models(projectID:id),models=catalog["models"] as! [[String:Any]]
 check(models.count==1 && models[0]["id"] as? String=="synthetic-model" && models[0]["name"] as? String=="Synthetic" && models[0]["isDefault"] as? Bool==true,"catalog filtering")
 try metadata.validateOptions(projectID:id,options:["model":"synthetic-model","effort":"high"])
 do{try metadata.validateOptions(projectID:id,options:["model":"synthetic-model","effort":"invented"]);check(false,"unsupported effort accepted")}catch PlanningAgentError.options{}
 metadata.shutdown()
 let m=try manager("options",provider);var chosen=context;chosen["agentOptions"]=["model":"synthetic-model","effort":"high"]
 let job=try m.begin(projectID:id,intent:"interview",context:chosen){_ in ["saved":true]}
 check(try awaitJob(m,job["id"] as! String)["state"] as? String=="completed","model settings "+provider);m.shutdown()
 let generation=try manager("options-generate",provider)
 let generated=try generation.begin(projectID:id,intent:"generate",context:chosen){_ in ["saved":true]}
 check(try awaitJob(generation,generated["id"] as! String)["state"] as? String=="completed","generation dropped model settings "+provider);generation.shutdown()
}
let badEdit=try manager("bad-edit")
let badEditJob=try badEdit.begin(projectID:id,intent:"edit",context:context){_ in preconditionFailure("invalid edit route accepted")}
check(try awaitJob(badEdit,badEditJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED");badEdit.shutdown()
let noGeneratedRoute=try manager("chat")
let missingRouteJob=try noGeneratedRoute.begin(projectID:id,intent:"generate",context:context){_ in preconditionFailure("generation accepted no route")}
check(try awaitJob(noGeneratedRoute,missingRouteJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED");noGeneratedRoute.shutdown()
for (mode,expected) in [("duplicate","PLANNING_AGENT_ROUTE_ENCODING"),("mixed","PLANNING_AGENT_ROUTE_ENCODING"),("failed","PLANNING_AGENT_FAILED"),("permission","PLANNING_AGENT_PERMISSION_REQUIRED"),("large","PLANNING_AGENT_OUTPUT_TOO_LARGE"),("network","PLANNING_AGENT_NETWORK"),("auth","PLANNING_AGENT_AUTH_REQUIRED"),("quota","PLANNING_AGENT_QUOTA"),("stderr","PLANNING_AGENT_FAILED")] {
 let m=try manager(mode);var calls=0
 let job=try m.begin(projectID:id,intent:"interview",context:context){_ in calls+=1;return [:]}
 let value=try awaitJob(m,job["id"] as! String)
 check(value["state"] as? String=="failed" && value["errorCode"] as? String==expected,mode+" "+String(describing:value));check(calls==0);m.shutdown()
}
let mismatch=try manager("success")
var mismatchedContext=context;mismatchedContext["provider"]="codebuddy"
let mismatchedJob=try mismatch.begin(projectID:id,intent:"interview",context:mismatchedContext){_ in preconditionFailure("changed provider cannot apply")}
check(try awaitJob(mismatch,mismatchedJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_UNAVAILABLE");mismatch.shutdown()
let wrongLaunch=try AgentSessionLaunch(provider:"codex",projectID:"proj_00000000-0000-4000-8000-000000000000",executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,"success","codex"],workspace:workspace,environment:ProcessInfo.processInfo.environment)
let wrongProject=PlanningAgentManager(agents:agent,prepare:{_ in AgentSessionPreparation(projectID:id,provider:"codex",launch:wrongLaunch)})
let wrongJob=try wrongProject.begin(projectID:id,intent:"interview",context:context){_ in preconditionFailure("different project cannot apply")}
check(try awaitJob(wrongProject,wrongJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_INVALID");wrongProject.shutdown()
let badExit=try manager("badexit","codebuddy")
let exited=try badExit.begin(projectID:id,intent:"interview",context:context){_ in preconditionFailure("bad exit cannot apply")}
check(try awaitJob(badExit,exited["id"] as! String)["state"] as? String=="failed");badExit.shutdown()
let rejected=try manager("generate")
let rejectJob=try rejected.begin(projectID:id,intent:"generate",context:context){_ in throw PlanningAgentError.rejected}
check(try awaitJob(rejected,rejectJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED");rejected.shutdown()
let slow=try manager("slow");var cancelledCalls=0
let pending=try slow.begin(projectID:id,intent:"interview",context:context){_ in cancelledCalls+=1;return [:]}
do{_ = try slow.begin(projectID:id,intent:"interview",context:context){_ in [:]};check(false,"concurrent project accepted")}catch PlanningAgentError.busy{}
let started=workspace.appendingPathComponent("slow-started"),startDeadline=Date().addingTimeInterval(2)
while !FileManager.default.fileExists(atPath:started.path) && Date()<startDeadline{Thread.sleep(forTimeInterval:0.01)}
check(FileManager.default.fileExists(atPath:started.path),"slow process did not start")
try slow.cancel(projectID:id,jobID:pending["id"] as! String)
Thread.sleep(forTimeInterval:0.8)
check(try slow.state(projectID:id,jobID:pending["id"] as! String)["state"] as? String=="cancelled");check(cancelledCalls==0);slow.shutdown()
let timed=try manager("slow","codex",0.1)
let timedJob=try timed.begin(projectID:id,intent:"interview",context:context){_ in preconditionFailure("timeout cannot apply")}
check(try awaitJob(timed,timedJob["id"] as! String)["errorCode"] as? String=="PLANNING_AGENT_TIMEOUT");Thread.sleep(forTimeInterval:0.7);timed.shutdown()
let committing=try manager("success"),entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0)
let committingJob=try committing.begin(projectID:id,intent:"interview",context:context){_ in entered.signal();_ = release.wait(timeout:.now()+2);return ["revision":3]}
check(entered.wait(timeout:.now()+4) == .success,"apply not entered")
check(try committing.state(projectID:id,jobID:committingJob["id"] as! String)["state"] as? String=="pending")
do{try committing.cancel(projectID:id,jobID:committingJob["id"] as! String);check(false,"cancel committing should be busy")}catch PlanningAgentError.busy{}
release.signal();check(try awaitJob(committing,committingJob["id"] as! String)["state"] as? String=="completed");committing.shutdown()
for text in ["{\\"a\\":1,\\"\\\\u0061\\":2}","{\\"nested\\":{\\"a\\":1,\\"a\\":2}}","{} trailing","[]","{\\"a\\":01}"] {
 do{_ = try PlanningStrictJSON.object(text);check(false,"invalid JSON accepted")}catch PlanningAgentError.protocolFailure{}
}
check(try PlanningStrictJSON.object("{\\"a\\":[1,2,{\\"ok\\":true}]}")["a"] != nil)
${streamAssertions}
print("PASS planning protocol finals, tool refusal, output validation, jobs, cancellation, timeout and cwd")
`);
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningPromptPackResources.swift',source,'-o',binary],{encoding:'utf8',timeout:210_000});
  assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(binary,[join(dir,'data'),fixture],{encoding:'utf8',timeout:110_000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS planning protocol finals/);
});
