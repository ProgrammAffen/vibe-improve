import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';

test('native planning bridge enforces revisions and trusted choices, preserves resumed/imported drafts, and cleans failed/cancelled/retired jobs',{skip:process.platform!=='darwin',timeout:240_000},async()=>{
  const parent=resolve('tmp/checks/unified-planning-2026-11-04/coordinator');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
  const planning=join(dir,'planning.js'),route=join(dir,'route.js'),source=join(dir,'main.swift'),binary=join(dir,'verify'),sample=join(dir,'route.json'),fixture=join(dir,'fixture.py');
  await Promise.all([
    build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:planning}),
    build({entryPoints:['packages/domain/route-validation.mjs'],bundle:true,format:'iife',globalName:'VibeRoute',platform:'neutral',target:'es2022',outfile:route}),
    writeFile(sample,await readFile('contracts/examples/route.valid.json'))
  ]);
  await writeFile(fixture,String.raw`import json,sys,time
mode=sys.argv[1]
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize': emit({'id':0,'result':{}})
 if m.get('method')=='model/list':emit({'id':1,'result':{'data':[{'model':'synthetic','displayName':'Synthetic','isDefault':True,'supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}],'nextCursor':None}})
 if m.get('method')=='thread/start': emit({'id':1,'result':{'thread':{'id':'t'}}})
 if m.get('method')=='turn/start':
  emit({'id':2,'result':{'turn':{'id':'u'}}})
  if mode=='slow': time.sleep(.6)
  ctx=json.loads(m['params']['input'][0]['text'].split('CONTEXT_JSON_DATA:\n',1)[1])
  def interview(reply,result):return json.dumps({'status':'ok','reply':reply,'result':result,'missing':[]})
  payload=interview('Continue',{'questionId':ctx.get('currentQuestion','goal'),'summary':'','fields':{},'evidence':[],'unresolved':['What outcome?'],'complete':False}) if mode!='invalid' else 'invalid output'
  if mode=='chat':payload='{"reply":"The route prepares data and then explains results.","route":null}'
  if mode=='target':
   ctx=json.loads(m['params']['input'][0]['text'].split('CONTEXT_JSON_DATA:\n',1)[1]);target=ctx['messages'][-1]['target'];ch=next(ch for ch in ctx['routeDraft']['chapters'] if ch['id']==target['chapterId']);assert any(n['id']==target['nodeId'] for n in ch['nodes'])
   payload=json.dumps({'reply':'This lesson is the requested scope.','route':None})
  if mode=='mentions':
   ctx=json.loads(m['params']['input'][0]['text'].split('CONTEXT_JSON_DATA:\n',1)[1]);refs=ctx['references'];mentions=ctx['messages'][-1]['mentions'];assert len(refs)==len(mentions)==2
   ch=ctx['routeDraft']['chapters'][0];node=ch['nodes'][0]
   assert refs[0]['token']=='@第1章' and refs[0]['kind']=='chapter' and refs[0]['content']==ch
   assert refs[1]['token']=='@1.1节' and refs[1]['kind']=='lesson' and refs[1]['content']==node and refs[1]['content']['objectives']==node['objectives']
   payload=json.dumps({'reply':'Both referenced contents were received.','route':None})
  if mode=='invalid-route':payload=json.dumps({'reply':'A proposed revision.','route':{'format':'vibe-improve.route','schemaVersion':2,'chapters':[]}})
  if mode=='semantic':
   prompt=m['params']['input'][0]['text'];ctx=json.loads(prompt.split('CONTEXT_JSON_DATA:\n',1)[1]);mid=ctx['messages'][-1]['ref']
   assert mid.startswith('U') and all('id' not in item for item in ctx['messages']) and 'currentFields' in ctx and 'acceptedAnswers' in ctx
   payload=interview('Your goal is clear.',{'questionId':'goal','summary':'Learn Python to produce an independent sales report.','fields':{'topic':'Python data analysis','outcome':'Independently produce a sales report'},'evidence':[{'field':field,'messageRef':mid,'proposalRef':None,'quote':'The user chose an independent sales-report task'} for field in ['topic','outcome']],'unresolved':[],'complete':True})
  if mode in ['semantic-shortref','semantic-bad-reference']:
   mid=ctx['messages'][-1]['ref'];proposal=next(m['ref'] for m in reversed(ctx['messages']) if m['role']=='assistant')
   proposal=proposal if mode=='semantic-shortref' else 'A999'
   payload=interview('Please review the goal.',{'questionId':'goal','summary':'Learn Python to produce a sales report.','fields':{'outcome':'Independently produce a sales report'},'evidence':[{'field':'outcome','messageRef':mid,'quote':'SENSITIVE_EXPLANATION','proposalRef':proposal}],'unresolved':[],'complete':True})
  emit({'method':'turn/completed','params':{'threadId':'t','turn':{'id':'u','status':'completed','items':[{'type':'agentMessage','text':payload}]}}})
`);
  await writeFile(source,`import Foundation
import Darwin
func check(_ value:Bool,_ message:String="check failed",line:Int=#line){if !value{fputs(message+" at line "+String(line)+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1]),planningURL=URL(fileURLWithPath:CommandLine.arguments[2]),routeURL=URL(fileURLWithPath:CommandLine.arguments[3]),sampleURL=URL(fileURLWithPath:CommandLine.arguments[4]),fixture=CommandLine.arguments[5]
try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
let workspace=base.appendingPathComponent("Workspace"),runtime=try RuntimeDirectory(url:base.appendingPathComponent("Runtime"))
try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
let manualID="proj_12345678-1234-4234-8234-123456789abc",aiID="proj_12345678-1234-4234-8234-123456789abd",retiredID="proj_12345678-1234-4234-8234-123456789abe"
func workspaceFor(_ id:String)throws->URL{workspace}
let agents=try AgentManager(runtime:runtime,resolver:{_ in URL(fileURLWithPath:"/synthetic/cli")},runner:{_,args,_ in AgentCommandResult(status:0,text:args==["--version"] ? "0.165.0":"Logged in using ChatGPT",diagnostic:"",timedOut:false)},projectWorkspace:workspaceFor)
let routes=try RoutePreparationStore(runtime:runtime,validatorURL:routeURL,workspace:workspaceFor),store=try PlanningStore(runtime:runtime,validatorURL:planningURL,workspace:workspaceFor)
var mode="success"
let runner=PlanningAgentManager(agents:agents,timeout:3,prepare:{id in
 let launch=try AgentSessionLaunch(provider:"codex",projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,mode],workspace:workspace,environment:ProcessInfo.processInfo.environment)
 return AgentSessionPreparation(projectID:id,provider:"codex",launch:launch)
})
let bridge=PlanningCoordinator(store:store,routes:routes,agents:agents,runner:runner)
func call(_ action:String,_ id:String,_ extra:[String:Any]=[:])throws->[String:Any]{var value=extra;value["projectId"]=id;guard let result=try bridge.request(action,value:value) as? [String:Any] else{throw PlanningError.invalid};return result}
func rev(_ value:[String:Any])->Int{value["revision"] as! Int}
func awaitJob(_ id:String,_ job:String,_ pollBridge:Bool=true)throws->[String:Any]{
 let deadline=Date().addingTimeInterval(6)
 while Date()<deadline{let value=try pollBridge ? call("planning.state",id,["jobId":job]):runner.state(projectID:id,jobID:job);if value["state"] as? String != "pending"{return value};Thread.sleep(forTimeInterval:0.01)}
 throw PlanningAgentError.timeout
}
do{_ = try call("planning.enter",manualID,["locale":"en","mode":"manual"]);check(false,"unconfirmed choice allowed")}catch PlanningError.incomplete{}
_ = try routes.confirmAgent(projectID:manualID);try agents.save(manualID,choice:"manual")
var manual=try call("planning.enter",manualID,["locale":"en","mode":"manual"])
check(manual["step"] as? String=="editor")
var route=try JSONSerialization.jsonObject(with:Data(contentsOf:sampleURL)) as! [String:Any]
route["schemaVersion"]=2;route["id"]=(manual["routeDraft"] as! [String:Any])["id"]
var chapters=route["chapters"] as! [[String:Any]];for index in chapters.indices{chapters[index]["stageGoal"]="Complete this capability milestone"};route["chapters"]=chapters
manual=try call("planning.save",manualID,["route":route,"expectedRevision":rev(manual)])
do{_ = try call("planning.save",manualID,["route":route,"expectedRevision":0]);check(false,"stale save accepted")}catch PlanningError.conflict{}
try agents.save(manualID,choice:"codex")
let resumed=try call("planning.enter",manualID,["locale":"zh-CN","mode":"ai"])
check(resumed["step"] as? String=="intake","AI creation did not reopen intake")
check((resumed["routeDraft"] as! [String:Any])["id"] as? String==route["id"] as? String,"resume discarded draft")
let staged=try routes.stage(projectID:manualID,url:sampleURL),routeState=try routes.read(projectID:manualID)
_ = try routes.saveImport(projectID:manualID,importID:staged["importId"] as! String,expectedRevision:rev(routeState))
let unconfirmedImport=try call("planning.enter",manualID,["locale":"en","mode":"import"])
check((unconfirmedImport["routeDraft"] as! [String:Any])["id"] as? String==route["id"] as? String,"unconfirmed replacement occurred")
do{_ = try call("planning.enter",manualID,["locale":"en","mode":"import","expectedRevision":0]);check(false,"stale import allowed")}catch PlanningError.conflict{}
let imported=try call("planning.enter",manualID,["locale":"en","mode":"import","expectedRevision":rev(unconfirmedImport)])
check((imported["routeDraft"] as! [String:Any])["schemaVersion"] as? Int==2);check(imported["importedOriginal"] != nil)
do{_ = try call("planning.confirm",manualID,["expectedRevision":rev(imported)]);check(false,"missing legacy goals confirmed")}catch PlanningError.route{}
mode="chat"
let chatJob=try call("planning.begin",manualID,["intent":"edit","text":"Describe all chapters","expectedRevision":rev(imported)])
check(try awaitJob(manualID,chatJob["id"] as! String)["state"] as? String=="completed","conversation on incomplete import failed")
var chatted=try call("planning.read",manualID)
check(chatted["pending"]==nil && chatted["proposal"]==nil,"conversation left a pending job or fake proposal")
check((chatted["messages"] as! [[String:Any]]).last?["role"] as? String=="assistant","conversation reply not persisted")
check(try JSONSerialization.data(withJSONObject:chatted["routeDraft"]!,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:imported["routeDraft"]!,options:[.sortedKeys]),"conversation changed the original chapters")
let targetChapter=((chatted["routeDraft"] as! [String:Any])["chapters"] as! [[String:Any]])[0],targetNode=(targetChapter["nodes"] as! [[String:Any]])[0]
let target:[String:Any]=["chapterId":targetChapter["id"]!,"nodeId":targetNode["id"]!]
mode="target"
let targetedJob=try call("planning.begin",manualID,["intent":"edit","text":"Explain this lesson","target":target,"expectedRevision":rev(chatted)])
check(try awaitJob(manualID,targetedJob["id"] as! String)["state"] as? String=="completed","target did not reach the agent")
chatted=try call("planning.read",manualID)
check((chatted["messages"] as! [[String:Any]]).contains{($0["target"] as? [String:Any])?["nodeId"] as? String==targetNode["id"] as? String},"target was not persisted")
mode="mentions"
let mentions:[[String:Any]]=[["target":["chapterId":targetChapter["id"]!],"token":"@第1章"],["target":target,"token":"@1.1节"]]
let mentionsJob=try call("planning.begin",manualID,["intent":"edit","text":"Compare @第1章 and @1.1节","mentions":mentions,"expectedRevision":rev(chatted)])
check(try awaitJob(manualID,mentionsJob["id"] as! String)["state"] as? String=="completed","actual multi-reference content did not reach the agent")
chatted=try call("planning.read",manualID)
check((((chatted["messages"] as! [[String:Any]]).dropLast().last)?["mentions"] as? [[String:Any]])?.count==2,"multi-mentions were not persisted")
do{_ = try call("planning.begin",manualID,["intent":"edit","text":"No token","mentions":mentions,"expectedRevision":rev(chatted)]);check(false,"unmentioned references accepted")}catch PlanningError.target{}
do{_ = try call("planning.begin",manualID,["intent":"edit","text":"Bad target","target":["chapterId":"missing"],"expectedRevision":rev(chatted)]);check(false,"invalid target accepted")}catch PlanningError.target{}
var editedRoute=chatted["routeDraft"] as! [String:Any];editedRoute["title"]="History test"
chatted=try call("planning.save",manualID,["route":editedRoute,"expectedRevision":rev(chatted)])
chatted=try call("planning.undo",manualID,["expectedRevision":rev(chatted)])
check((chatted["routeDraft"] as! [String:Any])["title"] as? String != "History test","native undo failed")
chatted=try call("planning.redo",manualID,["expectedRevision":rev(chatted)])
check((chatted["routeDraft"] as! [String:Any])["title"] as? String=="History test","native redo failed")
mode="invalid-route"
let invalidRouteJob=try call("planning.begin",manualID,["intent":"edit","text":"Revise the chapters","expectedRevision":rev(chatted)])
let invalidRouteResult=try awaitJob(manualID,invalidRouteJob["id"] as! String)
check(invalidRouteResult["errorCode"] as? String=="PLANNING_AGENT_RESULT_REJECTED","AI route failure blamed the user's draft")
check(((invalidRouteResult["diagnostic"] as? [String:Any])?["validationIssues"] as? [[String:String]])?.isEmpty==false,"route rejection missing safe field diagnostics")
let afterRejected=try call("planning.read",manualID)
check(afterRejected["pending"]==nil && afterRejected["proposal"]==nil,"invalid AI route left a proposal")
check(try JSONSerialization.data(withJSONObject:afterRejected["routeDraft"]!,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:chatted["routeDraft"]!,options:[.sortedKeys]),"invalid AI result modified the draft")
_ = try routes.confirmAgent(projectID:aiID);try agents.save(aiID,choice:"codex")
var ai=try call("planning.enter",aiID,["locale":"en","mode":"ai"])
let catalog=try call("planning.models",aiID);check((catalog["models"] as! [[String:Any]]).count==1,"bridge model catalog")
ai=try call("planning.options",aiID,["options":["model":"synthetic","effort":"medium"],"expectedRevision":rev(ai)])
let restoredStore=try PlanningStore(runtime:runtime,validatorURL:planningURL,workspace:workspaceFor)
check((try restoredStore.read(projectID:aiID)?["agentOptions"] as? [String:Any])?["effort"] as? String=="medium","native preferences were not persisted")
do{_ = try call("planning.options",aiID,["options":["model":"synthetic","effort":"invented"],"expectedRevision":rev(ai)]);check(false,"unsupported model effort accepted")}catch PlanningAgentError.options{}
do{_ = try call("planning.begin",aiID,["intent":"interview","text":"Learn Python","expectedRevision":rev(ai),"prompt":"untrusted"]);check(false,"custom prompt accepted")}catch PlanningError.invalid{}
do{_ = try call("planning.begin",aiID,["intent":"generate","expectedRevision":rev(ai)]);check(false,"incomplete interview generated")}catch PlanningError.incomplete{}
mode="invalid"
let failed=try call("planning.begin",aiID,["intent":"interview","text":"Learn Python","expectedRevision":rev(ai)]),failedID=failed["id"] as! String
check(try awaitJob(aiID,failedID)["state"] as? String=="failed")
ai=try call("planning.read",aiID);check(ai["pending"]==nil);check((ai["messages"] as! [[String:Any]]).count==1)
do{_ = try call("planning.focus",aiID,["questionId":"goal","expectedRevision":0]);check(false,"stale revision accepted")}catch PlanningError.conflict{}
mode="slow"
let cancelled=try call("planning.begin",aiID,["intent":"interview","text":"Cancel this question","expectedRevision":rev(ai)])
_ = try call("planning.cancel",aiID,["jobId":cancelled["id"] as! String])
Thread.sleep(forTimeInterval:0.8);ai=try call("planning.read",aiID);check(ai["pending"]==nil);check((ai["messages"] as! [[String:Any]]).count==2)
mode="success"
let success=try call("planning.begin",aiID,["intent":"interview","text":"I will make a report","expectedRevision":rev(ai)])
check(try awaitJob(aiID,success["id"] as! String,false)["state"] as? String=="completed")
ai=try call("planning.read",aiID);mode="semantic"
let judgedJob=try call("planning.begin",aiID,["intent":"interview","text":"Learn Python to make sales reports","expectedRevision":rev(ai)])
check(try awaitJob(aiID,judgedJob["id"] as! String)["state"] as? String=="completed","AI summaries were rejected")
ai=try call("planning.read",aiID)
check((ai["questions"] as! [[String:Any]])[0]["status"] as? String=="awaiting-confirmation","answer did not await user review")
let referencedAssistant=(ai["messages"] as! [[String:Any]]).last!["id"] as! String
mode="semantic-shortref"
let aliasJob=try call("planning.begin",aiID,["intent":"interview","text":"Yes, use that report","expectedRevision":rev(ai)])
check(try awaitJob(aiID,aliasJob["id"] as! String)["state"] as? String=="completed","short suggestion reference was not resolved")
ai=try call("planning.read",aiID)
let evidence=(ai["questions"] as! [[String:Any]])[0]["evidence"] as! [[String:Any]]
check(evidence.first{$0["field"] as? String=="outcome"}?["proposalMessageId"] as? String==referencedAssistant,"canonical message ID not saved")
mode="semantic-bad-reference"
let badReference=try call("planning.begin",aiID,["intent":"interview","text":"Continue with the same result","expectedRevision":rev(ai)])
let badReferenceResult=try awaitJob(aiID,badReference["id"] as! String)
check(badReferenceResult["errorCode"] as? String=="PLANNING_EVIDENCE_INVALID","unknown suggestion was accepted")
check(!String(describing:badReferenceResult["diagnostic"]!).contains("SENSITIVE"),"reference diagnostics exposed answer text")
ai=try call("planning.read",aiID);check(ai["pending"]==nil,"failed reference kept active request")
mode="semantic-shortref"
let retriedReference=try call("planning.begin",aiID,["intent":"interview","text":"Yes, use that report","expectedRevision":rev(ai)])
check(try awaitJob(aiID,retriedReference["id"] as! String)["state"] as? String=="completed","reference failure blocked a later answer")
ai=try call("planning.read",aiID)
let summary=(ai["questions"] as! [[String:Any]])[0]["answerProposal"] as! [String:Any]
ai=try call("planning.answer.accept",aiID,["questionId":"goal","messageId":summary["messageId"] as! String,"expectedRevision":rev(ai)])
check((ai["questions"] as! [[String:Any]])[0]["status"] as? String=="complete")
check(ai["currentQuestion"] as? String=="purpose","question did not advance")
let adoptedGoal=(ai["questions"] as! [[String:Any]])[0]["acceptedSnapshot"] as! [String:Any]
ai=try call("planning.answer.reset",aiID,["questionId":"purpose","expectedRevision":rev(ai)])
check(ai["currentQuestion"] as? String=="purpose" && (ai["questions"] as! [[String:Any]])[1]["status"] as? String=="current","cascade did not select requested question")
check(try JSONSerialization.data(withJSONObject:(ai["questions"] as! [[String:Any]])[0]["acceptedSnapshot"]!,options:.sortedKeys)==JSONSerialization.data(withJSONObject:adoptedGoal,options:.sortedKeys),"cascade changed an earlier answer")
check((ai["questions"] as! [[String:Any]]).dropFirst().allSatisfy{($0["fields"] as! [String:Any]).isEmpty && $0["acceptedSnapshot"]==nil},"cascade retained a later answer")
do{_ = try call("planning.answer.reset",aiID,["questionId":"goal","expectedRevision":0]);check(false,"stale cascade allowed")}catch PlanningError.conflict{}
let cold=try PlanningStore(runtime:runtime,validatorURL:planningURL,workspace:workspaceFor).read(projectID:aiID)!
check((cold["questions"] as! [[String:Any]])[0]["status"] as? String=="complete","AI completion did not survive restart")
let beforeRestart=rev(ai)
ai=try call("planning.intake.restart",aiID,["expectedRevision":beforeRestart])
check(ai["currentQuestion"] as? String=="goal" && (ai["messages"] as! [[String:Any]]).isEmpty,"restart bridge did not clear interview")
check((ai["questions"] as! [[String:Any]]).allSatisfy{($0["fields"] as! [String:Any]).isEmpty && $0["acceptedSnapshot"]==nil && $0["answerProposal"]==nil},"restart kept old answers")
do{_ = try call("planning.intake.restart",aiID,["expectedRevision":beforeRestart]);check(false,"stale restart allowed")}catch PlanningError.conflict{}
do{_ = try call("planning.answer.accept",aiID,["questionId":"goal","messageId":summary["messageId"] as! String,"expectedRevision":rev(ai)]);check(false,"cleared summary could be adopted")}catch PlanningError.conflict{}
let resetCold=try PlanningStore(runtime:runtime,validatorURL:planningURL,workspace:workspaceFor).read(projectID:aiID)!
check((resetCold["messages"] as! [[String:Any]]).isEmpty && resetCold["currentQuestion"] as? String=="goal","restart was not persisted")
_ = try routes.confirmAgent(projectID:retiredID);try agents.save(retiredID,choice:"codex")
let retired=try call("planning.enter",retiredID,["locale":"en","mode":"ai"])
mode="invalid"
let abandoned=try call("planning.begin",retiredID,["intent":"interview","text":"Retire this failed job","expectedRevision":rev(retired)])
check(try awaitJob(retiredID,abandoned["id"] as! String,false)["state"] as? String=="failed")
mode="success"
for n in 0..<34 {
 let id=String(format:"proj_22345678-1234-4234-8234-%012x",n)
 _ = try routes.confirmAgent(projectID:id);try agents.save(id,choice:"codex")
 let state=try call("planning.enter",id,["locale":"en","mode":"ai"])
 let job=try call("planning.begin",id,["intent":"interview","text":"Question","expectedRevision":rev(state)])
 check(try awaitJob(id,job["id"] as! String,false)["state"] as? String=="completed")
}
check(try call("planning.read",aiID)["pending"]==nil,"retired completed job blocked read")
check(try call("planning.read",retiredID)["pending"]==nil,"retired failed job blocked read")
let after=try call("planning.read",manualID);check((after["routeDraft"] as! [String:Any])["id"] as? String==(imported["routeDraft"] as! [String:Any])["id"] as? String)
let oldRevision=rev(after)
do{_ = try call("planning.import.remove",manualID,["expectedRouteRevision":0,"expectedPlanningRevision":oldRevision]);check(false,"stale route delete allowed")}catch RoutePreparationError.conflict{}
check((try store.read(projectID:manualID))?["importedOriginal"] != nil)
let latestRoute=try routes.read(projectID:manualID)
_ = try call("planning.import.remove",manualID,["expectedRouteRevision":rev(latestRoute),"expectedPlanningRevision":oldRevision])
let cleared=try call("planning.read",manualID)
check(cleared["importedOriginal"]==nil && cleared["routeDraft"]==nil,"deleted import still present")
check((try routes.read(projectID:manualID))["routeDraft"]==nil)
let reloaded=try PlanningStore(runtime:runtime,validatorURL:planningURL,workspace:workspaceFor).read(projectID:manualID)!
check(reloaded["importedOriginal"]==nil,"deleted import returned on restart")
let stagedAgain=try routes.stage(projectID:manualID,url:sampleURL),beforeAgain=try routes.read(projectID:manualID)
_ = try routes.saveImport(projectID:manualID,importID:stagedAgain["importId"] as! String,expectedRevision:rev(beforeAgain))
_ = try store.importRoute(projectID:manualID,route:route,expectedRevision:rev(cleared))
let preparedAgain=try routes.read(projectID:manualID)
_ = try routes.removeImport(projectID:manualID,expectedRevision:rev(preparedAgain))
let reconciled=try call("planning.read",manualID)
check(reconciled["importedOriginal"]==nil && reconciled["routeDraft"]==nil,"partial delete resurrected route")
runner.shutdown();print("PASS native planning coordinator revisions, trusted choices, resume, import, cancellation, failure and job retirement")
`);
  const result=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/RoutePreparationStore.swift','apps/macos/PlanningStore.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningAgent.swift', 'apps/macos/PlanningGeneration.swift','apps/macos/PlanningCoordinator.swift',source,'-o',binary],{encoding:'utf8',timeout:210_000});
  assert.equal(result.status,0,result.stderr);
  const run=spawnSync(binary,[join(dir,'Data'),planning,route,sample,fixture],{encoding:'utf8',timeout:30_000});
  assert.equal(run.status,0,run.stderr+run.stdout);assert.match(run.stdout,/PASS native planning coordinator/);
  assert.deepEqual(await readdir(join(dir,'Data/Workspace')),[]);
  assert.equal(await readFile(sample,'utf8'),await readFile('contracts/examples/route.valid.json','utf8'));
});
