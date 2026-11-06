import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanning,saveEditor,confirmRoute,setAgentOptions,setProvider,validatePlanning,undoEditor,redoEditor,appendUser,cancelPlanningRequest,applyEdit,applyProposal} from '../packages/domain/planning.mjs';
import {routeIssues} from '../packages/domain/route-validation.mjs';

const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'sample',revision:1,title:'Synthetic route',locale:'en',sourceLanguage:'en',chapters:[{id:'ch',title:'Prepare',stageGoal:'Prepare usable data',nodes:[{id:'lesson',title:'Clean',objectives:[{id:'goal',description:'Clean data'}],prerequisites:[],estimatedMinutes:30}]}]});
const initial=()=>createPlanning('proj_12345678-1234-4234-8234-123456789abc','codex','en',route());
test('undo and redo retain multiple saved revisions across restart and invalidate confirmation',()=>{
 let state=initial();const original=state.routeDraft.title;
 for(const title of ['Second','Third'])state=saveEditor(state,{...state.routeDraft,title},state.revision);
 state=confirmRoute(state,state.revision);let revision=state.routeDraft.revision;
 for(const title of ['Second',original]){state=undoEditor(state,state.revision);assert.equal(state.routeDraft.title,title);assert.ok(state.routeDraft.revision>revision);revision=state.routeDraft.revision;assert.equal(state.confirmedRevision,undefined)}
 state=validatePlanning(JSON.parse(JSON.stringify(state)));
 for(const title of ['Second','Third']){state=redoEditor(state,state.revision);assert.equal(state.routeDraft.title,title);assert.ok(state.routeDraft.revision>revision);revision=state.routeDraft.revision}
 assert.throws(()=>redoEditor(state,state.revision),/PLANNING_INVALID/);
 const old=structuredClone(state);assert.throws(()=>undoEditor(state,state.revision-1),/PLANNING_CONFLICT/);assert.deepEqual(state,old);
 state=undoEditor(state,state.revision);state=saveEditor(state,{...state.routeDraft,title:'New branch'},state.revision);assert.equal(state.history.future.length,0);
});
test('legacy undo snapshots upgrade without losing forward navigation',()=>{
 let state=initial();state.undoRoute={...route(),title:'Legacy draft'};state=validatePlanning(state);
 state=undoEditor(state,state.revision);assert.equal(state.undoRoute,undefined);assert.equal(state.routeDraft.title,'Legacy draft');
 state=redoEditor(state,state.revision);assert.equal(state.routeDraft.title,'Synthetic route');
});
test('adopting AI changes uses the same undo and redo history',()=>{
 let state=initial();state=appendUser(state,'Revise','user1','req1',state.revision);
 state=applyEdit(state,{reply:'Proposed',route:{...state.routeDraft,title:'AI proposal'}},'req1',state.revision);state=applyProposal(state,state.revision);
 state=undoEditor(state,state.revision);assert.equal(state.routeDraft.title,'Synthetic route');
 state=redoEditor(state,state.revision);assert.equal(state.routeDraft.title,'AI proposal');assert.equal(state.proposal,undefined);
});
test('history stays bounded without truncating the current route',()=>{
 let state=initial();for(let i=0;i<28;i++)state=saveEditor(state,{...state.routeDraft,title:'Revision '+i},state.revision);
 assert.equal(state.history.past.length,20);assert.equal(state.routeDraft.title,'Revision 27');
 const large=route();large.chapters[0].nodes=Array.from({length:64},(_,i)=>({...large.chapters[0].nodes[0],id:'n'+i,objectives:[{id:'goal',description:'x'.repeat(1900)}]}));
 state=createPlanning(state.projectId,'codex','en',large);for(let i=0;i<22;i++)state=saveEditor(state,{...state.routeDraft,title:'Large '+i},state.revision);
 assert.ok(Buffer.byteLength(JSON.stringify(state.history))<=2_097_152);assert.equal(state.routeDraft.chapters[0].nodes.length,64);assert.equal(state.routeDraft.title,'Large 21');
});
test('chapter references are validated, persisted and used to distinguish retries',()=>{
 let state=initial(),target={chapterId:'ch',nodeId:'lesson'};
 state=appendUser(state,'Make this more concrete','user1','req1',state.revision,undefined,target);
 assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(state))).messages.at(-1).target,target);
 state=cancelPlanningRequest(state,'req1',state.revision);state=appendUser(state,'Make this more concrete','user2','req2',state.revision,undefined,target);assert.equal(state.messages.length,1);
 state=cancelPlanningRequest(state,'req2',state.revision);state=appendUser(state,'Make this more concrete','user3','req3',state.revision,undefined,{chapterId:'ch'});assert.equal(state.messages.length,2);
 state=cancelPlanningRequest(state,'req3',state.revision);const before=structuredClone(state);
 for(const target of [{chapterId:'missing'},{chapterId:'ch',nodeId:'missing'},{chapterId:'ch',path:'/not-allowed'}])assert.throws(()=>appendUser(state,'Revise','user4','req4',state.revision,undefined,target),/PLANNING_TARGET_UNAVAILABLE/);
 assert.deepEqual(state,before);
 state=saveEditor(state,{...state.routeDraft,chapters:[]},state.revision);assert.equal(validatePlanning(state).messages.length,2);
});
test('saving an unchanged route is idempotent and keeps confirmation',()=>{const s=confirmRoute(initial(),0);assert.deepEqual(saveEditor(s,s.routeDraft,s.revision),s)});
test('incomplete drafts can be saved and diagnose precise fields before confirmation',()=>{const s=initial(),r=route();r.chapters[0].stageGoal='';r.chapters[0].nodes[0].title='';const next=saveEditor(s,r,s.revision);assert.deepEqual(routeIssues(next.routeDraft).map(x=>x.path).sort(),['chapters.0.nodes.0.title','chapters.0.stageGoal']);assert.throws(()=>confirmRoute(next,next.revision),/PLANNING_ROUTE_INVALID/);assert.equal(next.routeDraft.chapters[0].stageGoal,'')});
test('deleting all chapters remains a savable draft but cannot be confirmed',()=>{const s=initial(),r=route();r.chapters=[];const next=saveEditor(s,r,s.revision);assert.equal(next.routeDraft.chapters.length,0);assert.ok(routeIssues(next.routeDraft).some(x=>x.path==='chapters'));assert.throws(()=>confirmRoute(next,next.revision),/PLANNING_ROUTE_INVALID/)});
test('project model preferences preserve content and confirmation, survive JSON and reset with provider',()=>{const s=confirmRoute(initial(),0),next=setAgentOptions(s,{model:'synthetic-model',effort:'high'},s.revision);assert.deepEqual(next.routeDraft,s.routeDraft);assert.equal(next.confirmedRevision,s.confirmedRevision);assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(next))).agentOptions,{model:'synthetic-model',effort:'high'});assert.equal(setProvider(next,'codebuddy',next.revision).agentOptions,undefined);assert.throws(()=>setAgentOptions(next,{model:'--evil',effort:'high'},next.revision),/PLANNING_INVALID/);assert.throws(()=>setAgentOptions(next,{model:'synthetic',effort:'invented'},next.revision),/PLANNING_INVALID/);assert.throws(()=>setAgentOptions(next,null,next.revision),/PLANNING_INVALID/)});

test('route readiness identifies invalid prerequisite references and cycles at the affected lessons',()=>{const r=route();r.chapters[0].nodes[0].prerequisites=['missing'];assert.deepEqual(routeIssues(r),[{path:'chapters.0.nodes.0.prerequisites',code:'dependencies'}]);const a=r.chapters[0].nodes[0];a.prerequisites=['second'];r.chapters[0].nodes.push({...structuredClone(a),id:'second',prerequisites:['lesson']});assert.deepEqual(routeIssues(r).map(x=>x.path),['chapters.0.nodes.0.prerequisites','chapters.0.nodes.1.prerequisites'])});

test('qualitative assessment points at its missing evaluation prompt',()=>{const r=route();r.chapters[0].nodes[0].assessment={task:'Explain the result',passCriteria:['Coherent explanation'],objectiveIds:['goal'],mode:'qualitative'};assert.ok(routeIssues(r).some(x=>x.path==='chapters.0.nodes.0.assessment.evaluatorPrompt'))});
