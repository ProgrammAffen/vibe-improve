import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import * as p from '../packages/domain/planning.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc';
const fields={goal:{topic:'Python',outcome:'Produce a CSV report'},purpose:{context:'Weekly meeting',criteria:'Explain totals and trends'},baseline:{experience:'Know Python syntax'},time:{weekly:'Four hours',session:'Thirty minutes'},constraints:{scope:'Standard library',conditions:'Existing laptop'}};
const consistent={status:'consistent',issues:[]};
const source=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
function route(id){const value=p.upgradeRoute(structuredClone(source));value.id=id;for(const c of value.chapters)c.stageGoal='Apply the concepts independently.';return value}
function answer(state,id,suffix=''){
 const message='answer_'+id+suffix,request='request_'+id+suffix;
 state=p.appendUser(state,Object.values(fields[id]).join(' / '),message,request,state.revision);
 state=p.applyInterview(state,{reply:'Please confirm.',summary:Object.values(fields[id]).join(' / '),updates:[{id,fields:fields[id],evidence:Object.keys(fields[id]).map(field=>({field,messageId:message,quote:fields[id][field]})),missing:[],complete:true}],consistency:consistent},request,state.revision);
 return p.acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision);
}
function collected(){let state=p.createPlanning(project,'codebuddy','zh-CN');for(const id of p.QUESTION_IDS)state=answer(state,id);return state}
function discussion(state,suffix){const chapter=state.routeDraft.chapters[0],node=chapter.nodes[0],mentions=[{target:{chapterId:chapter.id,nodeId:node.id},token:'@1.1节'}];state=p.appendUser(state,'OLD_EDITOR_USER_'+suffix+' @1.1节','edit_user_'+suffix,'edit_'+suffix,state.revision,undefined,undefined,mentions);return p.applyEdit(state,{reply:'OLD_EDITOR_ASSISTANT_'+suffix},'edit_'+suffix,state.revision)}
function previous(){
 let state=collected();state=p.startGeneration(state,'first',state.revision);state=p.applyGenerated(state,route('route_first'),'first',state.revision);
 state=discussion(state,'before');state=p.reopenIntake(state,state.revision);state=p.reanswerQuestion(state,'constraints',state.revision);state=answer(state,'constraints','_again');
 state=p.openEditor(state,state.revision);state=discussion(state,'after');state=p.appendUser(state,'OLD_EDITOR_UNANSWERED','unanswered_user','unanswered',state.revision);state=p.cancelPlanningRequest(state,'unanswered',state.revision);
 return p.reopenIntake(state,state.revision);
}

test('successful regeneration clears old editor exchanges, retains interview evidence and remaps question history',()=>{
 const before=previous(),old=structuredClone(before.routeDraft),questions=structuredClone(before.questions),facts=p.planningFactsHash(before),conversations=Object.fromEntries(p.QUESTION_IDS.map(id=>[id,p.questionMessages(before,id)]));
 assert.ok(before.messages.some(m=>m.text.includes('OLD_EDITOR')));
 let state=p.startGeneration(before,'regenerate',before.revision,true);
 assert.deepEqual(state.messages,before.messages,'starting generation must not clear old conversation');
 state=p.applyGenerated(state,route('route_new'),'regenerate',state.revision);
 assert.equal(state.messages.filter(m=>!m.questionId).length,0);assert.equal(JSON.stringify(state.messages).includes('OLD_EDITOR'),false);
 assert.deepEqual(state.messages,before.messages.filter(m=>m.questionId));assert.equal(p.planningFactsHash(state),facts);
 for(const id of p.QUESTION_IDS){assert.deepEqual(p.questionMessages(state,id),conversations[id]);const q=state.questions.find(q=>q.id===id),oldQ=questions.find(q=>q.id===id);assert.deepEqual(q.acceptedSnapshot,oldQ.acceptedSnapshot)}
 assert.ok(state.questions.at(-1).conversationFrom<questions.at(-1).conversationFrom,'message offsets must be remapped');
 assert.deepEqual(state.history.past.at(-1),old);assert.equal(state.step,'editor');assert.equal(state.pending,undefined);
 const roundtrip=p.validatePlanning(JSON.parse(JSON.stringify(state)));assert.deepEqual(roundtrip,state);
 const undone=p.undoEditor(state,state.revision);assert.equal(undone.routeDraft.id,old.id);assert.equal(undone.messages.filter(m=>!m.questionId).length,0,'undo must not resurrect obsolete chat');
 const next=p.appendUser(state,'NEW_EDITOR_QUESTION','new_user','new_edit',state.revision);assert.deepEqual(next.messages.filter(m=>!m.questionId).map(m=>m.text),['NEW_EDITOR_QUESTION']);
});

test('generation rejection, cancellation and recovery keep old editor exchanges until successful replacement',()=>{
 const before=previous(),pending=p.startGeneration(before,'regenerate',before.revision,true),invalid=route('route_new');delete invalid.chapters[0].stageGoal;
 assert.throws(()=>p.applyGenerated(pending,invalid,'regenerate',pending.revision),/PLANNING_ROUTE_INVALID/);assert.deepEqual(pending.messages,before.messages);assert.deepEqual(pending.routeDraft,before.routeDraft);
 const cancelled=p.cancelPlanningRequest(pending,'regenerate',pending.revision);assert.deepEqual(cancelled.messages,before.messages);
 const recovered=p.recoverPlanning(pending);assert.deepEqual(recovered.messages.filter(m=>m.text.includes('OLD_EDITOR')),before.messages.filter(m=>m.text.includes('OLD_EDITOR')));
 assert.throws(()=>p.applyGenerated(cancelled,route('route_new'),'regenerate',pending.revision),/PLANNING_CONFLICT/);
 const edited=p.saveEditor(p.openEditor(cancelled,cancelled.revision),{...cancelled.routeDraft,title:'A manual title'},cancelled.revision+1);assert.deepEqual(edited.messages,cancelled.messages,'ordinary editing must keep the conversation');
});

test('native regeneration persists cleared editor chat and retained interview answers across restart',{skip:process.platform!=='darwin',timeout:120000},async()=>{
 const parent=resolve('tmp/checks/regenerated-conversation-2026-11-05');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-')),validator=join(dir,'planning.js'),fixture=join(dir,'fixture.json'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',outfile:validator,target:'safari15',logLevel:'silent'});
 await writeFile(fixture,JSON.stringify({state:previous(),route:route('route_native_new')}));
 await writeFile(source,`import Foundation
let base=URL(fileURLWithPath:CommandLine.arguments[1]),validator=URL(fileURLWithPath:CommandLine.arguments[2]),fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any]
let runtime=try RuntimeDirectory(url:base),id="${project}",files=try runtime.child("projects").child("planning")
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:fixture["state"]!))
func store()throws->PlanningStore{try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in base})}
let first=try store(),before=try first.read(projectID:id)!,oldMessages=before["messages"] as! [[String:Any]],request="native_regeneration"
let pending=try first.startGeneration(projectID:id,requestID:request,expectedRevision:before["revision"] as! Int,replaceExisting:true)
precondition((pending["messages"] as! [[String:Any]]).count==oldMessages.count)
let applied=try first.applyGenerated(projectID:id,route:fixture["route"] as! [String:Any],requestID:request,baseRevision:pending["revision"] as! Int)
let restarted=try store(),loaded=try restarted.read(projectID:id)!,messages=loaded["messages"] as! [[String:Any]]
precondition(messages.allSatisfy{$0["questionId"] != nil})
precondition(messages.count==oldMessages.filter{$0["questionId"] != nil}.count)
precondition((loaded["questions"] as! [[String:Any]]).allSatisfy{$0["status"] as? String=="complete" && $0["acceptedSnapshot"] != nil})
let loadedBytes=try JSONSerialization.data(withJSONObject:loaded,options:.sortedKeys),appliedBytes=try JSONSerialization.data(withJSONObject:applied,options:.sortedKeys)
precondition(loadedBytes==appliedBytes)
print("PASS regenerated conversation persisted without clearing interview evidence")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',source,'-o',binary],{encoding:'utf8',timeout:100000});await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'runtime'),validator,fixture],{encoding:'utf8',timeout:20000});await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS regenerated/);
});
