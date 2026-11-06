import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning,appendUser,applyInterview,acceptAnswer,restartIntake,canGenerate,canRequestGeneration,planningFacts,importRoute,reopenIntake,setResources} from '../packages/domain/planning.mjs';
const project='proj_12345678-1234-4234-8234-123456789abc',compatible={status:'consistent',issues:[]};
function collected(){let state=createPlanning(project,'codebuddy','en');for(const question of state.questions){const id=question.id,request='request_'+id,message='message_'+id;const fields={goal:{topic:'CSV processing',outcome:'Create a CSV report'},purpose:{context:'Personal practice',criteria:'Check totals against a small sample'},baseline:{experience:'Know Python basics'},time:{weekly:'Four hours',session:'One hour'},constraints:{scope:'Standard library',conditions:'Existing laptop'}}[id];state=appendUser(state,JSON.stringify(fields),message,request,state.revision);state=applyInterview(state,{reply:'Please confirm.',summary:Object.values(fields).join(' / '),updates:[{id,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic answer'})),missing:[],complete:true}],consistency:compatible},request,state.revision);state=acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}return state}

test('restart clears every interview answer, proposal, evidence, review and optional answer context while preserving project choices and existing route',async()=>{
 let state=collected();const route=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
 state=importRoute(state,route,state.revision);state=reopenIntake(state,state.revision);state=setResources(state,'Old background reading',state.revision);
 state.agentOptions={model:'synthetic-model',effort:'high'};
 const oldRoute=structuredClone(state.routeDraft),oldOriginal=structuredClone(state.importedOriginal),oldEpoch=state.backgroundEpoch;
 const reset=restartIntake(state,state.revision);
 assert.equal(reset.projectId,project);assert.equal(reset.provider,'codebuddy');assert.deepEqual(reset.agentOptions,state.agentOptions);
 assert.equal(reset.currentQuestion,'goal');assert.equal(reset.step,'intake');assert.equal(reset.backgroundEpoch,oldEpoch+1);
 assert.deepEqual(reset.questions.map(q=>q.status),['current','pending','pending','pending','pending']);
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
await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage.tsx';export {PlanningGenerationLog} from './apps/local-ui/src/components/PlanningGenerationDialog.tsx';export {mergeGenerationOutput} from './apps/local-ui/src/planning/output.ts';export {planningService,parseGenerationOutput} from './apps/local-ui/src/planning/service.ts';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {PlanningIntakeSurface,PlanningGenerationLog,mergeGenerationOutput,planningService,parseGenerationOutput,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
function surface(state,language='en'){return renderToStaticMarkup(createElement(PlanningIntakeSurface,{state,language,onSend:()=>false,onCancel:()=>{},onFocus:()=>{},onAccept:()=>{},onRestart:()=>{},onReanswer:()=>{},onAdoptSuggestion:()=>{},onResources:async()=>true,onGenerate:()=>{},onManual:()=>{},onPrevious:()=>{},onHome:()=>{}}))}

test('intake exposes global restart and scoped reanswer while asking to confirm each summary',()=>{
 let state=createPlanning(project,'codebuddy','en');state=appendUser(state,'Learn CSV reports','user-goal','request-goal',state.revision);state=applyInterview(state,{reply:'Please confirm the summary.',summary:'Learn CSV reports',updates:[{id:'goal',fields:{topic:'CSV reports'},evidence:[{field:'topic',messageId:'user-goal',quote:'Synthetic goal'}],missing:[],complete:true}],consistency:compatible},'request-goal',state.revision);
 const html=surface(state);assert.equal((html.match(/>Start over</g)??[]).length,1);assert.match(html,/Do you confirm this answer\?/);assert.match(html,/>Confirm answer</);assert.match(html,/Answer again/);assert.doesNotMatch(html,/Keep original|Edit answer/);
 const zh=surface(state,'zh-CN');assert.equal((zh.match(/>重新采集</g)??[]).length,1);assert.match(zh,/是否确认该回答？/);assert.match(zh,/>确认回答</);assert.match(zh,/重新回答/);assert.doesNotMatch(zh,/保留原回答/);
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
 for(const bad of [[{...good[0],rawPrompt:'secret'}],[segment(2,'B'),segment(1,'A')],[segment(1,'x','raw')],[segment(1,'x','reply','pending')],[segment(1025,'x')],[segment(1,'x'.repeat(8_388_609))]])assert.throws(()=>parseGenerationOutput(bad),/PLANNING_RESPONSE_INVALID/);
 assert.equal(parseGenerationOutput(undefined),undefined);
});
