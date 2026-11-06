import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanning,appendUser,applyInterview,acceptAnswer,reanswerQuestion,cancelPlanningRequest,agentInterviewDiagnostics,validatePlanning} from '../packages/domain/planning.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc',now='2026-11-04T02:00:00.000Z';
const first='10000000-0000-4000-8000-000000000001',second='20000000-0000-4000-8000-000000000002';
const topicRequest='30000000-0000-4000-8000-000000000003';
function conversation(){
 let state=appendUser(createPlanning(project,'codebuddy','zh-CN'),'想提升工作能力','user0',first,0,now);
 state=applyInterview(state,{reply:'可以学习数据分析，你觉得这个方向如何？',updates:[{id:'goal',fields:{},evidence:[],missing:['学习方向和成果'],complete:false}]},first,state.revision,now);
 state=appendUser(state,'想学数据分析','user1',topicRequest,state.revision,now);
 state=applyInterview(state,{reply:'可以做一份销售分析报告，你觉得可以吗？',updates:[{id:'goal',fields:{topic:'数据分析'},evidence:[{field:'topic',messageId:'user1',quote:'用户给出方向'}],missing:['学习成果'],complete:false}]},topicRequest,state.revision,now);
 return appendUser(state,'可以，就做这个报告','user2',second,state.revision,now);
}
const result=()=>({reply:'请核对总结',summary:'学习数据分析，制作销售分析报告',updates:[{id:'goal',fields:{topic:'数据分析',outcome:'制作销售分析报告'},evidence:[{field:'topic',messageId:'user1',quote:'SENSITIVE_EXPLANATION',proposalMessageId:first},{field:'outcome',messageId:'user2',quote:'用户同意建议',proposalMessageId:topicRequest}],missing:[],complete:true}]});

test('interview resolves omitted assistant prefixes to an existing earlier suggestion and still requires answer adoption',()=>{
 const state=conversation(),input=result(),original=structuredClone(input),before=structuredClone(state);
 assert.deepEqual(agentInterviewDiagnostics(state,input),{issues:[]});
 const saved=applyInterview(state,input,second,state.revision,now);
 assert.deepEqual(input,original);assert.deepEqual(state,before);
 assert.deepEqual(saved.questions[0].evidence.map(e=>e.proposalMessageId),['assistant_'+first,'assistant_'+topicRequest]);
 assert.equal(saved.questions[0].status,'awaiting-confirmation');assert.equal(saved.currentQuestion,'goal');
 assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(saved))),saved);
 const accepted=acceptAnswer(saved,'goal',saved.questions[0].answerProposal.messageId,saved.revision);
 assert.equal(accepted.questions[0].status,'complete');assert.equal(accepted.currentQuestion,'purpose');
});

test('canonical suggestion IDs and direct user facts remain unchanged',()=>{
 const state=conversation(),input=result();input.updates[0].evidence[0].proposalMessageId='assistant_'+first;delete input.updates[0].evidence[1].proposalMessageId;
 const saved=applyInterview(state,input,second,state.revision,now);
 assert.deepEqual(saved.questions[0].evidence,input.updates[0].evidence);
});

test('unknown, ambiguous, wrong-role, future and cross-question references are rejected atomically with safe diagnostics',()=>{
 for(const [kind,code] of [['unknown','reference'],['role','role'],['collision','role'],['future','order'],['other-question','scope']]){
  const state=conversation(),input=result(),e=input.updates[0].evidence[1];
  if(kind==='unknown')e.proposalMessageId='unrecognized';
  if(kind==='role')e.proposalMessageId='user1';
  if(kind==='collision')state.messages.push({id:first,role:'user',text:'SENSITIVE_COLLISION',createdAt:now,questionId:'goal'});
  if(kind==='future'){state.messages.push({id:'assistant_future',role:'assistant',text:'SENSITIVE_FUTURE',createdAt:now,questionId:'goal'});e.proposalMessageId='assistant_future'}
  if(kind==='other-question'){state.messages[1].questionId='purpose';e.proposalMessageId='assistant_'+first}
  const before=structuredClone(state),diagnosis=agentInterviewDiagnostics(state,input);
  assert.ok(diagnosis.issues.some(i=>i.path.endsWith('.proposalMessageId')&&i.code===code),kind);
  assert.throws(()=>applyInterview(state,input,second,state.revision,now),/PLANNING_EVIDENCE_INVALID/,kind);
  assert.deepEqual(state,before);assert.doesNotMatch(JSON.stringify(diagnosis),/SENSITIVE|10000000|user1|unrecognized/);
 }
});

test('reset attempts cannot reuse old user or suggestion references',()=>{
 let state=conversation();state=cancelPlanningRequest(state,second,state.revision);state=reanswerQuestion(state,'goal',state.revision);
 state=appendUser(state,'重新学习数据分析','new-user','new-request',state.revision,now);
 const oldUser=result();assert.throws(()=>applyInterview(state,oldUser,'new-request',state.revision,now),/EVIDENCE/);
 const oldSuggestion=result();for(const e of oldSuggestion.updates[0].evidence)e.messageId='new-user';
 assert.throws(()=>applyInterview(state,oldSuggestion,'new-request',state.revision,now),/EVIDENCE/);
});

test('missing, duplicate, unmatched and wrong-role user evidence receives bounded field-only diagnostics',()=>{
 const state=conversation();
 for(const [kind,code] of [['missing','required'],['duplicate','duplicate'],['unmatched','field'],['user-role','role']]){
  const input=result();
  if(kind==='missing')input.updates[0].evidence.pop();
  if(kind==='duplicate')input.updates[0].evidence.push({...input.updates[0].evidence[1]});
  if(kind==='unmatched')input.updates[0].evidence.push({...input.updates[0].evidence[1],field:'unused'});
  if(kind==='user-role')input.updates[0].evidence[1].messageId='assistant_'+first;
  assert.ok(agentInterviewDiagnostics(state,input).issues.some(i=>i.code===code));
  assert.throws(()=>applyInterview(state,input,second,state.revision,now),/EVIDENCE/);
 }
});
