import {sha256} from './sha256.mjs';

export const CONSISTENCY_VERSION='answer-consistency.v1';
export const QUESTION_FIELDS=Object.freeze({goal:['topic','outcome'],purpose:['context','criteria','aids'],baseline:['experience','support','strategy'],time:['weekly','session','schedule','deadline','deadlineType'],constraints:['scope','conditions','strategy']});
const questionIds=Object.keys(QUESTION_FIELDS);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed,required=allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&value.trim().length>0;
const fail=()=>{throw new Error('PLANNING_RESPONSE_INVALID')};
const canonical=value=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

// Legacy complete answers remain readable. Their first mutation materializes a
// stable snapshot; absence of a receipt never counts as a successful check.
export function acceptedAnswer(question){
  if(question.acceptedSnapshot)return question.acceptedSnapshot;
  return question.status==='complete'&&Object.keys(question.fields).length?{revision:0,summary:question.summary,fields:question.fields,evidence:question.evidence}:null;
}
export function planningFacts(state,replacement){
  const answers={};
  for(const question of state.questions){
    const accepted=replacement?.questionId===question.id?replacement.snapshot:acceptedAnswer(question);
    if(accepted)answers[question.id]={revision:accepted.revision,summary:accepted.summary,fields:accepted.fields};
  }
  return {answers,resources:state.resources??''};
}
export function planningFactsHash(state,replacement){return sha256(JSON.stringify(canonical(planningFacts(state,replacement))))}
export function consistencyReady(state){
  const receipt=state.consistency;
  return Boolean(receipt&&receipt.version===CONSISTENCY_VERSION&&receipt.status==='consistent'&&receipt.epoch===(state.backgroundEpoch??0)&&Array.isArray(receipt.issues)&&receipt.issues.length===0&&receipt.factsHash===planningFactsHash(state));
}
export function validateConsistencyAssessment(value){
  if(!keys(value,['status','issues'])||!['consistent','requires_review'].includes(value.status)||!Array.isArray(value.issues)||value.issues.length>5||(value.status==='consistent')!==(value.issues.length===0))fail();
  const seen=new Set();
  for(const issue of value.issues){
    if(!keys(issue,['questionId','fields','kind','reason','suggestion'])||!questionIds.includes(issue.questionId)||seen.has(issue.questionId)||!['incompatible','uncertain'].includes(issue.kind)||!text(issue.reason,2000)||!Array.isArray(issue.fields)||!issue.fields.length||issue.fields.length>8||new Set(issue.fields).size!==issue.fields.length||issue.fields.some(field=>!QUESTION_FIELDS[issue.questionId].includes(field)))fail();
    seen.add(issue.questionId);
    if(issue.suggestion!==null){
      const suggestion=issue.suggestion;
      if(!keys(suggestion,['summary','fields'])||!text(suggestion.summary,2000)||!record(suggestion.fields)||!Object.keys(suggestion.fields).length||Object.keys(suggestion.fields).some(field=>!issue.fields.includes(field)||!text(suggestion.fields[field],2000)))fail();
    }
  }
  return value;
}

export function materializeAccepted(state){
  for(const question of state.questions){
    const accepted=acceptedAnswer(question);
    if(accepted&&!question.acceptedSnapshot)question.acceptedSnapshot=JSON.parse(JSON.stringify(accepted));
  }
  state.backgroundEpoch??=0;
}
export function dirtyConsistency(state){
  const anchor=state.consistency?.anchorQuestionId??null,question=state.questions.find(q=>q.id===anchor),revision=question?acceptedAnswer(question)?.revision??null:null;
  state.consistency={version:CONSISTENCY_VERSION,status:'dirty',epoch:state.backgroundEpoch??0,factsHash:planningFactsHash(state),issues:[],anchorQuestionId:anchor,anchorRevision:revision};
}
export function bumpBackground(state){
  if((state.backgroundEpoch??0)>=999_999)throw new Error('PLANNING_CONFLICT');
  state.backgroundEpoch=(state.backgroundEpoch??0)+1;
  for(const question of state.questions)if(question.status==='needs-review')question.status='complete';
  dirtyConsistency(state);
}
export function applyAssessment(state,assessment,requestId,anchorQuestionId=null){
  validateConsistencyAssessment(assessment);
  const epoch=state.backgroundEpoch??0,factsHash=planningFactsHash(state),issues=[];
  anchorQuestionId??=state.consistency?.anchorQuestionId??null;
  for(const [index,issue] of assessment.issues.entries()){
    const question=state.questions.find(q=>q.id===issue.questionId),accepted=acceptedAnswer(question);
    if(!accepted)fail();
    issues.push({...JSON.parse(JSON.stringify(issue)),id:`issue_${epoch}_${index+1}`,answerRevision:accepted.revision,sourceRequestId:requestId,anchorQuestionId});
  }
  for(const question of state.questions){
    if(issues.some(issue=>issue.questionId===question.id)&&['complete','needs-review'].includes(question.status))question.status='needs-review';
    else if(question.status==='needs-review')question.status='complete';
  }
  const anchor=state.questions.find(q=>q.id===anchorQuestionId),anchorRevision=anchor?acceptedAnswer(anchor)?.revision??null:null;
  state.consistency={version:CONSISTENCY_VERSION,status:assessment.status,epoch,factsHash,checkedRequestId:requestId,issues,anchorQuestionId,anchorRevision};
}
