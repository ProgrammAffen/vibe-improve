import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,readdir,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {setResources,acceptAnswer,reanswerQuestion,questionMessages,reopenIntake,needsGenerationReplacement,resetEditor,createPlanning,appendUser,applyInterview,canGenerate,parseInterviewResult,validatePlanning,startGeneration,applyGenerated,cancelPlanningRequest,focusQuestion,openEditor,saveEditor,confirmRoute,applyEdit,applyProposal,discardProposal,undoEditor,upgradeRoute,validateEditorDraft,recoverPlanning,setProvider,importRoute,sameRoute,agentRouteDiagnostics} from '../packages/domain/planning.mjs';
import {parseRoute,validateRoute} from '../packages/domain/route-validation.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc',now='2026-10-29T06:00:00.000Z';
const source=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
const v2=()=>{const route=upgradeRoute(source);for(const chapter of route.chapters)chapter.stageGoal=chapter.nodes.map(node=>node.objectives[0].description).join('；');return route};
const initial=()=>createPlanning(project,'codex','zh-CN');
test('agent route diagnostics identify structural, identity and dependency issues without source content',()=>{
  const state=createPlanning(project,'codebuddy','zh-CN',v2());
  const invalid=structuredClone(state.routeDraft);delete invalid.chapters[0].stageGoal;
  const structural=agentRouteDiagnostics(state,invalid);assert.ok(structural.issues.some(i=>i.path==='chapters.0.stageGoal'&&i.code==='required'));
  const identity=structuredClone(state.routeDraft);identity.id='different-route';assert.ok(agentRouteDiagnostics(state,identity).issues.some(i=>i.path==='id'&&i.code==='identity'));
  const dependency=structuredClone(state.routeDraft);dependency.chapters[0].nodes[0].prerequisites=['missing-node'];assert.ok(agentRouteDiagnostics(state,dependency).issues.some(i=>i.code==='dependencies'));
  assert.deepEqual(agentRouteDiagnostics(state,state.routeDraft),{issues:[]});assert.ok(!JSON.stringify(structural).includes(state.routeDraft.title));
});
const answer='我想学Python，完成销售数据分析报告，用于周会，能解释趋势与异常。未用过Python，零基础。每周4小时，每次30分钟。不学模型训练，电脑与Python可用。';
const allFields={goal:{topic:'Python',outcome:'完成销售数据分析报告'},purpose:{context:'用于周会',criteria:'能解释趋势与异常'},baseline:{experience:'未用过Python',support:'零基础'},time:{weekly:'每周4小时',session:'每次30分钟'},constraints:{scope:'不学模型训练',conditions:'电脑与Python可用'}};
const update=(id,fields,messageId='m1',quote=answer,missing=[],complete=true)=>({id,fields,evidence:Object.keys(fields).map(field=>({field,messageId,quote})),missing,complete});
function approve(state,id=state.currentQuestion){return acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}
const consistent={status:'consistent',issues:[]};
function completed(){let state=initial();for(const [id,fields] of Object.entries(allFields)){state=appendUser(state,answer,'m-'+id,'r-'+id,state.revision,now);state=applyInterview(state,{reply:'请核对总结',summary:Object.values(fields).join('；'),consistency:consistent,updates:[update(id,fields,'m-'+id)]},'r-'+id,state.revision,now);state=approve(state,id)}return state}

test('each answer requires explicit adoption before checklist completion and advancement',()=>{
 let state=appendUser(initial(),answer,'m1','r1',0,now);state=applyInterview(state,{reply:'请核对',summary:'学习 Python，制作销售报告。',updates:[update('goal',allFields.goal)]},'r1',state.revision,now);
 assert.equal(state.currentQuestion,'goal');assert.equal(state.questions[0].status,'awaiting-confirmation');assert.equal(canGenerate(state),false);
 assert.equal(validatePlanning(JSON.parse(JSON.stringify(state))).questions[0].answerProposal.summary,'学习 Python，制作销售报告。');
 assert.throws(()=>acceptAnswer(state,'goal','wrong',state.revision),/CONFLICT/);state=approve(state);assert.equal(state.currentQuestion,'purpose');assert.equal(state.questions[0].status,'complete');
 assert.equal(canGenerate(completed()),true);assert.equal(completed().messages.length,10);
});
test('incomplete decisions keep the current question and never enable answer adoption',()=>{
 let state=focusQuestion(initial(),'time',0);state=appendUser(state,'每周4小时','m1','r1',state.revision,now);
 state=applyInterview(state,{reply:'每次大概多久？',summary:'',updates:[update('time',{weekly:'每周4小时'},'m1','每周预算',['每次多久？'],false)]},'r1',state.revision,now);
 assert.equal(state.currentQuestion,'time');assert.equal(state.questions[3].status,'needs-detail');assert.equal(state.questions[3].answerProposal,undefined);assert.equal(canGenerate(state),false);
 assert.throws(()=>acceptAnswer(state,'time','assistant_r1',state.revision),/CONFLICT/);
});
test('AI summaries and normalized facts are reviewed without literal matching',()=>{
 let state=focusQuestion(initial(),'time',0);state=appendUser(state,'每周三小时，每次一刻钟','m1','r1',state.revision,now);
 state=applyInterview(state,{reply:'请核对时间安排',summary:'每周约3小时，每次约15分钟。',updates:[update('time',{weekly:'每周3小时',session:'每次15分钟'},'m1','用户给出可持续预算')]},'r1',state.revision,now);
 assert.equal(state.questions[3].status,'awaiting-confirmation');state=approve(state,'time');assert.equal(state.questions[3].fields.session,'每次15分钟');assert.equal(state.questions[3].status,'complete');
});
test('fabricated evidence and updates to another question fail atomically',()=>{
 const state=appendUser(initial(),'想学习Python','m1','r1',0,now),before=JSON.stringify(state);
 for(const e of [{field:'topic',messageId:'missing',quote:'用户希望学习 Python'},{field:'topic',messageId:'m1',quote:'上下文',proposalMessageId:'missing'}])assert.throws(()=>applyInterview(state,{reply:'核对',updates:[{id:'goal',fields:{topic:'Python'},evidence:[e],missing:[],complete:true}]},'r1',state.revision,now),/EVIDENCE/);
 assert.throws(()=>applyInterview(state,{reply:'核对',updates:[update('goal',allFields.goal),update('time',allFields.time)]},'r1',state.revision,now),/RESPONSE/);assert.equal(JSON.stringify(state),before);
});
test('natural assent to an AI suggestion still needs the separate Use this answer action',()=>{
 let state=focusQuestion(initial(),'purpose',0);state=appendUser(state,'用于周会','m1','r1',state.revision,now);
 state=applyInterview(state,{reply:'能解释趋势与异常，是否合适？',updates:[update('purpose',{context:'周会'},'m1','用户给出的用途',['标准是否合适？'],false)]},'r1',state.revision,now);const proposalMessageId=state.messages.at(-1).id;
 for(const [index,text]of ['好','可以','sounds good'].entries()){let next=appendUser(state,text,'yes'+index,'yes-request'+index,state.revision,now);next=applyInterview(next,{reply:'请核对总结',summary:'在周会中解释趋势与异常。',updates:[{id:'purpose',fields:{criteria:'解释趋势与异常'},evidence:[{field:'criteria',messageId:'yes'+index,quote:'用户同意之前建议',proposalMessageId}],missing:[],complete:true}]},'yes-request'+index,next.revision,now);assert.equal(next.questions[1].status,'awaiting-confirmation');assert.equal(approve(next,'purpose').questions[1].status,'complete')}
});
test('reanswer isolates the new draft and retains the accepted baseline without deleting other answers',()=>{
 let state=completed(),original=structuredClone(state.questions[1]);state=reanswerQuestion(state,'goal',state.revision);
 assert.equal(state.questions[0].status,'current');assert.deepEqual(state.questions[0].fields,{});assert.deepEqual(state.questions[0].acceptedSnapshot.fields,allFields.goal);assert.equal(questionMessages(state,'goal').length,0);assert.deepEqual(state.questions[1],original);assert.equal(canGenerate(state),false);
 state=appendUser(state,answer,'again','again-request',state.revision,now);assert.throws(()=>applyInterview(state,{reply:'old',updates:[update('goal',allFields.goal,'m-goal')]},'again-request',state.revision,now),/EVIDENCE/);state=applyInterview(state,{reply:'请核对',summary:'相同的目标也需采用',consistency:consistent,updates:[update('goal',allFields.goal,'again')]},'again-request',state.revision,now);assert.equal(questionMessages(state,'goal').length,2);assert.ok(questionMessages(state,'goal').every(m=>m.questionId==='goal'));assert.equal(state.questions[0].status,'awaiting-confirmation');assert.equal(canGenerate(approve(state)),true);
});
test('newer answers invalidate a previous summary and stale requests cannot overwrite it',()=>{
 let state=appendUser(initial(),answer,'m1','r1',0,now);assert.throws(()=>appendUser(state,'new','m2','r2',state.revision,now),/BUSY/);
 state=applyInterview(state,{reply:'核对',updates:[update('goal',allFields.goal)]},'r1',state.revision,now);const old=state.questions[0].answerProposal.messageId;
 state=appendUser(state,answer,'m2','r2',state.revision,now);assert.equal(state.questions[0].answerProposal,undefined);assert.throws(()=>acceptAnswer(state,'goal',old,state.revision),/BUSY/);
 state=cancelPlanningRequest(state,'r2',state.revision);assert.throws(()=>applyInterview(state,{reply:'old',updates:[]},'r2',state.revision-1,now),/CONFLICT/);
});
test('regeneration always starts a fresh request and changed answers require replacement consent',()=>{
 let state=completed();state=startGeneration(state,'gen1',state.revision);state=applyGenerated(state,v2(),'gen1',state.revision);const old=structuredClone(state.routeDraft);state=reopenIntake(state,state.revision);
 state=startGeneration(state,'gen2',state.revision);assert.equal(state.pending.id,'gen2');state=cancelPlanningRequest(state,'gen2',state.revision);
 state=reanswerQuestion(state,'goal',state.revision);state=appendUser(state,answer,'again','review',state.revision,now);state=applyInterview(state,{reply:'核对',consistency:consistent,updates:[update('goal',allFields.goal,'again')]},'review',state.revision,now);state=approve(state);
 assert.equal(needsGenerationReplacement(state),true);assert.throws(()=>startGeneration(state,'gen3',state.revision),/REPLACE_REQUIRED/);assert.deepEqual(state.routeDraft,old);
 state=startGeneration(state,'gen3',state.revision,true);state=applyGenerated(state,v2(),'gen3',state.revision);assert.equal(state.intakeChanged,false);assert.equal(state.history.past.length,1);
});
test('regeneration diagnostics allow fresh identities while edit diagnostics preserve identity checks',()=>{
 let state=completed();state=startGeneration(state,'first',state.revision);state=applyGenerated(state,v2(),'first',state.revision);
 const original=structuredClone(state.routeDraft);state=reopenIntake(state,state.revision);state=startGeneration(state,'again',state.revision);
 const fresh=structuredClone(original);fresh.id='fresh-generated-route';fresh.locale='en';fresh.sourceLanguage='en';delete fresh.chapters[0].stageGoal;
 const before=JSON.stringify(state),diagnosis=agentRouteDiagnostics(state,fresh);
 assert.deepEqual(diagnosis.issues,[{path:'chapters.0.stageGoal',code:'required'}]);
 assert.throws(()=>applyGenerated(state,fresh,'again',state.revision),/ROUTE/);assert.equal(JSON.stringify(state),before);assert.deepEqual(state.routeDraft,original);
 let edit=createPlanning(project,'codebuddy','zh-CN',original);edit=appendUser(edit,'Modify a chapter','edit-user','edit-request',edit.revision,now);
 const identityIssues=agentRouteDiagnostics(edit,fresh).issues.filter(issue=>issue.code==='identity');
 assert.deepEqual(identityIssues.map(issue=>issue.path),['id','locale','sourceLanguage']);
});
test('strict model result parsing rejects duplicate keys, unknown questions, duplicate updates and oversized replies',()=>{
  assert.throws(()=>parseInterviewResult('{"reply":"a","reply":"b","updates":[]}'),/RESPONSE/);
  for(const result of [{reply:'x',updates:[{id:'password',fields:{},evidence:[],missing:[],complete:true}]},{reply:'x',updates:[update('goal',{}),update('goal',{})]},{reply:'x'.repeat(8001),updates:[]},{reply:'x',updates:[],allDone:true}])assert.throws(()=>parseInterviewResult(JSON.stringify(result)),/RESPONSE/);
});
test('generated route is accepted only after all mandatory evidence, complete termination and valid v2 structure',()=>{
  assert.throws(()=>startGeneration(initial(),'gen',0),/INCOMPLETE/);
  let state=completed();state=startGeneration(state,'gen',state.revision);
  assert.equal(canGenerate(state),false);assert.throws(()=>applyGenerated(state,source,'gen',state.revision),/ROUTE/);
  const route=v2();route.chapters[0].nodes[0].activities=['阅读示例并独立解释'];
  state=applyGenerated(state,route,'gen',state.revision);assert.equal(state.step,'editor');assert.equal(state.pending,undefined);assert.equal(state.routeDraft.schemaVersion,2);
  assert.equal(state.confirmedRevision,undefined);
});
test('switching to a manual creation draft preserves the previous route in undo history',()=>{
 let state=createPlanning(project,'codex','zh-CN',v2()),before=structuredClone(state.routeDraft);state=resetEditor(state,state.revision);
 assert.equal(state.routeDraft.chapters.length,0);assert.equal(state.importedOriginal,undefined);assert.equal(state.step,'editor');
 state=undoEditor(state,state.revision);assert.equal(state.routeDraft.title,before.title);assert.deepEqual(state.routeDraft.chapters,before.chapters);
});
test('manual and legacy imports support incomplete drafts without silently inventing chapter goals or modifying sources',()=>{
  const original=JSON.stringify(source),manual=createPlanning(project,null,'en');
  assert.equal(manual.step,'editor');assert.equal(manual.routeDraft.chapters.length,0);assert.throws(()=>confirmRoute(manual,manual.revision),/ROUTE/);
  const imported=createPlanning(project,null,'zh-CN',source);
  assert.equal(imported.step,'editor');assert.equal(imported.routeDraft.chapters[0].stageGoal,'');assert.deepEqual(imported.importedOriginal,source);assert.equal(JSON.stringify(source),original);
  assert.throws(()=>confirmRoute(imported,imported.revision),/ROUTE/);
  const saved=saveEditor(imported,v2(),imported.revision),confirmed=confirmRoute(saved,saved.revision);assert.equal(confirmed.confirmedRevision,confirmed.routeDraft.revision);
});
test('AI edits are reviewable proposals with explicit apply/discard and revision-safe undo',()=>{
  let state=createPlanning(project,'codex','zh-CN',v2()),before=structuredClone(state.routeDraft);
  state=appendUser(state,'改名','m1','edit',state.revision,now);const edited=structuredClone(before);edited.title='调整后的路线';
  state=applyEdit(state,{reply:'建议修改标题。',route:edited},'edit',state.revision,now);
  assert.deepEqual(state.routeDraft,before);assert.equal(state.proposal.route.title,edited.title);
  const discarded=discardProposal(state,state.revision);assert.equal(discarded.proposal,undefined);assert.deepEqual(discarded.routeDraft,before);
  state=applyProposal(state,state.revision);assert.equal(state.routeDraft.title,edited.title);assert.equal(state.proposal,undefined);
  state=undoEditor(state,state.revision);assert.equal(state.routeDraft.title,before.title);assert.ok(state.routeDraft.revision>before.revision);
});
test('manual changes invalidate prior model proposal rather than letting it overwrite the updated draft',()=>{
  let state=createPlanning(project,'codex','zh-CN',v2());state=appendUser(state,'提案','m1','edit',state.revision,now);
  const edited=structuredClone(state.routeDraft);edited.title='AI标题';state=applyEdit(state,{reply:'提议',route:edited},'edit',state.revision,now);
  const manual=structuredClone(state.routeDraft);manual.title='人工标题';state=saveEditor(state,manual,state.revision);
  assert.equal(state.proposal,undefined);assert.throws(()=>applyProposal(state,state.revision),/CONFLICT/);assert.equal(state.routeDraft.title,'人工标题');
});
test('editor conversation answers without a route and preserves incomplete drafts and confirmed routes',()=>{
 for(const mode of ['incomplete','confirmed']){
  let state=createPlanning(project,'codex','zh-CN',v2());
  if(mode==='incomplete')state.routeDraft.chapters[0].stageGoal='';else state=confirmRoute(state,state.revision);
  const before=structuredClone(state.routeDraft),confirmed=state.confirmedRevision;
  state=appendUser(state,'描述当前所有章节的内容','chat-user','chat-request',state.revision,now);
  state=applyEdit(state,{reply:'第一章准备数据，第二章进行分析和展示。',route:null},'chat-request',state.revision,now);
  assert.equal(state.messages.at(-1).role,'assistant');assert.match(state.messages.at(-1).text,/第一章/);
  assert.deepEqual(state.routeDraft,before);assert.equal(state.confirmedRevision,confirmed);assert.equal(state.pending,undefined);assert.equal(state.proposal,undefined);
  state=appendUser(state,'还能解释一下吗？','chat-user2','chat-request2',state.revision,now);
  state=applyEdit(state,{reply:'先准备可靠的数据，再独立解释结果。'},'chat-request2',state.revision,now);
  assert.deepEqual(state.routeDraft,before);assert.equal(state.confirmedRevision,confirmed);
 }
});
test('conversation does not replace an existing pending proposal, and identical routes are not new proposals',()=>{
 let state=createPlanning(project,'codex','zh-CN',v2());const route=structuredClone(state.routeDraft);
 state=appendUser(state,'介绍路线','m1','r1',state.revision,now);
 state=applyEdit(state,{reply:'这是已有路线。',route:{...route,revision:route.revision+1}},'r1',state.revision,now);
 assert.equal(state.proposal,undefined);assert.deepEqual(state.routeDraft,route);
 state=appendUser(state,'改标题','m2','r2',state.revision,now);
 state=applyEdit(state,{reply:'建议采用新标题。',route:{...route,title:'新标题'}},'r2',state.revision,now);
 const proposal=structuredClone(state.proposal),undo=structuredClone(state.undoRoute??null);
 state=appendUser(state,'解释修改的原因','m3','r3',state.revision,now);
 state=applyEdit(state,{reply:'新标题更贴近你的目标。',route:null},'r3',state.revision,now);
 assert.deepEqual(state.proposal,proposal);assert.deepEqual(state.undoRoute??null,undo);assert.deepEqual(state.routeDraft,route);
});
test('failed or cancelled editor messages can retry without duplicate user messages or losing confirmation',()=>{
 let state=createPlanning(project,'codex','en',v2());state=confirmRoute(state,state.revision);
 const confirmed=state.confirmedRevision,route=structuredClone(state.routeDraft);
 state=appendUser(state,'Describe all chapters','m1','r1',state.revision,now);
 state=cancelPlanningRequest(state,'r1',state.revision);assert.equal(state.confirmedRevision,confirmed);
 state=appendUser(state,'Describe all chapters','m2','r2',state.revision,now);
 assert.equal(state.messages.filter(m=>m.role==='user').length,1);assert.equal(state.messages[0].id,'m1');
 assert.throws(()=>applyEdit(state,{reply:'late',route:null},'r1',state.revision,now),/CONFLICT/);
 state=applyEdit(state,{reply:'The first chapter prepares data; the second presents results.',route:null},'r2',state.revision,now);
 assert.equal(state.messages.length,2);assert.equal(state.confirmedRevision,confirmed);assert.deepEqual(state.routeDraft,route);
 state=appendUser(state,'Describe all chapters','m3','r3',state.revision,now);
 assert.equal(state.messages.filter(m=>m.role==='user').length,2);
 const recovered=recoverPlanning(state,now);assert.equal(recovered.confirmedRevision,confirmed);assert.deepEqual(recovered.routeDraft,route);
});
test('malformed conversational results remain atomic and cannot bypass route validation for edits',()=>{
 const state=appendUser(createPlanning(project,'codex','en',v2()),'Explain this route','m1','r1',0,now),before=JSON.stringify(state);
 for(const result of [{reply:'answer',route:'unchanged'},{reply:'answer',route:[]},{reply:'answer',route:null,allDone:true},{reply:'',route:null}])assert.throws(()=>applyEdit(state,result,'r1',state.revision,now),/PLANNING_/);
 assert.equal(JSON.stringify(state),before);
});
test('explicit import replacement preserves source, supports undo, and identical source is idempotent regardless of key order',()=>{
  let state=createPlanning(project,null,'en',source);const other=v2();other.id='otherRoute';other.title='Another';state=importRoute(state,other,state.revision);
  assert.equal(state.importedOriginal.id,'otherRoute');assert.equal(state.routeDraft.id,'otherRoute');
  const reversed=Object.fromEntries(Object.entries(other).reverse());assert.equal(sameRoute(other,reversed),true);
  assert.equal(importRoute(state,reversed,state.revision).revision,state.revision);
  state=undoEditor(state,state.revision);assert.equal(state.routeDraft.id,source.id);
});
test('switching Agent or choosing manual preserves background and only changes execution choice',()=>{
  const state=completed(),manual=setProvider(state,null,state.revision);assert.deepEqual(manual.questions,state.questions);assert.equal(manual.provider,null);
  const editor=openEditor(manual,manual.revision);assert.equal(editor.step,'editor');assert.throws(()=>appendUser(editor,'x','m2','r2',editor.revision,now),/INVALID/);
});
test('interrupted pending requests are recoverable without replaying generation or discarding user messages',()=>{
  const state=appendUser(initial(),answer,'m1','r1',0,now),recovered=recoverPlanning(state,now);
  assert.equal(recovered.pending,undefined);assert.equal(recovered.messages[0].text,answer);assert.match(recovered.messages.at(-1).text,/中断/);
  assert.throws(()=>applyInterview(recovered,{reply:'old',updates:[]},'r1',state.revision,now),/CONFLICT/);
});
test('v2 route rules retain v1 compatibility and validate qualitative criteria in JS and Python',async()=>{
  validateRoute(source);const route=v2(),assessment=route.chapters[0].nodes[0].assessment;
  assessment.mode='qualitative';assert.throws(()=>validateRoute(route),/INVALID/);assessment.evaluatorPrompt='引用任务证据并按达标条件逐项判断，证据不足时明确说明。';validateRoute(route);
  const missing=structuredClone(route);delete missing.chapters[0].stageGoal;
  const extra=structuredClone(source);extra.chapters[0].stageGoal='不属于旧版';assert.throws(()=>validateRoute(extra),/INVALID/);
  await mkdir('tmp/checks/planning-domain',{recursive:true});
  for(const [index,value] of [source,route,missing,extra].entries()){
    const path=`tmp/checks/planning-domain/route-${index}.json`;await writeFile(path,JSON.stringify(value));
    let accepted=true;try{parseRoute(JSON.stringify(value))}catch{accepted=false}
    let python=spawnSync('python3',['-B','scripts/validate_route.py',path],{encoding:'utf8'});
    if(process.platform==='darwin'&&python.status!==0&&python.stderr.includes('incompatible architecture'))python=spawnSync('/usr/bin/arch',['-arm64','/Library/Developer/CommandLineTools/usr/bin/python3','-B','scripts/validate_route.py',path],{encoding:'utf8'});
    assert.equal(python.status===0,accepted,python.stderr);
  }
});
test('persistent state validation rejects fabricated evidence or another project identity payload',()=>{
  const state=completed(),bad=structuredClone(state);bad.questions[0].evidence[0].messageId='missing';assert.throws(()=>validatePlanning(bad),/INVALID/);
  const another=structuredClone(state);another.projectId='../project';assert.throws(()=>validatePlanning(another),/INVALID/);
  const duplicate=structuredClone(state);duplicate.messages.push(duplicate.messages[0]);assert.throws(()=>validatePlanning(duplicate),/INVALID/);
});
test('message and revision limits reject work before a request can become permanently pending',()=>{
  const state=initial();state.messages=Array.from({length:127},(_,index)=>({id:'m'+index,role:'user',text:'A response',createdAt:now}));validatePlanning(state);
  assert.throws(()=>appendUser(state,'New','new','request',0,now),/LIMIT/);assert.equal(state.pending,undefined);
  const revision=initial();revision.revision=999998;assert.throws(()=>appendUser(revision,'New','new','request',999998,now),/CONFLICT/);
  const duplicated=completed();duplicated.questions[0].evidence.push(duplicated.questions[0].evidence[0]);assert.throws(()=>validatePlanning(duplicated),/INVALID/);
  const confirmed=createPlanning(project,null,'en');confirmed.confirmedRevision=confirmed.routeDraft.revision;assert.throws(()=>validatePlanning(confirmed),/INVALID/);
});
test('native PlanningStore atomically persists, preserves active jobs, recovers after restart and leaves the chosen workspace untouched',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
  const root=resolve('.');await mkdir('tmp/checks/planning-domain',{recursive:true});const dir=await mkdtemp('tmp/checks/planning-domain/native-'),validator=resolve(dir,'planning.js'),main=resolve(dir,'main.swift'),binary=resolve(dir,'store-test'),runtime=resolve(dir,'Runtime'),workspace=resolve(dir,'Workspace');await mkdir(workspace);
  await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:validator});
  await writeFile(main,`import Foundation
func check(_ value:Bool){precondition(value)}
let runtime=URL(fileURLWithPath:CommandLine.arguments[1]),validator=URL(fileURLWithPath:CommandLine.arguments[2]),workspace=URL(fileURLWithPath:CommandLine.arguments[3])
let id="${project}"
func make()throws->PlanningStore{try PlanningStore(runtime:RuntimeDirectory(url:runtime),validatorURL:validator,workspace:{value in guard value==id else{throw PlanningError.project};return workspace})}
let store=try make();check(try store.read(projectID:id)==nil)
let entered=try store.enter(projectID:id,provider:"codex",locale:"zh-CN");precondition(entered["revision"] as? Int==0)
let pending=try store.appendUser(projectID:id,text:"我想学Python。",messageID:"message1",requestID:"request1",expectedRevision:0)
precondition(pending["pending"] != nil);check(try store.read(projectID:id)?["pending"] != nil)
do{_ = try store.openEditor(projectID:id,expectedRevision:0);preconditionFailure()}catch PlanningError.conflict{}
let restarted=try make(),restored=try restarted.read(projectID:id)!
precondition(restored["pending"]==nil);precondition((restored["messages"] as? [[String:Any]])?.count==2)
check((try restarted.read(projectID:id)!["messages"] as? [[String:Any]])?.count==2)
let followup=try restarted.appendUser(projectID:id,text:"做一份销售报表",messageID:"message2",requestID:"request2",expectedRevision:restored["revision"] as! Int)
var judged=try restarted.applyInterview(projectID:id,result:["reply":"目标已明确。","updates":[["id":"goal","fields":["topic":"Python 数据分析","outcome":"独立制作销售分析报告"],"evidence":[["field":"topic","messageId":"message1","quote":"用户选择 Python 方向"],["field":"outcome","messageId":"message2","quote":"用户希望制作报表"]],"missing":[],"complete":true]]],requestID:"request2",baseRevision:followup["revision"] as! Int)
precondition((judged["questions"] as! [[String:Any]])[0]["status"] as? String=="awaiting-confirmation")
judged=try restarted.acceptAnswer(projectID:id,questionID:"goal",messageID:"assistant_request2",expectedRevision:judged["revision"] as! Int)
let reopened=try make().read(projectID:id)!
precondition((reopened["questions"] as! [[String:Any]])[0]["status"] as? String=="complete")
precondition(reopened["currentQuestion"] as? String=="purpose")
let editor=try restarted.openEditor(projectID:id,expectedRevision:judged["revision"] as! Int);precondition(editor["step"] as? String=="editor")
do{_ = try restarted.confirmRoute(projectID:id,expectedRevision:editor["revision"] as! Int);preconditionFailure()}catch PlanningError.route{}
do{_ = try restarted.read(projectID:"proj_12345678-1234-4234-8234-123456789abd");preconditionFailure()}catch PlanningError.project{}
print("PASS native planning persistence")
`);
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),'-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',main,'-o',binary],{encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
  const result=spawnSync(binary,[runtime,validator,workspace],{encoding:'utf8'});assert.equal(result.status,0,result.stderr+result.stdout);assert.match(result.stdout,/PASS/);
  assert.deepEqual(await readdir(workspace),[]);assert.equal((await stat(join(runtime,'projects/planning',project+'.json'))).mode&0o777,0o600);
});

test('AI completion atomically updates the reply, question, count and next step across multiple turns',()=>{
 let state=appendUser(initial(),'想学习深度学习','goal-topic','collect-topic',0,now);
 state=applyInterview(state,{reply:'你希望用它做成什么，比如一个图像分类模型？',updates:[update('goal',{topic:'深度学习'},'goal-topic','想学习深度学习',['希望学完做成什么？'],false)]},'collect-topic',state.revision,now);
 assert.equal(state.questions[0].status,'needs-detail');assert.equal(state.currentQuestion,'goal');
 assert.match(state.messages.at(-1).text,/图像分类模型/);
 state=appendUser(state,'实现一个图像分类模型','goal-outcome','collect-outcome',state.revision,now);
 state=applyInterview(state,{reply:'目标已明确，我们接着看看使用场景。',updates:[update('goal',{outcome:'能够独立训练一个图像分类器'},'goal-outcome','用户希望实现图像分类模型',[],true)]},'collect-outcome',state.revision,now);
 assert.equal(state.questions[0].status,'awaiting-confirmation');state=approve(state);assert.equal(state.currentQuestion,'purpose');
 assert.equal(state.questions.filter(q=>q.status==='complete').length,1);
 assert.match(state.messages.at(-1).text,/目标已明确/);
 const revisited=reanswerQuestion(state,'goal',state.revision),pending=appendUser(revisited,'对，就是这个目标。','same-goal','confirm-goal',revisited.revision,now);
 const reviewed=applyInterview(pending,{reply:'请核对这个目标。',updates:[update('goal',{topic:'深度学习',outcome:'实现图像分类模型'},'same-goal')]},'confirm-goal',pending.revision,now);
 assert.equal(reviewed.questions[0].status,'awaiting-confirmation');assert.equal(approve(reviewed).questions[0].status,'complete');
});

test('structurally contradictory completion and empty completion fail without losing saved answers',()=>{
 const state=appendUser(initial(),'先看看','m1','r1',0,now),before=JSON.stringify(state);
 for(const item of [update('goal',{}),update('goal',{topic:'学习方向'},'m1','用户尚在考虑',['期望做成什么？'],true)]){
  assert.throws(()=>applyInterview(state,{reply:'已采集。',updates:[item]},'r1',state.revision,now),/RESPONSE_INVALID/);
 }
 assert.equal(JSON.stringify(state),before);
 const saved=completed();saved.questions[0].missing=['有待补充'];assert.throws(()=>validatePlanning(saved),/PLANNING_INVALID/);
});

test('optional resources remain separate from question conversations and do not reset adopted answers',()=>{const before=completed(),next=setResources(before,'Synthetic course notes',before.revision);assert.equal(canGenerate(next),false);assert.deepEqual(next.questions,before.questions);assert.deepEqual(next.messages,before.messages);assert.equal(next.resources,'Synthetic course notes')});
