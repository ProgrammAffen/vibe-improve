import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import * as p from '../packages/domain/planning.mjs';
const id='proj_12345678-1234-4234-8234-123456789abc',now='2026-11-09T08:00:00.000Z',consistent={status:'consistent',issues:[]};
const answers={goal:{topic:'Market basics',outcome:'Read market news; no trading practice yet'},purpose:{context:'Personal study',criteria:'Explain the main market terms'},baseline:{experience:'No prior study'},time:{weekly:'Five hours',session:'One hour'}};
function propose(state,questionId,fields,assessment=consistent){
 if(state.currentQuestion!==questionId)state=p.focusQuestion(state,questionId,state.revision);
 const requestId='r_'+state.revision,messageId='u_'+state.revision;
 state=p.appendUser(state,JSON.stringify(fields),messageId,requestId,state.revision,now);
 const result={reply:'Please confirm this answer and any listed updates.',summary:Object.values(fields).join(' / '),updates:[{id:questionId,fields,evidence:Object.keys(fields).map(field=>({field,messageId,quote:fields[field]})),complete:true,missing:[]}]};
 if(assessment)result.consistency=assessment;
 return p.applyInterview(state,result,requestId,state.revision,now);
}
function accept(state,questionId=state.currentQuestion){return p.acceptAnswer(state,questionId,state.questions.find(q=>q.id===questionId).answerProposal.messageId,state.revision,now)}
function collected(count=1){let state=p.createPlanning(id,'codebuddy','en');for(const [questionId,fields] of Object.entries(answers).slice(0,count))state=accept(propose(state,questionId,fields));return state}
const goalUpdate=()=>({questionId:'goal',fields:['outcome'],kind:'incompatible',reason:'You explicitly chose to add simulated order practice to the initial basics-only goal.',suggestion:{summary:'Learn market basics, then practise simulated orders.',fields:{outcome:'Read market news, then practise placing orders in a simulated account'}}});
const needsReview=(...issues)=>({status:'requires_review',issues});
const purposeFields={context:'Personal practice',criteria:'Explain market news and place a simulated order independently'};
const pendingUpdate=()=>propose(collected(),'purpose',purposeFields,needsReview(goalUpdate()));

test('related answer adjustment is staged on the current question and atomically confirmed before advancing',()=>{
 const initial=collected(),oldFacts=p.planningFactsHash(initial),pending=propose(initial,'purpose',purposeFields,needsReview(goalUpdate())),before=structuredClone(pending);
 const confirmation=p.answerConfirmation(pending,'purpose');
 assert.equal(confirmation.kind,'update');assert.equal(confirmation.canAccept,true);assert.equal(confirmation.changes.length,1);
 assert.deepEqual(confirmation.changes[0].before,initial.questions[0].acceptedSnapshot);
 assert.deepEqual(confirmation.changes[0].after.fields,{...answers.goal,...goalUpdate().suggestion.fields});
 assert.equal(pending.currentQuestion,'purpose');assert.equal(pending.questions[0].status,'complete');assert.equal(pending.questions[1].status,'awaiting-confirmation');
 assert.equal(p.planningFactsHash(pending),oldFacts);assert.deepEqual(pending.consistency.issues,[]);assert.deepEqual(pending,before);
 const confirmed=accept(pending);
 assert.equal(confirmed.currentQuestion,'baseline');assert.equal(confirmed.questions[0].status,'complete');assert.equal(confirmed.questions[1].status,'complete');
 assert.deepEqual(confirmed.questions[0].fields,confirmation.changes[0].after.fields);assert.deepEqual(confirmed.questions[1].fields,purposeFields);
 assert.equal(confirmed.backgroundEpoch,pending.backgroundEpoch+1);assert.equal(confirmed.questions[0].acceptedSnapshot.revision,2);
 assert.equal(confirmed.consistency.status,'dirty');assert.equal(confirmed.consistency.issues.length,0);assert.equal(confirmed.consistency.anchorQuestionId,'purpose');
 assert.equal(confirmed.answerEvents.length,1);assert.equal(confirmed.answerEvents[0].sourceRequestId,pending.questions[1].answerProposal.messageId.slice(10));
 const event=confirmed.answerEvents[0],updatedEvidence=confirmed.questions[0].evidence.find(e=>e.field==='outcome');
 assert.equal(updatedEvidence.acceptanceEventId,event.id);assert.equal(updatedEvidence.messageId,undefined);
 assert.deepEqual(confirmed.messages,pending.messages);assert.deepEqual(pending,before);
 assert.equal(p.canGenerate(confirmed),false);assert.throws(()=>p.acceptAnswer(confirmed,'purpose',pending.questions[1].answerProposal.messageId,confirmed.revision),/CONFLICT/);
});

test('normal specificity confirms only the current answer and advances once',()=>{
 const before=collected(),pending=propose(before,'purpose',purposeFields),confirmation=p.answerConfirmation(pending,'purpose');
 assert.equal(confirmation.kind,'confirm');assert.deepEqual(confirmation.changes,[]);
 const confirmed=accept(pending);assert.deepEqual(confirmed.questions[0],before.questions[0]);assert.equal(confirmed.currentQuestion,'baseline');assert.equal(confirmed.answerEvents,undefined);
});

test('multiple earlier corrections are one commit and their jointly changed facts are checked again',()=>{
 const purpose={questionId:'purpose',fields:['criteria'],kind:'incompatible',reason:'You explicitly broadened the practice goal.',suggestion:{summary:'Explain market news and practise simulated orders.',fields:{criteria:'Explain market news and place simulated orders'}}};
 let pending=propose(collected(2),'baseline',{experience:'Beginner, and I want both basics and simulated practice.'},needsReview(goalUpdate(),purpose));
 const confirmation=p.answerConfirmation(pending,'baseline');assert.equal(confirmation.changes.length,2);
 let state=accept(pending);assert.equal(state.currentQuestion,'time');assert.equal(state.answerEvents.length,2);assert.equal(new Set(state.answerEvents.map(event=>event.epoch)).size,1);
 assert.equal(state.questions[0].fields.topic,answers.goal.topic);assert.equal(state.questions[1].fields.context,answers.purpose.context);
 state=accept(propose(state,'time',answers.time,null));assert.equal(p.canRequestGeneration(state),true);assert.equal(p.canGenerate(state),false);
 const job='final_check';state=p.beginConsistencyCheck(state,job,state.revision);state=p.applyConsistencyCheck(state,{reply:'Current confirmed facts are compatible.',consistency:consistent},job,state.revision,now);
 assert.equal(p.canGenerate(state),true);assert.equal(state.currentQuestion,null);
});

for(const [label,mutate] of [
 ['uncertain intent',issue=>{issue.kind='uncertain'}],
 ['no correction',issue=>{issue.suggestion=null}],
 ['partial correction',issue=>{issue.fields=['topic','outcome']}],
 ['unchanged correction',issue=>{issue.suggestion.fields.outcome=answers.goal.outcome}],
 ['current-question correction',issue=>{issue.questionId='purpose';issue.fields=['criteria'];issue.suggestion.fields={criteria:'A different criterion'}}]
])test(`${label} keeps the current question and cannot partially adopt any answer`,()=>{
 const issue=goalUpdate();mutate(issue);const pending=propose(collected(),'purpose',purposeFields,needsReview(issue)),before=structuredClone(pending),result=p.answerConfirmation(pending,'purpose');
 assert.equal(result.kind,'clarify');assert.equal(result.canAccept,false);assert.deepEqual(result.changes,[]);assert.equal(pending.currentQuestion,'purpose');
 assert.throws(()=>accept(pending),/INCOMPLETE/);assert.deepEqual(pending,before);assert.deepEqual(pending.questions[0].fields,answers.goal);assert.equal(pending.questions[1].acceptedSnapshot,undefined);
});

test('one unresolved issue blocks the entire multi-answer change',()=>{
 const uncertain={questionId:'purpose',fields:['criteria'],kind:'uncertain',reason:'Intent is not clear yet.',suggestion:null},pending=propose(collected(2),'baseline',answers.baseline,needsReview(goalUpdate(),uncertain)),before=structuredClone(pending);
 assert.equal(p.answerConfirmation(pending,'baseline').kind,'clarify');assert.throws(()=>accept(pending),/INCOMPLETE/);assert.deepEqual(pending,before);
});

test('continuing the current conversation replaces only the unconfirmed summary',()=>{
 const pending=pendingUpdate(),original=structuredClone(pending.questions[0]),fields={context:'Personal study',criteria:'Explain market news without practising orders'};
 const next=propose(pending,'purpose',fields,consistent);assert.equal(next.currentQuestion,'purpose');assert.deepEqual(next.questions[0],original);
 assert.equal(p.answerConfirmation(next,'purpose').kind,'confirm');assert.notEqual(next.questions[1].answerProposal.messageId,pending.questions[1].answerProposal.messageId);
 const accepted=accept(next);assert.deepEqual(accepted.questions[0],original);assert.equal(accepted.questions[1].fields.criteria,fields.criteria);assert.equal(accepted.currentQuestion,'baseline');
});

test('restart persistence preserves the exact displayed changes and stale facts cannot be accepted',()=>{
 const pending=pendingUpdate(),restored=p.recoverPlanning(JSON.parse(JSON.stringify(pending)),now);
 assert.deepEqual(p.answerConfirmation(restored,'purpose'),p.answerConfirmation(pending,'purpose'));assert.deepEqual(accept(restored),accept(pending));
 const updated=p.setResources(restored,'A newly selected learning resource',restored.revision),before=structuredClone(updated);
 assert.equal(p.answerConfirmation(updated,'purpose').kind,'stale');assert.throws(()=>accept(updated),/CONFLICT/);assert.deepEqual(updated,before);
 const oldVersion=structuredClone(pending);oldVersion.questions[1].answerProposal.consistency.version='answer-consistency.v0';assert.equal(p.answerConfirmation(oldVersion,'purpose').kind,'stale');assert.throws(()=>accept(oldVersion),/CONFLICT/);
});

test('confirmed related answers preserve existing route data and edit history until regeneration succeeds',async()=>{
 let pending=pendingUpdate();const route=p.upgradeRoute(JSON.parse(await readFile('contracts/examples/route.valid.json','utf8')));for(const chapter of route.chapters)chapter.stageGoal='Complete this stage.';
 pending.routeDraft=route;pending.history={past:[structuredClone(route)],future:[]};p.validatePlanning(pending);
 const before=structuredClone(pending),confirmed=accept(pending);
 assert.deepEqual(confirmed.routeDraft,before.routeDraft);assert.deepEqual(confirmed.history,before.history);assert.equal(confirmed.intakeChanged,true);assert.deepEqual(pending,before);
});

test('late consistency findings and legacy suggestion adoption preserve the visible question',()=>{
 let state=collected(4);state=p.focusQuestion(state,'time',state.revision);state=p.beginConsistencyCheck(state,'late_findings',state.revision);
 state=p.applyConsistencyCheck(state,{reply:'Check the related goal.',consistency:needsReview(goalUpdate())},'late_findings',state.revision,now);
 assert.equal(state.currentQuestion,'time');assert.equal(p.intakeCurrentQuestion(state),'time');assert.equal(p.canRequestGeneration(state),false);
 const issue=state.consistency.issues[0];state=p.acceptConsistencySuggestion(state,issue.id,state.revision,now);
 assert.equal(state.currentQuestion,'time');assert.equal(p.canGenerate(state),false);assert.equal(p.canRequestGeneration(state),true);
 let overview=collected(4);assert.equal(overview.currentQuestion,null);overview=p.beginConsistencyCheck(overview,'overview_check',overview.revision);overview=p.applyConsistencyCheck(overview,{reply:'Check the related goal.',consistency:needsReview(goalUpdate())},'overview_check',overview.revision,now);
 assert.equal(overview.currentQuestion,null);assert.equal(p.intakeCurrentQuestion(overview),null);
});

test('native store confirms current and related answers together and reloads the next question',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
 const parent=resolve('tmp/checks/inline-answer-confirmation-2026-11-09');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const fixture=join(dir,'state.json'),bundle=join(dir,'planning.js'),source=join(dir,'main.swift'),binary=join(dir,'verify'),pending=pendingUpdate();
 await writeFile(fixture,JSON.stringify(pending));await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:bundle,logLevel:'silent'});
 await writeFile(source,`import Foundation
import JavaScriptCore
func check(_ condition:Bool,_ message:String){if !condition{fputs(message+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1]),validator=URL(fileURLWithPath:CommandLine.arguments[2]),fixture=URL(fileURLWithPath:CommandLine.arguments[3]),id="${id}"
let runtime=try RuntimeDirectory(url:base.appendingPathComponent("runtime")),workspace=base.appendingPathComponent("workspace")
try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
let files=try runtime.child("projects").child("planning")
var state=try JSONSerialization.jsonObject(with:Data(contentsOf:fixture)) as! [String:Any]
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:state))
let store=try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in workspace})
state=try store.read(projectID:id)!
let proposal=(state["questions"] as! [[String:Any]])[1]["answerProposal"] as! [String:Any]
state=try store.acceptAnswer(projectID:id,questionID:"purpose",messageID:proposal["messageId"] as! String,expectedRevision:state["revision"] as! Int)
check(state["currentQuestion"] as? String=="baseline","confirmation jumped backwards")
check((state["answerEvents"] as? [[String:Any]])?.count==1,"related confirmation event missing")
let reopened=try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in workspace})
let restored=try reopened.read(projectID:id)!
check(NSDictionary(dictionary:restored).isEqual(to:state),"confirmed answers changed after restart")
try JSONSerialization.data(withJSONObject:restored).write(to:base.appendingPathComponent("confirmed.json"))
print("PASS native inline answer confirmation and restart")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[dir,bundle,fixture],{encoding:'utf8',timeout:30_000});await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stdout+run.stderr);
 const saved=JSON.parse(await readFile(join(dir,'confirmed.json'),'utf8'));assert.equal(saved.currentQuestion,'baseline');assert.deepEqual(saved.questions[0].fields,p.answerConfirmation(pending,'purpose').changes[0].after.fields);assert.equal(saved.questions[1].status,'complete');p.validatePlanning(saved);
 console.log('Inline confirmation evidence: '+dir);
});
