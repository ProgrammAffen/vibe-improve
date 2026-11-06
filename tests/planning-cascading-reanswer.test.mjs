import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {QUESTION_IDS,createPlanning,appendUser,applyInterview,acceptAnswer,focusQuestion,reanswerQuestion,restartIntakeFrom,canGenerate,canRequestGeneration,planningFacts,planningFactsHash,validatePlanning,beginConsistencyCheck,applyConsistencyCheck,acceptConsistencySuggestion,importRoute,reopenIntake,setResources} from '../packages/domain/planning.mjs';
const id='proj_12345678-1234-4234-8234-123456789abc',compatible={status:'consistent',issues:[]};
function propose(state,qid,fields){const request='request_'+state.revision,message='user_'+state.revision;state=appendUser(state,JSON.stringify(fields),message,request,state.revision);return applyInterview(state,{reply:'Please confirm.',summary:Object.values(fields).join(' / '),updates:[{id:qid,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic background'})),missing:[],complete:true}],consistency:compatible},request,state.revision)}
function ready(){let state=createPlanning(id,'codebuddy','en');for(const qid of QUESTION_IDS){state=propose(state,qid,{goal:{topic:'CSV data',outcome:'Build a report'},purpose:{context:'Work',criteria:'Check totals'},baseline:{experience:'Python basics'},time:{weekly:'Four hours',session:'One hour'},constraints:{scope:'Standard library',conditions:'Laptop'}}[qid]);state=acceptAnswer(state,qid,state.questions.find(q=>q.id===qid).answerProposal.messageId,state.revision)}return state}
function assessment(state,issues){const request='check_'+state.revision;state=beginConsistencyCheck(state,request,state.revision);return applyConsistencyCheck(state,{reply:'Review related answers.',consistency:issues.length?{status:'requires_review',issues}:compatible},request,state.revision)}
const issue=(questionId,field)=>({questionId,fields:[field],kind:'uncertain',reason:'Confirm the synthetic condition.',suggestion:{summary:'A confirmed synthetic condition',fields:{[field]:'A revised synthetic condition'}}});

for(const [index,qid] of QUESTION_IDS.entries())test(`reanswer from ${qid} preserves only the earlier answers and clears all later context`,()=>{
 const source=ready(),before=structuredClone(source),reset=restartIntakeFrom(source,qid,source.revision);
 assert.deepEqual(source,before);assert.equal(reset.currentQuestion,qid);assert.equal(reset.backgroundEpoch,source.backgroundEpoch+1);
 assert.deepEqual(reset.questions.slice(0,index),source.questions.slice(0,index));
 for(const [offset,q] of reset.questions.slice(index).entries()){assert.equal(q.status,offset===0?'current':'pending');assert.equal(q.summary,'');assert.deepEqual(q.fields,{});assert.deepEqual(q.evidence,[]);assert.deepEqual(q.missing,[]);assert.equal(q.acceptedSnapshot,undefined);assert.equal(q.answerProposal,undefined)}
 assert.deepEqual(Object.keys(planningFacts(reset).answers),QUESTION_IDS.slice(0,index));
 assert.ok(reset.messages.every(message=>QUESTION_IDS.indexOf(message.questionId)<index));
 assert.equal(reset.messages.length,source.messages.filter(message=>QUESTION_IDS.indexOf(message.questionId)<index).length);
 assert.equal(reset.consistency.status,'dirty');assert.equal(reset.consistency.factsHash,planningFactsHash(reset));assert.equal(canGenerate(reset),false);assert.equal(canRequestGeneration(reset),false);
 const request='new_'+qid,next=appendUser(reset,'New answer','new_user_'+qid,request,reset.revision);assert.equal(next.pending.questionId,qid);
 assert.throws(()=>acceptAnswer(reset,qid,source.messages.find(message=>message.questionId===qid&&message.role==='assistant').id,reset.revision),/PLANNING_CONFLICT/);
});

test('reanswer preserves project, selected model, resources, old route and earlier adoption evidence',async()=>{
 let source=assessment(ready(),[issue('goal','outcome'),issue('time','weekly')]);
 for(const qid of ['goal','time']){const selected=source.consistency.issues.find(item=>item.questionId===qid);source=acceptConsistencySuggestion(source,selected.id,source.revision)}
 source=assessment(source,[]);source=importRoute(source,JSON.parse(await readFile('contracts/examples/route.valid.json','utf8')),source.revision);source=reopenIntake(source,source.revision);source=setResources(source,'A reference handbook',source.revision);source.agentOptions={model:'synthetic',effort:'high'};
 const prefix=structuredClone(source.questions.slice(0,2)),reset=restartIntakeFrom(source,'baseline',source.revision);
 assert.deepEqual(reset.questions.slice(0,2),prefix);assert.deepEqual(reset.routeDraft,source.routeDraft);assert.deepEqual(reset.importedOriginal,source.importedOriginal);assert.deepEqual(reset.agentOptions,source.agentOptions);assert.equal(reset.provider,source.provider);assert.equal(reset.projectId,source.projectId);assert.equal(reset.resources,source.resources);assert.equal(reset.intakeChanged,true);
 assert.deepEqual(reset.answerEvents.map(event=>event.questionId),['goal']);assert.equal(reset.questions[0].acceptedSnapshot.evidence.find(e=>e.field==='outcome').acceptanceEventId,reset.answerEvents[0].id);validatePlanning(reset);
});

test('earlier unresolved reviews remain blocked while later review items and anchors are cleared',()=>{
 const source=assessment(ready(),[issue('goal','outcome'),issue('constraints','scope')]),reset=restartIntakeFrom(source,'purpose',source.revision);
 assert.equal(reset.questions[0].status,'needs-review');assert.equal(reset.consistency.status,'requires_review');assert.deepEqual(reset.consistency.issues.map(item=>item.questionId),['goal']);assert.equal(reset.consistency.anchorQuestionId,null);assert.equal(reset.consistency.issues[0].anchorQuestionId,null);assert.equal(canRequestGeneration(reset),false);validatePlanning(reset);
});

test('prefix draft references remain readable and stale candidate checks cannot be reused',()=>{
 let source=ready();source=reanswerQuestion(source,'goal',source.revision);source=propose(source,'goal',{topic:'CSV analysis',outcome:'Create a verified CSV report'});
 assert.ok(source.questions[0].answerProposal.consistency);
 const reset=restartIntakeFrom(source,'time',source.revision);
 assert.equal(reset.questions[0].answerProposal.summary,source.questions[0].answerProposal.summary);assert.equal(reset.questions[0].answerProposal.consistency,undefined);assert.ok(reset.messages.length<source.messages.length);validatePlanning(reset);
 const adopted=acceptAnswer(reset,'goal',reset.questions[0].answerProposal.messageId,reset.revision);assert.equal(adopted.questions[0].status,'complete');assert.equal(canGenerate(adopted),false);
});

test('invalid, stale and active-request resets are rejected without changing the stored plan',()=>{
 const source=ready();assert.throws(()=>restartIntakeFrom(source,'missing',source.revision),/PLANNING_INCOMPLETE/);assert.throws(()=>restartIntakeFrom(source,'goal',0),/PLANNING_CONFLICT/);
 let pending=restartIntakeFrom(source,'purpose',source.revision);pending=appendUser(pending,'A new purpose','new-user','new-request',pending.revision);assert.throws(()=>restartIntakeFrom(pending,'goal',pending.revision),/PLANNING_BUSY/);
 const reset=restartIntakeFrom(source,'goal',source.revision);assert.throws(()=>applyInterview(reset,{reply:'Late response',updates:[]},'new-request',pending.revision),/PLANNING_CONFLICT/);
 assert.equal(source.questions.filter(q=>q.status==='complete').length,5);
});

await mkdir('tmp/checks/cascading-reanswer-2026-11-04',{recursive:true});const dir=await mkdtemp('tmp/checks/cascading-reanswer-2026-11-04/ui-'),bundle=resolve(dir,'ui.mjs');
await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage.tsx';export {planningService} from './apps/local-ui/src/planning/service.ts';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {PlanningIntakeSurface,planningService,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);

test('returned questions offer an explicit reanswer action and request the cascading native command',async()=>{
 let source=focusQuestion(ready(),'baseline',ready().revision);const props={state:source,language:'en',onSend:()=>false,onCancel:()=>{},onFocus:()=>{},onAccept:()=>{},onRestart:()=>{},onReanswer:()=>{},onAdoptSuggestion:()=>{},onResources:async()=>true,onGenerate:()=>{},onManual:()=>{},onPrevious:()=>{},onHome:()=>{}};
 const html=renderToStaticMarkup(createElement(PlanningIntakeSurface,props));assert.match(html,/>Answer again</);assert.match(html,/Python basics/);assert.match(html,/5 \/ 5/);
 const calls=[];globalThis.window={vibeNative:{projects:{request:async(action,value)=>{calls.push({action,value});return source=restartIntakeFrom(source,value.questionId,value.expectedRevision)}}}};
 const reset=await planningService.reanswer(source,'baseline');assert.equal(calls[0].action,'planning.answer.reset');assert.equal(calls[0].value.questionId,'baseline');assert.equal(reset.questions.filter(q=>q.status==='complete').length,2);assert.equal(reset.currentQuestion,'baseline');delete globalThis.window;
});
