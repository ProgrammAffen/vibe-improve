import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPlanning,appendUser,applyInterview,acceptAnswer,reanswerQuestion,cancelAnswerDraft,beginInterviewPrefill,beginConsistencyCheck,applyConsistencyCheck,acceptConsistencySuggestion,canGenerate,canRequestGeneration,focusQuestion,setResources,planningFacts} from '../packages/domain/planning.mjs';

const id='proj_12345678-1234-4234-8234-123456789abc',compatible={status:'consistent',issues:[]};
const answers={goal:{topic:'Image classification',outcome:'Train an image classifier'},purpose:{context:'Show an experiment',criteria:'Report image classification accuracy and errors'},baseline:{experience:'Real prior image classification experience'},time:{weekly:'Five hours each week',session:'30 minutes each time'}};
const assessment={status:'requires_review',issues:[{questionId:'purpose',fields:['criteria'],kind:'incompatible',reason:'The adopted goal is now a character language model; the old success criteria still evaluate image classification.',suggestion:{summary:'Show text samples and explain training results.',fields:{criteria:'Show generated text and explain training/validation loss and limitations'}}}]};
function proposal(state,questionId,fields,consistency=compatible){if(state.questions.find(q=>q.id===questionId).acceptedSnapshot)state=reanswerQuestion(state,questionId,state.revision);const request=`test_${state.revision}_${questionId}`,message='user_'+request;state=appendUser(state,JSON.stringify(fields),message,request,state.revision);return applyInterview(state,{reply:'Review the answer summary.',summary:Object.values(fields).join(' / '),updates:[{id:questionId,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic answer'})),missing:[],complete:true}],consistency},request,state.revision)}
function adopt(state,questionId){return acceptAnswer(state,questionId,state.questions.find(q=>q.id===questionId).answerProposal.messageId,state.revision)}
function ready(){let state=createPlanning(id,'codebuddy','en');for(const [qid,fields] of Object.entries(answers))state=adopt(proposal(state,qid,fields),qid);return state}
function review(){return checked(ready(),assessment)}
function legacy(){const state=ready();delete state.consistency;delete state.backgroundEpoch;for(const q of state.questions)delete q.acceptedSnapshot;return state}
function checked(state,result=compatible){state=beginConsistencyCheck(state,'synthetic_check',state.revision);return applyConsistencyCheck(state,{reply:'Checked.',consistency:result},'synthetic_check',state.revision)}

await mkdir('tmp/checks/planning-consistency-ui',{recursive:true});const dir=await mkdtemp('tmp/checks/planning-consistency-ui/run-'),bundle=resolve(dir,'ui.mjs');
await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage.tsx';export {default as Review} from './apps/local-ui/src/components/PlanningConsistencyReview.tsx';export {generateWithConsistency} from './apps/local-ui/src/planning/generation.ts';export {planningService,planningProgress} from './apps/local-ui/src/planning/service.ts';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {PlanningIntakeSurface,Review,generateWithConsistency,planningService,planningProgress,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
const surface=(state,language='en')=>renderToStaticMarkup(createElement(PlanningIntakeSurface,{state,language,onSend:()=>false,onCancel:()=>{},onFocus:()=>{},onAccept:()=>{},onRestart:()=>{},onReanswer:()=>{},onAdoptSuggestion:()=>{},onResources:async()=>true,onGenerate:()=>{},onManual:()=>{},onPrevious:()=>{},onHome:()=>{}}));
function generateButton(html,label='Generate route'){return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(m=>m[0]).find(button=>button.includes('>'+label+'<'))}

test('intake distinguishes direction from independent outcomes and keeps reused information pending confirmation',()=>{
 let state=createPlanning(id,'codebuddy','en');
 assert.match(surface(state),/What do you want to learn or solve\?/);
 assert.match(surface(state,'zh-CN'),/你想学什么，或想解决什么问题？/);
 const user='user_intake_topic',topicRequest='intake_topic';
 state=appendUser(state,'I want to learn SQL so I can independently build and check a weekly order report.',user,topicRequest,state.revision);
 state=applyInterview(state,{reply:'Confirm SQL as the topic.',summary:'SQL for weekly reports',updates:[{id:'goal',fields:{topic:'SQL'},evidence:[{field:'topic',messageId:user,quote:'learn SQL'}],missing:[],complete:true}],consistency:compatible},topicRequest,state.revision);
 state=adopt(state,'goal');
 assert.match(surface(state),/What do you want to do on your own by the end\?/);
 assert.match(surface(state,'zh-CN'),/学完后，你希望能独立完成哪件事？/);
 const request='intake_prefill_outcome';
 state=beginInterviewPrefill(state,request,state.revision);
 state=applyInterview(state,{reply:'Check this summary.',summary:'Build and check a weekly order report',updates:[{id:'purpose',fields:{criteria:'Build and check a weekly order report'},evidence:[{field:'criteria',messageId:user,quote:'independently build and check a weekly order report',reusedFrom:'goal'}],missing:[],complete:true}],consistency:compatible},request,state.revision);
 const html=surface(state);
 assert.match(html,/Based on earlier answers/);
 assert.match(html,/Confirm answer/);
 assert.match(html,/1 \/ 4/);
 assert.doesNotMatch(html,/I want to learn SQL so I can independently/);
});

test('baseline choices include topic actions and free text, and time can be left unscheduled',()=>{
 let state=createPlanning(id,'codebuddy','en');
 state=adopt(proposal(state,'goal',{topic:'SQL'}),'goal');
 state=adopt(proposal(state,'purpose',{criteria:'Produce and check an order report'}),'purpose');
 assert.match(surface(state),/>Never written a query</);
 assert.match(surface(state,'zh-CN'),/>能独立查询单张表</);
 const request='intake_prefill_baseline',options=['Never opened an order table','Imported a CSV by following a guide','Queried a table without help'];
 state=beginInterviewPrefill(state,request,state.revision);
 state=applyInterview(state,{reply:'Choose what you have tried.',baselineOptions:options,updates:[{id:'baseline',fields:{},evidence:[],missing:['What have you tried with order data?'],complete:false}],consistency:compatible},request,state.revision);
 let html=surface(state);
 for(const option of options)assert.ok(html.includes('>'+option+'<'));
 assert.match(html,/>Not sure</);
 assert.match(html,/planning-composer/);
 assert.doesNotMatch(html,/>Never written a query</);
 state=proposal(state,'baseline',{experience:'Queried a table without help'});
 assert.doesNotMatch(surface(state),/Quick answers/);
 state=adopt(state,'baseline');
 html=surface(state);
 assert.match(html,/>No schedule yet</);
 assert.match(surface(state,'zh-CN'),/>暂不排期</);
 assert.match(html,/3 \/ 4/);
});

test('persisted review UI preserves facts and exposes explicit update or reanswer actions without hiding the current conversation',()=>{
 const state=review(),html=surface(state);
 assert.match(html,/Review needed/);assert.match(html,/3 \/ 4/);
 assert.match(html,/Report image classification accuracy and errors/);
 assert.match(html,/now a character language model/);assert.match(html,/Show generated text/);
 assert.match(html,/Answer review/);assert.match(html,/Question 2/);
 assert.match(html,/Confirm update/);assert.match(html,/Answer again/);assert.match(html,/Start over/);
 assert.doesNotMatch(html,/Use suggestion|>Later<|View earlier replies/);
 assert.match(html,/planning-composer/);
 assert.match(html,/Real prior image classification experience/);assert.match(html,/Five hours each week/);
 assert.match(generateButton(html),/disabled=""/);
 const zh=surface({...state,locale:'zh-CN'},'zh-CN');assert.match(zh,/待复核/);assert.match(zh,/回答需要确认/);assert.match(zh,/确认调整/);assert.match(zh,/重新采集/);assert.match(zh,/重新回答/);assert.doesNotMatch(zh,/采用建议|稍后处理/);
 const noSuggestion=structuredClone(state);noSuggestion.consistency.issues[0].suggestion=null;
 assert.doesNotMatch(surface(noSuggestion),/Confirm update/);
 const focused=focusQuestion(state,'purpose',state.revision),visible=surface(focused);
 assert.match(visible,/Review the answer summary\./);
 assert.match(visible,/planning-composer/);
 assert.doesNotMatch(visible,/View earlier replies/);
});

test('legacy per-question drafts remain readable and their persisted issue returns after cancelling the draft',()=>{
 const original=review(),editing=reanswerQuestion(original,'purpose',original.revision),html=surface(editing);
 assert.doesNotMatch(html,/Keep original/);assert.match(html,/Answer again/);assert.match(html,/Start over/);assert.doesNotMatch(html,/data-review-issue=/);
 assert.equal(editing.questions[1].acceptedSnapshot.fields.criteria,answers.purpose.criteria);
 const restored=cancelAnswerDraft(editing,'purpose',editing.revision),back=surface(restored);
 assert.match(back,/data-review-issue=/);assert.match(back,/Report image classification/);assert.doesNotMatch(back,/Keep original/);
 assert.equal(restored.questions[1].status,'needs-review');assert.equal(canGenerate(restored),false);
});

const earlierChange={status:'requires_review',issues:[{questionId:'goal',fields:['outcome'],kind:'incompatible',reason:'This answer explicitly adds simulated practice to the earlier reading-only goal.',suggestion:{summary:'Read market information, then practise in a simulated account.',fields:{outcome:'Read market information, then practise in a simulated account'}}}]};
function currentCandidate(consistency=earlierChange){
 let state=createPlanning(id,'codebuddy','en');
 state=adopt(proposal(state,'goal',{topic:'Stock market basics',outcome:'Read market information without practising transactions'}),'goal');
 return proposal(state,'purpose',{criteria:'Read a quote, submit a simulated order and check its status'},consistency);
}

test('a current answer shows prior answer changes before confirmation while keeping its own question and chat visible',()=>{
 const state=currentCandidate(),before=JSON.stringify(state),html=surface(state);
 assert.equal(state.currentQuestion,'purpose');
 assert.equal(state.questions[0].status,'complete');
 assert.match(html,/Answer summary/);
 assert.match(html,/Question 1/);
 assert.match(html,/Read market information without practising transactions/);
 assert.match(html,/Read market information, then practise in a simulated account/);
 assert.match(html,/This answer explicitly adds simulated practice/);
 assert.match(html,/Confirm &amp; continue/);
 assert.match(html,/Add details/);
 assert.match(html,/Read a quote, submit a simulated order and check its status/);
 assert.match(html,/Review the answer summary\./);
 assert.match(html,/planning-composer/);
 assert.match(generateButton(html),/disabled=""/);
 assert.equal(JSON.stringify(state),before);
 const zh=surface({...state,locale:'zh-CN'},'zh-CN');
 assert.match(zh,/第\s*1\s*题/);assert.match(zh,/确认调整并继续/);assert.match(zh,/继续补充/);
 assert.doesNotMatch(zh,/采用建议|稍后处理/);
});

test('normal summaries keep their simple confirmation and a supplement action',()=>{
 const state=currentCandidate(compatible),html=surface(state);
 assert.match(html,/Confirm answer/);assert.match(html,/Add details/);
 assert.doesNotMatch(html,/Confirm &amp; continue/);
 assert.match(html,/planning-composer/);
 assert.equal(state.currentQuestion,'purpose');
});

test('uncertain, missing and stale changes cannot expose an actionable confirmation, but retain the reply composer',()=>{
 const uncertain=structuredClone(earlierChange);uncertain.issues[0].kind='uncertain';
 const missing=structuredClone(earlierChange);missing.issues[0].suggestion=null;
 const candidate=currentCandidate(),stale=setResources(candidate,'A new synthetic reference',candidate.revision);
 for(const state of [currentCandidate(uncertain),currentCandidate(missing),stale]){
  const html=surface(state);
  assert.equal(state.currentQuestion,'purpose');
  assert.match(html,/Add details/);assert.match(html,/planning-composer/);
  assert.doesNotMatch(html,/Confirm &amp; continue|>Confirm answer</);
  assert.equal(planningFacts(state).answers.goal.fields.outcome,'Read market information without practising transactions');
  assert.equal(planningFacts(state).answers.purpose,undefined);
 }
});

test('legacy completed answers keep Generate available for the one-click preflight while review and pending states remain blocked',()=>{
 assert.doesNotMatch(generateButton(surface(legacy())),/disabled=""/);
 const pending=beginConsistencyCheck(legacy(),'pending_check',legacy().revision);
 assert.match(generateButton(surface(pending)),/disabled=""/);
 assert.match(planningProgress({intent:'consistency',diagnostic:{stage:'waiting',durationMs:0}},'en'),/Checking answers/);
 assert.equal(planningProgress({intent:'consistency'},'zh-CN'),'正在检查回答…');
});

test('one Generate click preflights the current state and forwards replacement consent once',async()=>{
 let current=legacy();const calls=[];
 const result=await generateWithConsistency(()=>current,async(intent,replace)=>{calls.push([intent,Boolean(replace),current.revision]);if(intent==='consistency')current=checked(current);return true},true);
 assert.equal(result,true);assert.deepEqual(calls.map(call=>call.slice(0,2)),[['consistency',false],['generate',true]]);
 assert.ok(calls[1][2]>calls[0][2]);assert.equal(canGenerate(current),true);
 calls.length=0;
 await generateWithConsistency(()=>current,async(intent,replace)=>{calls.push([intent,replace]);return true});
 assert.deepEqual(calls,[['generate',false]]);
});

test('preflight review, cancellation, or a changed state never slips into generation',async()=>{
 let current=legacy(),calls=[];
 assert.equal(await generateWithConsistency(()=>current,async intent=>{calls.push(intent);current=checked(current,assessment);return true}),false);
 assert.deepEqual(calls,['consistency']);assert.equal(current.questions[1].status,'needs-review');assert.equal(current.questions[0].status,'complete');
 calls=[];current=legacy();assert.equal(await generateWithConsistency(()=>current,async intent=>{calls.push(intent);return false}),false);assert.deepEqual(calls,['consistency']);
 calls=[];current=legacy();assert.equal(await generateWithConsistency(()=>current,async intent=>{calls.push(intent);current=null;return true}),false);assert.deepEqual(calls,['consistency']);
 calls=[];current=review();assert.equal(await generateWithConsistency(()=>current,async intent=>{calls.push(intent);return true}),false);assert.deepEqual(calls,[]);
});

test('adopting a suggested fix requests the same native action and a subsequent click checks the new facts before generation',async()=>{
 let current=review();const requests=[],issue=current.consistency.issues[0].id;
 globalThis.window={vibeNative:{projects:{request:async(action,value)=>{requests.push({action,value});if(action==='planning.consistency.suggestion.accept')return current=acceptConsistencySuggestion(current,value.issueId,value.expectedRevision);if(action==='planning.answer.cancel-draft')return current=cancelAnswerDraft(current,value.questionId,value.expectedRevision);if(action==='planning.begin')return {id:'synthetic-consistency',projectId:id,intent:value.intent,state:'pending'};throw new Error('PLANNING_INVALID')}}}};
 current=await planningService.adoptSuggestion(current,issue);
 assert.equal(requests[0].action,'planning.consistency.suggestion.accept');assert.equal(requests[0].value.issueId,issue);assert.equal(requests[0].value.projectId,id);
 assert.equal(current.questions[1].acceptedSnapshot.fields.context,answers.purpose.context);assert.equal(current.questions[2].acceptedSnapshot.fields.experience,answers.baseline.experience);
 assert.equal(canRequestGeneration(current),true);assert.equal(canGenerate(current),false);
 assert.equal((await planningService.begin(current,'consistency')).intent,'consistency');
 await assert.rejects(planningService.begin(current,'generate'),/INCOMPLETE/);
 const calls=[];await generateWithConsistency(()=>current,async intent=>{calls.push(intent);if(intent==='consistency')current=checked(current);return true});assert.deepEqual(calls,['consistency','generate']);
 current=reanswerQuestion(current,'purpose',current.revision);current=await planningService.cancelAnswerDraft(current,'purpose');assert.equal(requests.at(-1).action,'planning.answer.cancel-draft');
 delete globalThis.window;
});
