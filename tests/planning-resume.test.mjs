import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import * as p from '../packages/domain/planning.mjs';
const project='proj_12345678-1234-4234-8234-123456789abc';
function collected(){let state=p.createPlanning(project,'codebuddy','en');for(const question of state.questions){const id=question.id,request='request_'+id,message='message_'+id,fields={goal:{topic:'CSV processing',outcome:'Create a CSV report'},purpose:{context:'Personal practice',criteria:'Verify totals'},baseline:{experience:'Know Python basics'},time:{weekly:'Four hours',session:'One hour'},constraints:{scope:'Standard library',conditions:'Existing laptop'}}[id];state=p.appendUser(state,JSON.stringify(fields),message,request,state.revision);state=p.applyInterview(state,{reply:'Confirm.',summary:Object.values(fields).join(' / '),updates:[{id,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic answer'})),missing:[],complete:true}],consistency:{status:'consistent',issues:[]}},request,state.revision);state=p.acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}return state}
const routeID='route_12345678-1234-4234-8234-123456789abc';
const outline={status:'ok',reply:'Outline ready.',result:{title:'CSV practice',chapters:[{title:'Foundations',stageGoal:'Apply five named concepts.',lessons:Array.from({length:5},(_,i)=>({title:'Concept '+(i+1),focus:'Study, practice and explain.'}))},{title:'Application',stageGoal:'Create a report.',lessons:[{title:'Report',focus:'Complete a report independently.'}]}]},missing:[]};
function chapter(index,count){const c=outline.result.chapters[index];return{id:`ch_${index+1}`,title:c.title,stageGoal:c.stageGoal,nodes:c.lessons.slice(0,count).map((n,j)=>{const id=`node_${index+1}_${j+1}`;return{id,title:n.title,objectives:[{id:id+'_o1',description:'Apply the named concept in a practice case.'}],prerequisites:index?['node_1_5']:[],estimatedMinutes:30,activities:['Study a worked example.','Solve a new case and compare.']}})}}
function checkpoint(state,parts=[chapter(0,3),null],request='gen'){return p.saveGenerationProgress(state,{routeId:routeID,outline,chapters:parts},request,state.revision)}
const oldRoute=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
// Do not couple fixtures to the revision count of the interview implementation.
function withOld(){let state=collected();state=p.importRoute(state,oldRoute,state.revision);return p.reopenIntake(state,state.revision)}

test('validated generation progress is separate, monotonic and survives cancellation and process recovery',()=>{
 let state=withOld(),old=structuredClone(state.routeDraft);state=p.startGeneration(state,'gen',state.revision,true);const base=state.revision;
 let saved=checkpoint(state);assert.equal(saved.revision,base);assert.deepEqual(saved.routeDraft,old);assert.deepEqual(p.generationProgress(saved),{completed:3,total:6,resumable:true});assert.equal(saved.generationDraft.revision,1);
 saved=checkpoint(saved,[chapter(0,3),chapter(1,1)]);assert.equal(saved.generationDraft.revision,2);assert.throws(()=>checkpoint(saved,[null,chapter(1,1)]),/PLANNING_CONFLICT/);
 const recovered=p.recoverPlanning(saved);assert.equal(recovered.pending,undefined);assert.deepEqual(recovered.generationDraft,saved.generationDraft);assert.deepEqual(recovered.routeDraft,old);
 assert.throws(()=>checkpoint(recovered),/PLANNING_CONFLICT/);assert.throws(()=>p.startGeneration(recovered,'new',recovered.revision,true),/PLANNING_GENERATION_EXISTS/);
 const resumed=p.startGeneration(recovered,'next',recovered.revision,true,'resume');assert.equal(resumed.generationDraft.routeId,routeID);assert.throws(()=>p.saveGenerationProgress(resumed,{routeId:routeID,outline,chapters:[chapter(0,5),chapter(1,1)]},'gen',base),/PLANNING_CONFLICT/);
 const full=checkpoint(resumed,[chapter(0,5),chapter(1,1)],'next'),draft=full.generationDraft;
 const route={format:'vibe-improve.route',schemaVersion:2,id:routeID,revision:1,title:outline.result.title,locale:'en',sourceLanguage:'en',chapters:draft.chapters};
 assert.throws(()=>p.applyGenerated(full,{...route,title:'Unexpected'},'next',full.revision),/PLANNING_GENERATION_INVALID/);
 const applied=p.applyGenerated(full,route,'next',full.revision);assert.deepEqual(applied.routeDraft,route);assert.equal(applied.generationDraft,undefined);assert.equal(applied.pending,undefined);assert.equal(applied.step,'editor');assert.deepEqual(applied.history.past.at(-1),old);
});

test('resume binds semantic context and original route, permits model switching, and restart is explicit',()=>{
 let state=withOld();state=p.startGeneration(state,'gen',state.revision,true);state=checkpoint(state);state=p.cancelPlanningRequest(state,'gen',state.revision);
 state=p.setAgentOptions(state,{model:'another-model',effort:'low'},state.revision);state=p.focusQuestion(state,'purpose',state.revision);state=p.setProvider(state,'codex',state.revision);assert.equal(p.generationProgress(state).resumable,true);
 const changed=p.setResources(state,'New resource constraints',state.revision);assert.equal(p.generationProgress(changed).resumable,false);
 let ready=p.beginConsistencyCheck(changed,'check',changed.revision);ready=p.applyConsistencyCheck(ready,{reply:'Compatible.',consistency:{status:'consistent',issues:[]}},'check',ready.revision);
 assert.throws(()=>p.startGeneration(ready,'again',ready.revision,true,'resume'),/PLANNING_GENERATION_STALE/);
 const restarted=p.startGeneration(ready,'again',ready.revision,true,'restart');assert.equal(restarted.generationDraft,undefined);assert.deepEqual(restarted.routeDraft,state.routeDraft);
 let editor=p.openEditor(state,state.revision);editor=p.saveEditor(editor,{...editor.routeDraft,title:'Changed original'},editor.revision);editor=p.reopenIntake(editor,editor.revision);assert.equal(p.generationProgress(editor).resumable,false);
 const legacy=collected();assert.equal(p.validatePlanning(legacy),legacy);assert.equal(p.generationProgress(legacy),null);
});

test('corrupt caches, incomplete batches, future dependencies and rewritten prefixes are rejected',()=>{
 let state=collected();state=p.startGeneration(state,'gen',state.revision);
 for(const parts of [[chapter(0,1),null],[{...chapter(0,3),id:'other'},null]])assert.throws(()=>checkpoint(state,parts),/PLANNING_GENERATION_INVALID/);
 const future=chapter(0,3);future.nodes[0].prerequisites=['node_1_4'];assert.throws(()=>checkpoint(state,[future,null]),/PLANNING_GENERATION_INVALID/);
 const saved=checkpoint(state),tampered=structuredClone(saved);tampered.generationDraft.extra='unknown';assert.throws(()=>p.validatePlanning(tampered),/PLANNING_GENERATION_INVALID/);
 const changed=chapter(0,5);changed.nodes[0].objectives[0].description='Replaced saved content';assert.throws(()=>checkpoint(saved,[changed,null]),/PLANNING_CONFLICT/);
 const half=structuredClone(saved);half.generationDraft.chapters[0].nodes[0].activities=[];assert.throws(()=>p.validatePlanning(half),/PLANNING_GENERATION_INVALID/);
});

test('UI and bridge expose saved progress, explicit resume/restart and stale-context blocking',async()=>{
 const parent=resolve('tmp/checks/generation-resume-2026-11-04');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'ui-')),bundle=join(dir,'ui.mjs');
 await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage';export {default as Dialog} from './apps/local-ui/src/components/PlanningGenerationDialog';export {planningService} from './apps/local-ui/src/planning/service';export {generateWithConsistency} from './apps/local-ui/src/planning/generation';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle,logLevel:'silent'});
 const ui=await import(pathToFileURL(bundle).href),render=(component,props)=>ui.renderToStaticMarkup(ui.createElement(component,props));
 let state=collected();state=p.startGeneration(state,'gen',state.revision);state=checkpoint(state);state=p.cancelPlanningRequest(state,'gen',state.revision);
 for(const language of ['zh-CN','en']){
  const html=render(ui.PlanningIntakeSurface,{state,language});assert.match(html,language==='en'?/Generation progress saved/:/已保存生成进度/);assert.match(html,language==='en'?/>Resume generation</:/>继续生成</);assert.match(html,language==='en'?/>Start again</:/>重新生成</);
  const modal=render(ui.Dialog,{language,entries:[],running:false,error:'Synthetic timeout',reviewNeeded:false,savedProgress:p.generationProgress(state),onResume:()=>{}});assert.match(modal,language==='en'?/>Resume generation</:/>继续生成</);
 }
 const stale=p.setResources(state,'New context',state.revision),staleHTML=render(ui.PlanningIntakeSurface,{state:stale,language:'en'});assert.match(staleHTML,/Background or route changed/);assert.match(staleHTML,/disabled=""[^>]*data-layout-control="game-button"/);
 const calls=[];globalThis.window={vibeNative:{projects:{request:async(action,value)=>{calls.push({action,value});return {id:'job-'+calls.length,projectId:project,intent:'generate',state:'pending'}}}}};
 try{for(const mode of ['resume','restart'])await ui.planningService.begin(state,'generate',undefined,undefined,undefined,true,mode)}finally{delete globalThis.window}
 assert.deepEqual(calls.map(c=>c.value.generationMode),['resume','restart']);assert.ok(calls.every(c=>c.value.replaceExisting===true));
 const requested=[];assert.equal(await ui.generateWithConsistency(()=>state,async(...args)=>{requested.push(args);return true},true,'resume'),true);assert.deepEqual(requested,[['generate',true,'resume']]);
});

test('native timeout persists batches, restart skips them, and full cache commits without invoking CLI',{skip:process.platform!=='darwin',timeout:240000},async()=>{
 const parent=resolve('tmp/checks/generation-resume-2026-11-04');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const source=join(dir,'main.swift'),fixture=join(dir,'fixture.py'),initial=join(dir,'initial.json'),validator=join(dir,'planning.js'),binary=join(dir,'verify');
 await writeFile(initial,JSON.stringify(withOld()));await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',outfile:validator,target:'safari15',logLevel:'silent'});
 await writeFile(fixture,String.raw`import json,os,sys,time
phase=sys.argv[1]
def emit(v):print(json.dumps(v),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':m['request_id'],'subtype':'success','response':{}}})
 elif m.get('type')=='user':
  text=m['message']['content'][0]['text'];c=json.loads(text.split('CONTEXT_JSON_DATA:',1)[1]);lessons=c.get('requestedLessons')
  record={'phase':phase,'refs':[n['ref'] for n in lessons] if lessons else []}
  with open('requests.ndjson','a') as f:f.write(json.dumps(record)+'\n')
  if not lessons:
   value={'title':'CSV practice','chapters':[{'title':'Foundations','stageGoal':'Apply five named concepts.','lessons':[{'title':'Concept '+str(i),'focus':'Study, practice and explain.'} for i in range(1,6)]},{'title':'Application','stageGoal':'Create a report.','lessons':[{'title':'Report','focus':'Complete a report independently.'}]}]}
  else:
   if phase=='first' and lessons[0]['ref']=='L4':time.sleep(8)
   else:time.sleep(.08)
   available=[n['ref'] for n in c['availablePrerequisites']];nodes=[]
   for n in lessons:
    nodes.append({'ref':n['ref'],'objectives':['Apply the named concept in a practice case.'],'prerequisites':available[-1:],'estimatedMinutes':30,'activities':['Study a worked example.','Solve a new case and compare.'],'assessment':None});available.append(n['ref'])
   value={'nodes':nodes}
  value={'status':'ok','reply':'Saved stage ready.','result':value,'missing':[]};payload=json.dumps(value)
  emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}});emit({'type':'result','subtype':'success','is_error':False,'result':payload})
  for line in sys.stdin:pass
  sys.exit(0)
`);
 await writeFile(source,`import Foundation
import Darwin
func check(_ condition:Bool,_ message:String){if !condition{fputs(message+"\\n",stderr);exit(1)}}
let root=URL(fileURLWithPath:CommandLine.arguments[1]),fixture=CommandLine.arguments[2],validator=URL(fileURLWithPath:CommandLine.arguments[3]),initial=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[4]))
try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
let id="${project}",runtime=try RuntimeDirectory(url:root.appendingPathComponent("runtime")),files=try runtime.child("projects").child("planning")
try files.write(id+".json",data:initial)
let agents=try AgentManager(runtime:runtime,projectWorkspace:{_ in root})
func store()throws->PlanningStore{try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in root})}
func run(_ phase:String,_ store:PlanningStore,_ before:[String:Any],_ failCommit:Bool=false)throws->[String:Any]{
 var prepares=0
 let launch=try AgentSessionLaunch(provider:"codebuddy",projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,phase,"--tools",""],workspace:root,environment:ProcessInfo.processInfo.environment)
 let manager=PlanningAgentManager(agents:agents,timeout:phase=="first" ? 1.5:6,prepare:{_ in prepares+=1;return AgentSessionPreparation(projectID:id,provider:"codebuddy",launch:launch)})
 let rev=(before["revision"] as! NSNumber).intValue,request="request_"+phase
 let state=try store.startGeneration(projectID:id,requestID:request,expectedRevision:rev,replaceExisting:true,generationMode:phase=="first" ? "new":"resume"),base=(state["revision"] as! NSNumber).intValue
 let job=try manager.begin(projectID:id,intent:"generate",context:state,saveProgress:{progress in _ = try store.saveGenerationProgress(projectID:id,progress:progress,requestID:request,baseRevision:base)},validateRoute:{route in
  let details=try store.agentRouteDiagnostics(projectID:id,route:route);if !(details["issues"] as! [[String:String]]).isEmpty{throw PlanningError.route}
 }){value in if failCommit{throw PlanningError.storage};return try store.applyGenerated(projectID:id,route:value["route"] as! [String:Any],requestID:request,baseRevision:base)}
 var result:[String:Any]=[:];let end=Date().addingTimeInterval(10)
 repeat{result=try manager.state(projectID:id,jobID:job["id"] as! String);if result["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.02)}while Date()<end
 manager.shutdown()
 if phase=="finish"{check(prepares==0,"full cached route contacted CLI")}else{check(prepares==1,"wrong prepare count")}
 return result
}
let firstStore=try store(),before=try firstStore.read(projectID:id)!,old=try JSONSerialization.data(withJSONObject:before["routeDraft"]!,options:.sortedKeys)
let first=try run("first",firstStore,before);check(first["errorCode"] as? String=="PLANNING_AGENT_TIMEOUT","first request did not time out: \\(first)")
let saved=try firstStore.read(projectID:id)!,draft=saved["generationDraft"] as! [String:Any],parts=draft["chapters"] as! [Any]
check((parts[0] as! [String:Any])["nodes"] as? [[String:Any]] != nil,"first batch not saved")
check(((parts[0] as! [String:Any])["nodes"] as! [[String:Any]]).count==3,"incomplete batch was saved")
check(try JSONSerialization.data(withJSONObject:saved["routeDraft"]!,options:.sortedKeys)==old,"timeout replaced old route")
let secondStore=try store(),recovered=try secondStore.read(projectID:id)!;check(recovered["pending"]==nil,"restart did not recover pending")
let second=try run("second",secondStore,recovered,true);check(second["errorCode"] as? String=="PLANNING_STORAGE_UNAVAILABLE","commit fixture did not fail: \\(second)")
let complete=try secondStore.read(projectID:id)!;check(try JSONSerialization.data(withJSONObject:complete["routeDraft"]!,options:.sortedKeys)==old,"failed final commit replaced route")
let finalStore=try store(),ready=try finalStore.read(projectID:id)!,final=try run("finish",finalStore,ready)
check(final["state"] as? String=="completed","full cache could not finish: \\(final)")
let applied=try finalStore.read(projectID:id)!,route=applied["routeDraft"] as! [String:Any]
check(applied["generationDraft"]==nil && applied["pending"]==nil && applied["step"] as? String=="editor","final commit was not atomic")
check(route["id"] as? String==draft["routeId"] as? String,"route id changed on resume")
let requests=try String(contentsOf:root.appendingPathComponent("requests.ndjson"),encoding:.utf8).split(separator:"\\n").map{try JSONSerialization.jsonObject(with:Data($0.utf8)) as! [String:Any]}
let resumed=requests.filter{$0["phase"] as? String=="second"};check(resumed.count==1 && resumed[0]["refs"] as? [String]==["L4","L5"],"resumed completed work: \\(resumed)")
print("PASS durable timeout, restart, skipped batches, retained original and offline final commit")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningStore.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:200000});await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'data'),fixture,validator,initial],{encoding:'utf8',timeout:30000});await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS durable/);console.log('Resume evidence: '+dir);
});
