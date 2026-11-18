import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {createPlanning,appendUser,applyEdit,applyProposal,discardProposal,saveEditor,validatePlanning,undoEditor,redoEditor} from '../packages/domain/planning.mjs';
import {routeChanges,messageEditRoutes} from '../packages/domain/route-changes.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc';
const review=()=>({content:'Recall the roles of model, instructions and tools. Explain the query flow without notes.',passCriteria:['Explain all three roles correctly.','Base the reply on actual tool results.','Distinguish missing orders from failed queries.']});
const node=(id)=>({id,title:'Lesson '+id,objectives:[{id:'goal',description:'Explain the tool workflow.'}],estimatedMinutes:30,prerequisites:[]});
const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'synthetic',revision:1,title:'Synthetic route',locale:'en',sourceLanguage:'en',chapters:[{id:'chapter',title:'Chapter',stageGoal:'Explain the workflow.',nodes:[{...node('first'),review:{content:'',passCriteria:['']}},node('second')]}]});
function proposal(){
 let state=createPlanning(project,'codex','en');
 state={...state,step:'editor',routeDraft:route()};state=validatePlanning(state);
 state=appendUser(state,'Complete the review for lesson 1.1.','user1','request1',state.revision);
 const next=structuredClone(state.routeDraft);next.chapters[0].nodes[0].review=review();
 return applyEdit(state,{reply:'Review content and criteria prepared. Please inspect the proposed changes.',route:next},'request1',state.revision);
}
test('review changes show complete content and each criterion instead of the agent summary',()=>{
 const state=proposal(),changes=routeChanges(state.routeDraft,state.proposal.route,'en');
 assert.equal(changes.length,1);assert.equal(changes[0].number,'1.1');assert.equal(changes[0].id,'first');
 assert.deepEqual(changes[0].fields.map(field=>field.key),['reviewContent','reviewCriteria']);
 assert.deepEqual(changes[0].fields[0],{key:'reviewContent',before:[],after:[review().content]});
 assert.deepEqual(changes[0].fields[1].after,review().passCriteria);
 assert.equal(state.routeDraft.chapters[0].nodes[0].review.content,'');
 const source=state.messages.at(-1),preview=messageEditRoutes(state,source);
 assert.equal(preview.status,'pending');assert.deepEqual(preview.before,state.routeDraft);assert.deepEqual(preview.after,state.proposal.route);
});
test('adopted changes retain a compact receipt and recover their actual before and after from saved history',()=>{
 let state=proposal();const messageId=state.messages.at(-1).id;
 state=applyProposal(state,state.revision);state=validatePlanning(JSON.parse(JSON.stringify(state)));
 assert.equal(state.proposal,undefined);
 let message=state.messages.find(message=>message.id===messageId),preview=messageEditRoutes(state,message);
 assert.equal(preview.status,'applied');assert.equal(preview.before.revision,1);assert.equal(preview.after.revision,2);
 assert.deepEqual(preview.after.chapters[0].nodes[0].review,review());
 assert.ok(JSON.stringify(message.routeEdit).length<400);
 const unrelated=structuredClone(state.routeDraft);unrelated.chapters[0].nodes[1].title='Rename another lesson';
 state=saveEditor(state,unrelated,state.revision);
 preview=messageEditRoutes(state,message);assert.equal(preview.after.revision,2);
 state=undoEditor(state,state.revision);state=redoEditor(state,state.revision);
 preview=messageEditRoutes(state,message);assert.equal(preview.status,'applied');assert.deepEqual(preview.after.chapters[0].nodes[0].review,review());
});
test('discarded or replaced proposals never appear as adopted changes',()=>{
 let state=proposal(),message=state.messages.at(-1);
 state=discardProposal(state,state.revision);assert.equal(messageEditRoutes(state,message).status,'not-applied');
 state=proposal();message=state.messages.at(-1);
 const changed=structuredClone(state.routeDraft);changed.title='Manual change';state=saveEditor(state,changed,state.revision);
 assert.equal(messageEditRoutes(state,message).status,'not-applied');
});
test('previews describe quiz, elective changes, reordering, additions and removals by stable lesson IDs',()=>{
 const before=route(),after=route();after.chapters[0].nodes.reverse();
 const first=after.chapters[0].nodes.find(node=>node.id==='first');
 first.requirement='optional';first.assessment={task:'Choose a read-only tool and explain the result.',answer:'Accept valid tool choices and equivalent explanations.',objectiveIds:['goal']};
 after.chapters[0].nodes.push(node('third'));
 const changes=routeChanges(before,after,'en'),edited=changes.find(change=>change.id==='first');
 assert.equal(edited.number,'1.2');assert.ok(edited.fields.some(field=>field.key==='position'&&field.before[0]==='1.1'&&field.after[0]==='1.2'));
 assert.ok(edited.fields.some(field=>field.key==='answer'&&field.after[0]===first.assessment.answer));
 assert.ok(edited.fields.some(field=>field.key==='requirement'&&field.after[0]==='optional'));
 assert.equal(changes.find(change=>change.id==='third').status,'added');
 after.chapters[0].nodes=after.chapters[0].nodes.filter(node=>node.id!=='second');
 assert.equal(routeChanges(before,after).find(change=>change.id==='second').status,'removed');
});

test('dependency changes between identically named lessons show their actual chapter numbers',()=>{
 const before=route();before.chapters[0].nodes.forEach(node=>node.title='Repeated lesson title');
 before.chapters[0].nodes.push({...node('third'),prerequisites:['first']});
 const after=structuredClone(before);after.chapters[0].nodes[2].prerequisites=['second'];
 const changes=routeChanges(before,after),dependency=changes[0].fields.find(field=>field.key==='prerequisites');
 assert.equal(changes.length,1);assert.equal(changes[0].number,'1.3');
 assert.deepEqual(dependency.before,['1.1 Repeated lesson title']);
 assert.deepEqual(dependency.after,['1.2 Repeated lesson title']);
});

test('every editable route field exposes actual values, including questions, answers and disabling review',()=>{
 const before=route();before.chapters[0].nodes[0].review=review();
 const mutations=[
  ['title',r=>r.title='Renamed route'],['title',r=>r.chapters[0].title='Renamed chapter'],
  ['stageGoal',r=>r.chapters[0].stageGoal='A concrete new stage goal.'],['title',r=>r.chapters[0].nodes[0].title='Renamed lesson'],
  ['objectives',r=>r.chapters[0].nodes[0].objectives[0].description='A different observable skill.'],
  ['estimatedMinutes',r=>r.chapters[0].nodes[0].estimatedMinutes=45],['activities',r=>r.chapters[0].nodes[0].activities=['Practice with a new example.']],
  ['requirement',r=>r.chapters[0].nodes[0].requirement='optional'],
  ['quiz',r=>r.chapters[0].nodes[0].assessment={task:'Choose and explain a read-only tool.',answer:'Accept a justified choice.',objectiveIds:['goal']}],
  ['answer',r=>r.chapters[0].nodes[0].assessment={task:'Choose and explain a read-only tool.',answer:'Accept equivalent implementations.',objectiveIds:['goal']}],
  ['reviewContent',r=>r.chapters[0].nodes[0].review.content='Recall a new concrete example.'],
  ['reviewCriteria',r=>r.chapters[0].nodes[0].review.passCriteria.push('Handle one counterexample.')],
  ['reviewEnabled',r=>delete r.chapters[0].nodes[0].review],
 ];
 for(const [key,mutate] of mutations){const after=structuredClone(before);mutate(after);assert.ok(routeChanges(before,after).some(change=>change.fields.some(field=>field.key===key)),key)}
});

test('plain replies and identical candidates are explicitly marked as not changing the route',()=>{
 let state=proposal();state=applyProposal(state,state.revision);
 for(const identical of [false,true]){
  const original=structuredClone(state.routeDraft),request='reply_'+state.revision;
  state=appendUser(state,'Explain the first lesson.','user_'+state.revision,request,state.revision);
  const candidate=identical?{...state.routeDraft,revision:state.routeDraft.revision+1}:null;
  state=applyEdit(state,{reply:'A plain response with no applied change.',route:candidate},request,state.revision);
  assert.equal(state.messages.at(-1).editOutcome,'no-changes');assert.equal(state.messages.at(-1).routeEdit,undefined);
  assert.deepEqual(state.routeDraft,original);
 }
 const invalid=structuredClone(state);invalid.messages.at(-1).role='user';assert.throws(()=>validatePlanning(invalid),/PLANNING_INVALID/);
 let pending=proposal();const preview=structuredClone(pending.proposal),request='clarification';
 pending=appendUser(pending,'Explain your proposal.','clarify',request,pending.revision);
 pending=applyEdit(pending,{reply:'Here is the explanation.',route:null},request,pending.revision);
 assert.deepEqual(pending.proposal,preview);assert.equal(pending.messages.at(-1).editOutcome,'no-changes');
});

test('malformed change receipts are rejected and pruned history never resolves to a different edit',()=>{
 const applied=applyProposal(proposal(),proposal().revision),message=applied.messages.at(-1);
 for(const mutate of [m=>m.role='user',m=>m.questionId='goal',m=>m.routeEdit.afterRevision=m.routeEdit.beforeRevision,m=>m.routeEdit.beforeHash='bad',m=>m.routeEdit.extra=true]){
  const copy=structuredClone(applied);mutate(copy.messages.at(-1));assert.throws(()=>validatePlanning(copy),/PLANNING_INVALID/);
 }
 applied.history.past=[];
 const changed=structuredClone(applied.routeDraft);changed.chapters[0].nodes[0].review.content='A later, different revision.';
 applied.routeDraft=changed;
 const preview=messageEditRoutes(applied,message);
 assert.equal(preview.status,'applied');assert.equal(preview.before,undefined);assert.equal(preview.after,undefined);
});

test('native store persists adopted changes and restores their complete preview across restart',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
 await mkdir('tmp/checks/route-preview',{recursive:true});const dir=await mkdtemp(resolve('tmp/checks/route-preview/native-'));
 const before=route();delete before.chapters[0].nodes[0].review;
 const after=structuredClone(before);after.chapters[0].nodes[0].review=review();
 await mkdir(join(dir,'Workspace'));await writeFile(join(dir,'before.json'),JSON.stringify(before));await writeFile(join(dir,'after.json'),JSON.stringify(after));
 const validator=join(dir,'planning.js'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:validator});
 await writeFile(source,`import Foundation
let root=URL(fileURLWithPath:CommandLine.arguments[1]),id="${project}"
func store()throws->PlanningStore{try PlanningStore(runtime:RuntimeDirectory(url:root.appendingPathComponent("Runtime")),validatorURL:root.appendingPathComponent("planning.js"),workspace:{_ in root.appendingPathComponent("Workspace")})}
func load(_ name:String)throws->[String:Any]{try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent(name))) as! [String:Any]}
let first=try store(),entered=try first.enter(projectID:id,provider:"codex",locale:"en",route:load("before.json"))
let pending=try first.appendUser(projectID:id,text:"Complete the first lesson review.",messageID:"user1",requestID:"request1",expectedRevision:entered["revision"] as! Int)
_ = try first.applyEdit(projectID:id,result:["reply":"Review content and criteria prepared.","route":load("after.json")],requestID:"request1",baseRevision:pending["revision"] as! Int)
let resumed=try store(),proposed=try resumed.read(projectID:id)!
precondition(proposed["proposal"] != nil)
let adopted=try resumed.applyProposal(projectID:id,expectedRevision:proposed["revision"] as! Int)
let final=try store().read(projectID:id)!
precondition(final["proposal"] == nil)
let message=(final["messages"] as! [[String:Any]]).last!,receipt=message["routeEdit"] as! [String:Any]
precondition(receipt["afterRevision"] as? Int==2 && (receipt["beforeHash"] as? String)?.count==64 && (receipt["afterHash"] as? String)?.count==64)
try JSONSerialization.data(withJSONObject:final).write(to:root.appendingPathComponent("saved.json"))
print("Native proposal preview verified")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});
 await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[dir],{encoding:'utf8',timeout:20_000});assert.equal(run.status,0,run.stderr);
 const saved=validatePlanning(JSON.parse(await readFile(join(dir,'saved.json'),'utf8'))),preview=messageEditRoutes(saved,saved.messages.at(-1));
 assert.equal(preview.status,'applied');assert.deepEqual(preview.after.chapters[0].nodes[0].review,review());
 assert.equal(routeChanges(preview.before,preview.after)[0].number,'1.1');
});
test('receipt validation rejects user claims, unknown keys and impossible revisions; old saved conversations remain readable',()=>{
 const state=proposal(),message=state.messages.at(-1);
 for(const bad of [{...message.routeEdit,afterRevision:1},{...message.routeEdit,routeId:'../escape'},{...message.routeEdit,requestRevision:state.revision+1},{...message.routeEdit,extra:true}]){
  const invalid=structuredClone(state);invalid.messages.at(-1).routeEdit=bad;assert.throws(()=>validatePlanning(invalid),/PLANNING_INVALID/);
 }
 const user=structuredClone(state);user.messages[0].routeEdit=message.routeEdit;assert.throws(()=>validatePlanning(user),/PLANNING_INVALID/);
 const legacy=structuredClone(state);delete legacy.messages.at(-1).routeEdit;assert.doesNotThrow(()=>validatePlanning(legacy));
 const pruned=applyProposal(state,state.revision);delete pruned.history;
 assert.equal(messageEditRoutes(pruned,pruned.messages.at(-1)).status,'applied');assert.equal(messageEditRoutes(pruned,pruned.messages.at(-1)).before,undefined);
});
