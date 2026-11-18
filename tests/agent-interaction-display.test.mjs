import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning,appendUser,applyInterview,acceptAnswer,focusQuestion,applyEdit,applyProposal} from '../packages/domain/planning.mjs';
import {QUESTION_FIELDS} from '../packages/domain/planning-questions.mjs';

await mkdir('tmp/checks/agent-interaction-display',{recursive:true});
const dir=await mkdtemp('tmp/checks/agent-interaction-display/run-'),bundle=resolve(dir,'ui.mjs');
await build({stdin:{contents:`export {PlanningIntakeSurface,RouteEditorSurface} from './apps/local-ui/src/components/PlanningPage.tsx';export {default as AnswerFields} from './apps/local-ui/src/components/PlanningAnswerFields.tsx';export {PlanningGenerationLog} from './apps/local-ui/src/components/PlanningGenerationDialog.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {PlanningIntakeSurface,RouteEditorSurface,AnswerFields,PlanningGenerationLog,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
const project='proj_12345678-1234-4234-8234-123456789abc',compatible={status:'consistent',issues:[]};
const callbacks={onSend:()=>false,onCancel:()=>{},onFocus:()=>{},onAccept:()=>{},onRestart:()=>{},onReanswer:()=>{},onAdoptSuggestion:()=>{},onResources:async()=>true,onGenerate:()=>{},onManual:()=>{},onPrevious:()=>{},onHome:()=>{}};
const intake=(state,language)=>renderToStaticMarkup(createElement(PlanningIntakeSurface,{state,language,...callbacks}));
function answer(complete=true){
 let state=createPlanning(project,'codebuddy','en');state=appendUser(state,'Learn SQL and verify weekly order reports.','user','request',state.revision);
 return applyInterview(state,{reply:'Please check the collected information.',summary:'A concise summary.',updates:[{id:'goal',fields:{topic:'SQL and order data',...(complete?{outcome:'Independently build a weekly report and verify each total.'}:{})},evidence:(complete?['topic','outcome']:['topic']).map(field=>({field,messageId:'user',quote:'Synthetic answer'})),missing:complete?[]:['What report should you be able to produce?'],complete}],...(complete?{consistency:compatible}:{})},'request',state.revision);
}

test('every supported captured field has a readable label and its complete actual value',()=>{
 for(const language of ['zh-CN','en'])for(const [questionId,keys] of Object.entries(QUESTION_FIELDS)){
  const fields=Object.fromEntries(keys.map(key=>[key,`Actual ${key} value.\nFull second line.`]));
  const html=renderToStaticMarkup(createElement(AnswerFields,{fields,questionId,language}));
  for(const key of keys){assert.ok(html.includes(`data-answer-field="${key}"`),key);assert.ok(html.includes(fields[key]),key)}
  assert.ok(!/<details[^>]* open/.test(html));
 }
});

test('pending, partial and accepted answers expose the captured values even when the summary is generic',()=>{
 for(const language of ['zh-CN','en']){
  let state=answer(),html=intake(state,language);
  assert.match(html,/A concise summary/);assert.match(html,/SQL and order data/);assert.match(html,/Independently build a weekly report and verify each total/);
  assert.match(html,/planning-answer-fields/);assert.equal(state.questions[0].status,'awaiting-confirmation');
  state=acceptAnswer(state,'goal',state.questions[0].answerProposal.messageId,state.revision);
  state=focusQuestion(state,'goal',state.revision);html=intake(state,language);
  assert.match(html,/data-answer-field="outcome"/);assert.match(html,/Independently build a weekly report/);
  const partial=intake(answer(false),language);assert.match(partial,/data-answer-field="topic"/);assert.doesNotMatch(partial,/class="planning-answer-review"/);
 }
});

test('failed or stopped generation logs retain all received content without claiming to be receiving',()=>{
 const entries=[{id:'route:1',sequence:1,kind:'lessons',form:'content',text:'A complete generated lesson.',state:'complete',intent:'generate'},
  {id:'route:2',sequence:2,kind:'revision',form:'reply',text:'An interrupted revision that remains visible.',state:'streaming',intent:'generate'}];
 for(const language of ['zh-CN','en']){
  const html=renderToStaticMarkup(createElement(PlanningGenerationLog,{entries,language,running:false}));
  assert.match(html,/A complete generated lesson/);assert.match(html,/An interrupted revision that remains visible/);assert.match(html,/data-state="incomplete"/);
  assert.doesNotMatch(html,/Receiving|接收中|planning-activity-spinner/);
 }
 assert.equal(entries[1].state,'streaming');
});

test('ordinary replies mark unchanged routes while leaving an earlier proposal fully reviewable',()=>{
 const route={format:'vibe-improve.route',schemaVersion:2,id:'synthetic',revision:1,title:'Synthetic route',locale:'en',sourceLanguage:'en',chapters:[{id:'chapter',title:'Chapter',stageGoal:'Apply a technique.',nodes:[{id:'lesson',title:'Lesson',objectives:[{id:'goal',description:'Explain the technique.'}],prerequisites:[],estimatedMinutes:30}]}]};
 let state=createPlanning(project,'codex','en',route);
 state=appendUser(state,'Add a review.','first','first_request',state.revision);
 const next=structuredClone(state.routeDraft);next.chapters[0].nodes[0].review={content:'Recall the technique without notes.',passCriteria:['Explain it accurately.']};
 state=applyEdit(state,{reply:'A review is proposed.',route:next},'first_request',state.revision);
 state=appendUser(state,'Explain it.','second','second_request',state.revision);state=applyEdit(state,{reply:'Here is an explanation.',route:null},'second_request',state.revision);
 for(const language of ['zh-CN','en']){
  const html=renderToStaticMarkup(createElement(RouteEditorSurface,{state,route:state.routeDraft,language,onRoute:()=>{},onSave:()=>{},onConfirm:()=>{},onSend:()=>false,onCancel:()=>{},onApply:()=>{},onDiscard:()=>{},onUndo:()=>{},onPrevious:()=>{},onHome:()=>{}}));
  assert.match(html,/data-edit-outcome="no-changes"/);assert.match(html,/data-change-status="pending"/);
  assert.match(html,/Recall the technique without notes/);assert.match(html,/Explain it accurately/);
 }
 state=applyProposal(state,state.revision);assert.equal(state.routeDraft.chapters[0].nodes[0].review.content,'Recall the technique without notes.');
});
