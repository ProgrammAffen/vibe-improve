import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning,appendUser,applyInterview,acceptAnswer,restartIntake,canGenerate,canRequestGeneration,planningFacts,importRoute,reopenIntake,setResources} from '../packages/domain/planning.mjs';
const project='proj_12345678-1234-4234-8234-123456789abc',compatible={status:'consistent',issues:[]};
function collected(){let state=createPlanning(project,'codebuddy','en');for(const question of state.questions){const id=question.id,request='request_'+id,message='message_'+id;const fields={goal:{topic:'CSV processing',outcome:'Create a CSV report'},purpose:{context:'Personal practice',criteria:'Check totals against a small sample'},baseline:{experience:'Know Python basics'},time:{weekly:'Four hours',session:'One hour'}}[id];state=appendUser(state,JSON.stringify(fields),message,request,state.revision);state=applyInterview(state,{reply:'Please confirm.',summary:Object.values(fields).join(' / '),updates:[{id,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic answer'})),missing:[],complete:true}],consistency:compatible},request,state.revision);state=acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}return state}

test('restart clears every interview answer, proposal, evidence, review and optional answer context while preserving project choices and existing route',async()=>{
 let state=collected();const route=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
 state=importRoute(state,route,state.revision);state=reopenIntake(state,state.revision);state=setResources(state,'Old background reading',state.revision);
 state.agentOptions={model:'synthetic-model',effort:'high'};
 const oldRoute=structuredClone(state.routeDraft),oldOriginal=structuredClone(state.importedOriginal),oldEpoch=state.backgroundEpoch;
 const reset=restartIntake(state,state.revision);
 assert.equal(reset.projectId,project);assert.equal(reset.provider,'codebuddy');assert.deepEqual(reset.agentOptions,state.agentOptions);
 assert.equal(reset.currentQuestion,'goal');assert.equal(reset.step,'intake');assert.equal(reset.backgroundEpoch,oldEpoch+1);
 assert.deepEqual(reset.questions.map(q=>q.status),['current','pending','pending','pending']);
 for(const q of reset.questions){assert.deepEqual(q.fields,{});assert.deepEqual(q.evidence,[]);assert.deepEqual(q.missing,[]);assert.equal(q.summary,'');assert.equal(q.acceptedSnapshot,undefined);assert.equal(q.answerProposal,undefined)}
 assert.equal(reset.messages.filter(m=>m.questionId).length,0);assert.equal(reset.resources,undefined);assert.equal(reset.answerEvents,undefined);
 assert.deepEqual(planningFacts(reset).answers,{});assert.deepEqual(reset.consistency.issues,[]);assert.equal(reset.consistency.status,'dirty');
 assert.deepEqual(reset.routeDraft,oldRoute);assert.deepEqual(reset.importedOriginal,oldOriginal);assert.equal(reset.intakeChanged,true);
 assert.equal(canGenerate(reset),false);assert.equal(canRequestGeneration(reset),false);
 assert.throws(()=>restartIntake(reset,state.revision),/PLANNING_CONFLICT/);
});

test('restart cannot race active requests and old summaries cannot restore cleared answers',()=>{
 const accepted=collected(),reset=restartIntake(accepted,accepted.revision),summaryId=accepted.messages.find(m=>m.role==='assistant').id;
 assert.throws(()=>acceptAnswer(reset,'goal',summaryId,reset.revision),/PLANNING_CONFLICT/);
 const active=appendUser(reset,'A completely new goal','new-user','new-request',reset.revision);
 assert.throws(()=>restartIntake(active,active.revision),/PLANNING_BUSY/);
 assert.throws(()=>applyInterview(reset,{reply:'Late old reply',updates:[]},'new-request',active.revision),/PLANNING_CONFLICT/);
 assert.throws(()=>restartIntake(createPlanning(project,null,'en'),0),/PLANNING_INCOMPLETE/);
});

await mkdir('tmp/checks/collection-restart-2026-11-04',{recursive:true});const dir=await mkdtemp('tmp/checks/collection-restart-2026-11-04/ui-'),bundle=resolve(dir,'ui.mjs');
await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage.tsx';export {default as PlanningGenerationDialog,PlanningGenerationLog} from './apps/local-ui/src/components/PlanningGenerationDialog.tsx';export {mergeGenerationOutput} from './apps/local-ui/src/planning/output.ts';export {planningService,parseGenerationOutput,planningFailure,planningMessage,planningGenerationMessage} from './apps/local-ui/src/planning/service.ts';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {PlanningIntakeSurface,PlanningGenerationDialog,PlanningGenerationLog,mergeGenerationOutput,planningService,parseGenerationOutput,planningFailure,planningMessage,planningGenerationMessage,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
function surface(state,language='en'){return renderToStaticMarkup(createElement(PlanningIntakeSurface,{state,language,onSend:()=>false,onCancel:()=>{},onFocus:()=>{},onAccept:()=>{},onRestart:()=>{},onReanswer:()=>{},onAdoptSuggestion:()=>{},onResources:async()=>true,onGenerate:()=>{},onManual:()=>{},onPrevious:()=>{},onHome:()=>{}}))}

test('intake starts with one example and a four-question checklist in both languages',()=>{
 for(const locale of ['en','zh-CN']){
  const html=surface(createPlanning(project,'codebuddy',locale),locale);
  assert.match(html,/0 \/ 4/);
  assert.equal((html.match(/class="planning-question-example"/g)??[]).length,1);
  assert.doesNotMatch(html,/Tools and budget|设备与预算|其他回答方式/);
 }
});

test('intake exposes global restart and scoped reanswer while asking to confirm each summary',()=>{
 let state=createPlanning(project,'codebuddy','en');state=appendUser(state,'Learn CSV reports','user-goal','request-goal',state.revision);state=applyInterview(state,{reply:'Please confirm the summary.',summary:'Learn CSV reports',updates:[{id:'goal',fields:{topic:'CSV reports',outcome:'Create a CSV report'},evidence:['topic','outcome'].map(field=>({field,messageId:'user-goal',quote:'Learn CSV reports'})),missing:[],complete:true}],consistency:compatible},'request-goal',state.revision);
 const html=surface(state);assert.equal((html.match(/>Start over</g)??[]).length,1);assert.match(html,/Answer summary/);assert.match(html,/>Add details</);assert.match(html,/>Confirm answer</);assert.match(html,/Answer again/);assert.doesNotMatch(html,/Keep original|Edit answer/);
 const zh=surface(state,'zh-CN');assert.equal((zh.match(/>重新采集</g)??[]).length,1);assert.match(zh,/回答总结/);assert.match(zh,/>继续补充</);assert.match(zh,/>确认回答</);assert.match(zh,/重新回答/);assert.doesNotMatch(zh,/保留原回答/);
 assert.equal(state.questions[0].status,'awaiting-confirmation');assert.equal(canGenerate(state),false);
});

test('restart uses a revision-protected native command without a question identifier',async()=>{
 let state=collected();const calls=[];globalThis.window={vibeNative:{projects:{request:async(action,value)=>{calls.push({action,value});return state=restartIntake(state,value.expectedRevision)}}}};
 const result=await planningService.restartIntake(state);assert.equal(calls[0].action,'planning.intake.restart');assert.deepEqual(Object.keys(calls[0].value).sort(),['expectedRevision','projectId']);assert.equal(result.currentQuestion,'goal');assert.equal(result.messages.length,0);delete globalThis.window;
});

const segment=(sequence,text,form='reply',state='complete',kind='lessons')=>({sequence,kind,form,text,state});
test('independent generation output retains every task, full chapter content, retries and final completion snapshots',()=>{
 let entries=mergeGenerationOutput([],{id:'check',intent:'consistency',generationOutput:[segment(1,'All answers are consistent.','reply','complete','consistency')]});
 entries=mergeGenerationOutput(entries,{id:'route',intent:'generate',generationOutput:[segment(1,'Outline begins','reply','streaming','outline')]});
 entries=mergeGenerationOutput(entries,{id:'route',intent:'generate',generationOutput:[segment(1,'Outline begins with two stages.','reply','complete','outline'),segment(2,'First detailed lesson','content')]});
 const full='A complete long lesson\n'+'Practice and feedback.\n'.repeat(600);
 entries=mergeGenerationOutput(entries,{id:'route',intent:'generate',generationOutput:[segment(1,'Outline begins with two stages.','reply','complete','outline'),segment(2,'First detailed lesson','content'),segment(3,'Interrupted attempt','reply','incomplete'),segment(4,full,'content')]});
 assert.equal(entries.length,5);assert.ok(entries.at(-1).text.length>8000);assert.equal(entries[0].text,'All answers are consistent.');assert.equal(entries[3].state,'incomplete');
 const html=renderToStaticMarkup(createElement(PlanningGenerationLog,{entries,language:'en',running:false}));assert.match(html,/Outline begins with two stages/);assert.match(html,/First detailed lesson/);assert.match(html,/Interrupted attempt/);assert.equal((html.match(/Practice and feedback\./g)??[]).length,600);
 const unchanged=mergeGenerationOutput(entries,{id:'route',intent:'generate',generationOutput:[segment(2,'First','content','streaming')]});assert.deepEqual(unchanged,entries);
 assert.doesNotMatch(html,/Planning conversation|输入回答|textarea/);
});

test('generation output validation rejects unknown fields, bad ordering and excess data instead of trimming history',()=>{
 const good=[segment(1,'A'),segment(2,'B')];assert.deepEqual(parseGenerationOutput(good),good);
 for(const bad of [[{...good[0],rawPrompt:'secret'}],[segment(2,'B'),segment(1,'A')],[segment(1,'x','raw')],[segment(1,'x','reply','pending')],[segment(1,'x','reply','complete','unknown')],[segment(1025,'x')],[segment(1,'x'.repeat(8_388_609))]])assert.throws(()=>parseGenerationOutput(bad),/PLANNING_RESPONSE_INVALID/);
 assert.equal(parseGenerationOutput(undefined),undefined);
});

test('generation log displays the review, targeted revision and recheck in both languages',()=>{
 const output=[segment(1,'Initial review','reply','complete','review'),segment(2,'Revised lesson','content','complete','revision'),segment(3,'Final review','reply','streaming','review')];
 assert.deepEqual(parseGenerationOutput(output),output);
 const entries=mergeGenerationOutput([],{id:'route',intent:'generate',generationOutput:output});
 for(const [language,review,revision,receiving] of [['en','Content review','Lesson revision','Receiving'],['zh-CN','内容复核','章节修正','接收中']]){
  const html=renderToStaticMarkup(createElement(PlanningGenerationLog,{entries,language,running:true}));
  assert.equal((html.match(new RegExp(review,'g'))??[]).length,2);assert.match(html,new RegExp(revision));assert.match(html,new RegExp(receiving));
  assert.ok(html.indexOf('Initial review')<html.indexOf('Revised lesson')&&html.indexOf('Revised lesson')<html.indexOf('Final review'));
 }
});

const qualityReason='practice_sequence',qualitySummary={text:'模拟练习先安排下单，再要求记录下单前的余额，导致初始余额无法核对。',locale:'zh-CN'};
test('bridge accepts a concise learner summary only on failed route review',async()=>{
 const response={id:'route',projectId:project,intent:'generate',state:'failed',errorCode:'PLANNING_AGENT_QUALITY_REVIEW',qualityReason,qualitySummary,restartGeneration:true};
 let job=response;globalThis.window={vibeNative:{projects:{request:async()=>job}}};
 try{
  const failed=await planningService.job(project,'route');
  assert.equal(failed.qualityReason,qualityReason);assert.deepEqual(failed.qualitySummary,qualitySummary);assert.equal(failed.restartGeneration,true);
  assert.match(planningMessage(planningFailure(failed),'zh-CN'),/本次未保存新路线/);
  for(const invalid of [{intent:'edit'},{state:'pending'},{errorCode:'PLANNING_AGENT_NETWORK'},{userReply:'Unstructured review reply'},{qualityReason:'unknown'},{qualityReason:undefined},{restartGeneration:false},{qualitySummary:{...qualitySummary,text:'L6 uses position_before'}},{qualitySummary:{...qualitySummary,text:'x'.repeat(161)}},{qualitySummary:{...qualitySummary,text:'two\nlines'}},{qualitySummary:{...qualitySummary,locale:'fr'}}]){
   job={...response,...invalid};await assert.rejects(planningService.job(project,'route'),/PLANNING_RESPONSE_INVALID/);
  }
  job={...response,qualitySummary:undefined};assert.equal((await planningService.job(project,'route')).qualityReason,qualityReason);
 }finally{delete globalThis.window}
});

test('generation terminal views show only the learner-facing reason while running still shows progress',()=>{
 const entries=mergeGenerationOutput([],{id:'route',intent:'generate',generationOutput:[segment(1,'Private intermediate chapter text')]}),savedProgress={completed:2,total:2,resumable:true};
 const render=(language,props)=>renderToStaticMarkup(createElement(PlanningGenerationDialog,{entries,language,running:false,error:'Connection interrupted',reviewNeeded:false,savedProgress,onResume:()=>{},onRestart:()=>{},...props}));
 for(const [language,heading,restart,resume,reason] of [['en','No new route generated','Regenerate route','Resume generation','Some practice steps are out of order'],['zh-CN','未生成新路线','重新生成','继续生成',qualitySummary.text]]){
  const blocked=render(language,{qualityReason,qualitySummary,restartGeneration:true}),interrupted=render(language,{}),stopped=render(language,{error:''}),active=render(language,{running:true,error:''});
  const unfinished=render(language,{qualityReason:'learning_language'}),notStarted=render(language,{qualityReason:'learning_language',savedProgress:undefined});
  for(const value of [heading,reason,restart])assert.ok(blocked.includes(value),value);
  assert.ok(!blocked.includes(resume)&&!blocked.includes('Connection interrupted'));
  assert.doesNotMatch(blocked,/2 \/ 2/);assert.match(interrupted,/2 \/ 2/);
  assert.ok(interrupted.includes(resume)&&interrupted.includes('Connection interrupted')&&!interrupted.includes(restart));
  assert.ok(unfinished.includes(resume)&&!unfinished.includes(restart)&&notStarted.includes(restart));
  for(const terminal of [blocked,interrupted,stopped])assert.doesNotMatch(terminal,/<details|Private intermediate chapter text|role="log"/);
  assert.match(active,/Private intermediate chapter text/);
 }
});

test('generation errors do not reuse business reply text as an error, while interviews keep the question',()=>{
 const business={errorCode:'PLANNING_NEEDS_INPUT',userReply:'An internal assumption about faq_set'};
 assert.equal(planningMessage(planningFailure({...business,intent:'interview'}),'en'),business.userReply);
 for(const intent of ['generate','consistency']){
  const cause=planningFailure({...business,intent});
  assert.match(planningGenerationMessage(cause,'en'),/missing planning information/);
  assert.doesNotMatch(planningGenerationMessage(cause,'zh-CN'),/faq_set/);
 }
});
