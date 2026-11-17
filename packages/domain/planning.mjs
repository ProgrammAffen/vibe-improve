import {validateRoute,routeIssues,parseBoundedJSON,MAX_ROUTE_BYTES,MAX_ROUTE_NODES} from './route-validation.mjs';
import {targetShape,validatePlanningTarget,validatePlanningMentions} from './planning-references.mjs';
import {GENERATION_POLICY,validateGenerationDraft,generationDraftMatches,generationRouteHash,generationEqual} from './planning-generation-draft.mjs';
import {CONSISTENCY_VERSION,QUESTION_FIELDS,acceptedAnswer,planningFacts,planningFactsHash,consistencyReady,validateConsistencyAssessment,materializeAccepted,dirtyConsistency,bumpBackground,applyAssessment} from './planning-consistency.mjs';
import {DEFAULT_QUESTION_IDS,QUESTION_IDS,LEGACY_QUESTION_IDS} from './planning-questions.mjs';
import {materialKey,materialTargetExists,retainRouteMaterials,validMaterialLink,validResourceSnapshot,validRouteMaterials} from './route-materials.mjs';
export {DEFAULT_QUESTION_IDS,QUESTION_IDS,questionLabel,questionText,questionHelp,questionExample} from './planning-questions.mjs';
export {validatePlanningTarget} from './planning-references.mjs';
export {CONSISTENCY_VERSION,acceptedAnswer,planningFacts,planningFactsHash,consistencyReady} from './planning-consistency.mjs';

export const MAX_PLANNING_BYTES=8_388_608;
const providers=['codex','claude-code','codebuddy','qoder','openclaw','hermes'];
const fieldsByQuestion=QUESTION_FIELDS;
const fail=(code='PLANNING_INVALID')=>{throw new Error(code)};
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function sameRoute(first,second){return JSON.stringify(canonical(first))===JSON.stringify(canonical(second))}
export function assertStudiedRouteUnchanged(previousRoute, nextRoute, studiedNodeIds) {
  if (!previousRoute) return;
  const nodeIds = route => new Set(route.chapters.flatMap(chapter => chapter.nodes.map(node => node.id)));
  const previousIds = nodeIds(previousRoute);
  const protectedIds = new Set([...studiedNodeIds].filter(id => previousIds.has(id)));
  if (protectedIds.size === 0) return;
  const protectedChapters = route => route.chapters.flatMap(({id, title, stageGoal, nodes}) => {
    const lessons = nodes.filter(node => protectedIds.has(node.id));
    return lessons.length ? [{id, title, stageGoal, lessons}] : [];
  });
  const previousChapters = protectedChapters(previousRoute);
  if (nextRoute?.id !== previousRoute.id || !sameRoute(previousChapters, protectedChapters(nextRoute))) {
    fail('PLANNING_STUDIED_LESSON_LOCKED');
  }
  const nextIds = nodeIds(nextRoute);
  const prerequisites = previousChapters.flatMap(chapter => chapter.lessons.flatMap(lesson => lesson.prerequisites));
  if (prerequisites.some(id => previousIds.has(id) && !nextIds.has(id))) {
    fail('PLANNING_STUDIED_LESSON_LOCKED');
  }
}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed,required=allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const string=(value,max=2000,empty=false)=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&(empty||value.trim().length>0);
const integer=(value,min=0,max=999_999)=>Number.isInteger(value)&&value>=min&&value<=max;
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value);
const requestToken=value=>token(value)&&value.length<=64;
const project=value=>typeof value==='string'&&/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)&&Number.isFinite(Date.parse(value));
function bounded(value,max=MAX_PLANNING_BYTES){let text;try{text=JSON.stringify(value)}catch{fail()}if(typeof text!=='string'||text.length>max)fail('PLANNING_TOO_LARGE');let count=0;for(const c of text){const n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)fail();count+=n<128?1:n<2048?2:n<65536?3:4;if(count>max)fail('PLANNING_TOO_LARGE')}return value}
function expectRevision(state,expected){validatePlanning(state);if(expected!==state.revision)fail('PLANNING_CONFLICT');if(state.revision>=999_999)fail('PLANNING_CONFLICT')}
function progressed(state){retainRouteMaterials(state);state.revision++;return validatePlanning(bounded(state))}
function changed(state){delete state.confirmedRevision;return progressed(state)}
function idle(state){if(state.pending)fail('PLANNING_BUSY')}
function editorHistory(state){return clone(state.history??{past:state.undoRoute?[state.undoRoute]:[],future:[]})}
function keepHistory(state,history){
  while(history.past.length+history.future.length>20){if(history.past.length>1)history.past.shift();else history.future.shift()}
  while(true){try{bounded(history,2_097_152);break}catch(error){if(error.message!=='PLANNING_TOO_LARGE')throw error;if(history.past.length)history.past.shift();else if(history.future.length)history.future.shift();else throw error}}
  state.history=history;delete state.undoRoute;
}
function rememberRoute(state){const history=editorHistory(state);if(state.routeDraft)history.past.push(clone(state.routeDraft));history.future=[];keepHistory(state,history)}
function addMessage(state,message){
  if(state.messages.length>=128)fail('PLANNING_LIMIT');
  if(state.messages.some(item=>item.id===message.id))fail('PLANNING_CONFLICT');
  state.messages.push(message.role==='assistant'?{...message,provider:state.provider}:message);
}
function clearEditorConversation(state){
  const messages=state.messages,keep=message=>message.questionId!==undefined;
  for(const question of state.questions)if(question.conversationFrom!==undefined)question.conversationFrom=messages.slice(0,question.conversationFrom).filter(keep).length;
  state.messages=messages.filter(keep);
}
function pending(state,id,revision,kind){expectRevision(state,revision);if(!state.pending||state.pending.id!==id||state.pending.baseRevision!==revision||state.pending.kind!==kind)fail('PLANNING_CONFLICT')}
function evidenceShape(value){return string(value?.field,40)&&string(value?.quote,8000)&&(keys(value,['field','messageId','quote','proposalMessageId','reusedFrom'],['field','messageId','quote'])&&token(value.messageId)&&(!Object.hasOwn(value,'proposalMessageId')||token(value.proposalMessageId))&&(!Object.hasOwn(value,'reusedFrom')||DEFAULT_QUESTION_IDS.includes(value.reusedFrom)&&!Object.hasOwn(value,'proposalMessageId'))||keys(value,['field','acceptanceEventId','quote'])&&token(value.acceptanceEventId))}
function earlierIntakeUserMessages(state,id){
  const position=DEFAULT_QUESTION_IDS.indexOf(id);
  if(position<=0)return [];
  const sources=new Map(state.questions.filter(q=>q.status==='complete'&&DEFAULT_QUESTION_IDS.slice(0,position).includes(q.id)).map(q=>[q.id,q.conversationFrom??0]));
  const messages=state.messages.filter((message,index)=>message.role==='user'&&sources.has(message.questionId)&&index>=sources.get(message.questionId));
  const selected=new Set([...sources.keys()].map(questionId=>messages.find(message=>message.questionId===questionId)?.id).filter(Boolean));
  for(let index=messages.length-1;index>=0&&selected.size<8;index--)selected.add(messages[index].id);
  return messages.filter(message=>selected.has(message.id));
}
function baselineOptionsShape(options){
  return Array.isArray(options)&&options.length===3&&options.every(option=>string(option,80)&&option===option.trim()&&!/[\t-\r\u0085\u2028\u2029]/u.test(option))&&new Set(options).size===3;
}
function evidenceLinked(state,id,field,evidence,historical=false){
  if(!evidenceShape(evidence)||evidence.field!==field)return false;
  if(evidence.acceptanceEventId)return (state.answerEvents??[]).some(event=>event.id===evidence.acceptanceEventId&&event.questionId===id&&Object.hasOwn(event.fields,field));
  const index=state.messages.findIndex(message=>message.id===evidence.messageId),message=state.messages[index];
  if(evidence.reusedFrom){
    const target=DEFAULT_QUESTION_IDS.indexOf(id),source=DEFAULT_QUESTION_IDS.indexOf(evidence.reusedFrom);
    return source>=0&&source<target&&message?.role==='user'&&message.questionId===evidence.reusedFrom&&!!acceptedAnswer(state.questions.find(q=>q.id===evidence.reusedFrom));
  }
  const start=historical?0:state.questions.find(question=>question.id===id)?.conversationFrom??0;
  if(!message||message.role!=='user'||index<start)return false;
  if(!evidence.proposalMessageId)return true;
  return state.messages.slice(start,index).some(proposal=>proposal.id===evidence.proposalMessageId&&proposal.role==='assistant'&&proposal.questionId===id);
}
function interviewReferences(state,result){
  const normalized=clone(result),issues=[];
  const add=(path,code)=>{if(issues.length<24)issues.push({path,code})};
  for(const [index,update] of normalized.updates.entries()){
    const path=`updates.${index}`,question=state.questions.find(q=>q.id===update.id),start=question?.conversationFrom??0;
    if(update.id!==state.pending?.questionId){add(path+'.id','scope');continue}
    const reusable=new Set(earlierIntakeUserMessages(state,update.id).map(message=>message.id));
    for(const field of Object.keys(update.fields)){
      const matches=update.evidence.filter(e=>e.field===field);
      if(matches.length!==1)add(path+'.evidence',matches.length?'duplicate':'required');
    }
    for(const [evidenceIndex,evidence] of update.evidence.entries()){
      const base=path+`.evidence.${evidenceIndex}`;
      if(!Object.hasOwn(update.fields,evidence.field)){add(base+'.field','field');continue}
      const userIndex=state.messages.findIndex(m=>m.id===evidence.messageId),user=state.messages[userIndex];
      if(!user){add(base+'.messageId','reference');continue}
      if(user.role!=='user'){add(base+'.messageId','role');continue}
      if(evidence.reusedFrom){
        if(user.questionId!==evidence.reusedFrom||!reusable.has(user.id))add(base+'.messageId','scope');
        continue;
      }
      if(state.pending?.prefill||user.questionId!==update.id||userIndex<start){add(base+'.messageId','scope');continue}
      if(!evidence.proposalMessageId)continue;
      let proposalIndex=state.messages.findIndex(m=>m.id===evidence.proposalMessageId);
      if(proposalIndex<0){
        const canonical='assistant_'+evidence.proposalMessageId,candidateIndex=state.messages.findIndex(m=>m.id===canonical),candidate=state.messages[candidateIndex];
        proposalIndex=candidateIndex;
        if(candidate?.role==='assistant'&&candidate.questionId===update.id&&candidateIndex>=start&&candidateIndex<userIndex)evidence.proposalMessageId=canonical;
      }
      const proposal=state.messages[proposalIndex];
      if(!proposal)add(base+'.proposalMessageId','reference');
      else if(proposal.role!=='assistant')add(base+'.proposalMessageId','role');
      else if(proposalIndex<start||proposal.questionId!==update.id)add(base+'.proposalMessageId','scope');
      else if(proposalIndex>=userIndex)add(base+'.proposalMessageId','order');
    }
  }
  return {result:normalized,issues};
}
const isCoreQuestion=id=>DEFAULT_QUESTION_IDS.includes(id);
export function intakeQuestions(state){
  return state.questions.filter(q=>isCoreQuestion(q.id)||acceptedAnswer(q)||q.answerProposal||
    state.pending?.questionId===q.id||(state.currentQuestion===q.id&&q.conversationFrom!==undefined)||
    questionMessages(state,q.id).some(m=>m.role==='user'));
}
function firstIncomplete(state){
  return state.questions.find(q=>isCoreQuestion(q.id)&&!['complete','needs-review'].includes(q.status))?.id??null;
}
export function intakeCurrentQuestion(state){
  if(state.pending?.kind==='interview')return state.pending.questionId;
  return intakeQuestions(state).some(q=>q.id===state.currentQuestion)?state.currentQuestion:firstIncomplete(state);
}
export function canPrefillInterview(state){
  if(state.step!=='intake'||!state.provider||state.pending||state.consistency?.issues.length||state.messages.length>=126)return false;
  const id=state.currentQuestion,question=state.questions.find(q=>q.id===id);
  return id===firstIncomplete(state)&&question?.status==='current'&&!acceptedAnswer(question)&&!questionMessages(state,id).length&&earlierIntakeUserMessages(state,id).length>0;
}
function refreshCurrent(state){state.currentQuestion=firstIncomplete(state);for(const q of state.questions){if(!['complete','needs-detail','awaiting-confirmation','needs-review'].includes(q.status))q.status=q.id===state.currentQuestion?'current':'pending'}}
export function createPlanning(projectId,provider,locale,route){
  if(!project(projectId)||!(provider===null||providers.includes(provider))||!['zh-CN','en'].includes(locale))fail();
  const state={schemaVersion:1,projectId,revision:0,step:provider&&!route?'intake':'editor',provider,locale,currentQuestion:'goal',questions:DEFAULT_QUESTION_IDS.map((id,index)=>({id,status:index===0?'current':'pending',summary:'',fields:{},evidence:[],missing:[]})),messages:[],backgroundEpoch:0};
  if(route){state.importedOriginal=clone(validateRoute(route));state.routeDraft=upgradeRoute(route)}
  else if(!provider)state.routeDraft=emptyRoute(projectId,locale);
  dirtyConsistency(state);return validatePlanning(state);
}
function emptyRoute(projectId,locale){return{format:'vibe-improve.route',schemaVersion:2,id:'route_'+projectId.slice(5),revision:1,title:'',locale,sourceLanguage:locale,chapters:[]}}
export function upgradeRoute(route){
  validateRoute(route);const next=clone(route);next.schemaVersion=2;
  for(const chapter of next.chapters)if(route.schemaVersion===1)chapter.stageGoal='';
  return validateEditorDraft(next);
}
export function validateEditorDraft(route){
  bounded(route,MAX_ROUTE_BYTES);const value=clone(route);
  if(!record(value)||value.schemaVersion!==2||!Array.isArray(value.chapters))fail();
  if(value.chapters.length>24||value.chapters.reduce((count,c)=>count+(Array.isArray(c?.nodes)?c.nodes.length:0),0)>MAX_ROUTE_NODES)fail();
  const fill=(obj,key)=>{if(typeof obj[key]==='string'&&!obj[key].trim())obj[key]='Draft'};
  fill(value,'title');
  if(value.chapters.length===0)value.chapters=[{id:'DraftChapter',title:'Draft',stageGoal:'Draft',nodes:[]}];
  const used=new Set(value.chapters.flatMap(c=>Array.isArray(c?.nodes)?c.nodes.map(n=>n?.id):[]));let serial=0;
  for(const chapter of value.chapters){
    if(!record(chapter)||!Array.isArray(chapter.nodes))fail();fill(chapter,'title');fill(chapter,'stageGoal');
    if(chapter.nodes.length===0){let id;do{id='DraftNode'+serial++}while(used.has(id));used.add(id);chapter.nodes=[{id,title:'Draft',objectives:[{id:'draftObjective',description:'Draft'}],prerequisites:[],estimatedMinutes:1}]}
    for(const node of chapter.nodes){
      if(!record(node)||!Array.isArray(node.objectives))fail();fill(node,'title');
      if(node.objectives.length===0)node.objectives=[{id:'draftObjective',description:'Draft'}];
      for(const objective of node.objectives)if(record(objective))fill(objective,'description');
      if(node.assessment&&record(node.assessment)){
        fill(node.assessment,'task');if(Array.isArray(node.assessment.passCriteria)){if(node.assessment.passCriteria.length===0)node.assessment.passCriteria=['Draft'];else node.assessment.passCriteria=node.assessment.passCriteria.map(c=>typeof c==='string'&&!c.trim()?'Draft':c)}
        if(node.assessment.mode==='qualitative')fill(node.assessment,'evaluatorPrompt');
      }
      if(Array.isArray(node.activities))node.activities=node.activities.map(c=>typeof c==='string'&&!c.trim()?'Draft':c);
    }
  }
  try{validateRoute(value)}catch{fail('PLANNING_ROUTE_INVALID')}
  return route;
}
function snapshotValid(state,id,snapshot){
  if(!keys(snapshot,['revision','summary','fields','evidence'])||!integer(snapshot.revision)||!string(snapshot.summary,2000,snapshot.revision===0)||!record(snapshot.fields)||!Object.keys(snapshot.fields).length||Object.keys(snapshot.fields).length>8||Object.keys(snapshot.fields).some(field=>!fieldsByQuestion[id].includes(field)||!string(snapshot.fields[field]))||!Array.isArray(snapshot.evidence)||snapshot.evidence.length>8)return false;
  return snapshot.evidence.every(e=>evidenceShape(e)&&Object.hasOwn(snapshot.fields,e.field)&&evidenceLinked(state,id,e.field,e,true)&&(!e.acceptanceEventId||(state.answerEvents??[]).find(event=>event.id===e.acceptanceEventId)?.fields[e.field]===snapshot.fields[e.field]))&&Object.keys(snapshot.fields).every(field=>snapshot.evidence.filter(e=>e.field===field).length===1);
}
function validateReceipt(state){
  const receipt=state.consistency;if(receipt===undefined)return;
  if(!keys(receipt,['version','status','epoch','factsHash','issues','checkedRequestId','anchorQuestionId','anchorRevision'],['version','status','epoch','factsHash','issues'])||!string(receipt.version,80)||!/^answer-consistency\.v[0-9]+$/.test(receipt.version)||!['dirty','consistent','requires_review'].includes(receipt.status)||!integer(receipt.epoch)||receipt.epoch!==(state.backgroundEpoch??0)||typeof receipt.factsHash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.factsHash)||!Array.isArray(receipt.issues)||receipt.issues.length>QUESTION_IDS.length||receipt.checkedRequestId!==undefined&&!requestToken(receipt.checkedRequestId)||(receipt.status!=='dirty'&&!requestToken(receipt.checkedRequestId)))fail();
  if(receipt.anchorQuestionId!==undefined&&receipt.anchorQuestionId!==null&&!QUESTION_IDS.includes(receipt.anchorQuestionId)||receipt.anchorRevision!==undefined&&receipt.anchorRevision!==null&&!integer(receipt.anchorRevision))fail();
  if(receipt.anchorQuestionId!==undefined){const anchor=state.questions.find(q=>q.id===receipt.anchorQuestionId);if(receipt.anchorQuestionId===null?receipt.anchorRevision!==undefined&&receipt.anchorRevision!==null:!anchor||acceptedAnswer(anchor)?.revision!==receipt.anchorRevision)fail()}
  const issues=receipt.issues.map(issue=>{if(!keys(issue,['id','questionId','fields','kind','reason','suggestion','answerRevision','sourceRequestId','anchorQuestionId'])||!token(issue.id)||!integer(issue.answerRevision)||!requestToken(issue.sourceRequestId)||!(issue.anchorQuestionId===null||QUESTION_IDS.includes(issue.anchorQuestionId)))fail();const accepted=acceptedAnswer(state.questions.find(q=>q.id===issue.questionId)??{});if(!accepted||accepted.revision!==issue.answerRevision)fail();return {questionId:issue.questionId,fields:issue.fields,kind:issue.kind,reason:issue.reason,suggestion:issue.suggestion}});
  try{validateConsistencyAssessment({status:receipt.status==='dirty'?'consistent':receipt.status,issues})}catch{fail()}
  if(new Set(receipt.issues.map(issue=>issue.id)).size!==receipt.issues.length)fail();
  if(receipt.version===CONSISTENCY_VERSION&&receipt.factsHash!==planningFactsHash(state))fail();
}
export function validatePlanning(value){
  bounded(value);
  if(!keys(value,['schemaVersion','projectId','revision','step','provider','agentChoice','locale','currentQuestion','questions','messages','routeDraft','importedOriginal','confirmedRevision','pending','proposal','undoRoute','history','agentOptions','intakeChanged','resources','backgroundEpoch','consistency','answerEvents','generationDraft','resourceSnapshot','routeMaterials'],['schemaVersion','projectId','revision','step','provider','locale','currentQuestion','questions','messages']))fail();
  if(value.agentChoice!==undefined&&value.agentChoice!=='manual'&&!providers.includes(value.agentChoice))fail();
  if(value.resourceSnapshot!==undefined&&!validResourceSnapshot(value.resourceSnapshot)||value.routeMaterials!==undefined&&!validRouteMaterials(value.routeMaterials))fail();
  if(value.generationDraft!==undefined){bounded(value.generationDraft,2_097_152);validateGenerationDraft(value.generationDraft)}
  if(value.backgroundEpoch!==undefined&&!integer(value.backgroundEpoch))fail();
  if(value.resources!==undefined&&!string(value.resources,4000,true))fail();
  if(value.intakeChanged!==undefined&&typeof value.intakeChanged!=='boolean')fail();
  if(value.schemaVersion!==1||!project(value.projectId)||!integer(value.revision)||!['intake','editor'].includes(value.step)||!(value.provider===null||providers.includes(value.provider))||!['zh-CN','en'].includes(value.locale)||!(value.currentQuestion===null||QUESTION_IDS.includes(value.currentQuestion)))fail();
  if(!Array.isArray(value.messages)||value.messages.length>128||!Array.isArray(value.questions))fail();
  const expectedQuestions=[DEFAULT_QUESTION_IDS,LEGACY_QUESTION_IDS,QUESTION_IDS].find(ids=>ids.length===value.questions.length);
  if(!expectedQuestions)fail();
  if(value.currentQuestion!==null&&!value.questions.some(question=>question?.id===value.currentQuestion))fail();
  if(value.answerEvents!==undefined){
    if(!Array.isArray(value.answerEvents)||value.answerEvents.length>256)fail();const seen=new Set();
    for(const event of value.answerEvents){if(!keys(event,['id','kind','questionId','answerRevision','epoch','summary','fields','createdAt','issueId','sourceRequestId'],['id','kind','questionId','answerRevision','epoch','summary','fields','createdAt'])||!token(event.id)||seen.has(event.id)||event.kind!=='suggestion'||!QUESTION_IDS.includes(event.questionId)||!integer(event.answerRevision)||!integer(event.epoch)||event.epoch>(value.backgroundEpoch??0)||!string(event.summary,2000)||!record(event.fields)||!Object.keys(event.fields).length||Object.keys(event.fields).some(field=>!fieldsByQuestion[event.questionId].includes(field)||!string(event.fields[field]))||!date(event.createdAt)||event.issueId!==undefined&&!token(event.issueId)||event.sourceRequestId!==undefined&&!requestToken(event.sourceRequestId))fail();seen.add(event.id)}
  }
  const ids=new Set();
  for(const message of value.messages){
    if(!keys(message,['id','role','text','createdAt','questionId','target','mentions','provider','attachments'],['id','role','text','createdAt'])||!token(message.id)||ids.has(message.id)||!['user','assistant'].includes(message.role)||!string(message.text,8000)||!date(message.createdAt)||(message.questionId!==undefined&&!QUESTION_IDS.includes(message.questionId))||(message.target!==undefined&&(message.role!=='user'||message.questionId!==undefined||message.mentions!==undefined||!targetShape(message.target))))fail();
    if(message.provider!==undefined&&(message.role!=='assistant'||(message.provider!==null&&!providers.includes(message.provider))))fail();
    if(message.mentions!==undefined){if(message.role!=='user'||message.questionId!==undefined)fail();validatePlanningMentions(undefined,message.text,message.mentions,false)}
    if(message.attachments!==undefined&&(message.role!=='user'||!validPlanningAttachments(message.attachments)))fail();
    ids.add(message.id);
  }
  for(let index=0;index<value.questions.length;index++){
    const q=value.questions[index];
    if(!keys(q,['id','status','summary','fields','evidence','missing','answerProposal','conversationFrom','acceptedSnapshot','baselineOptions'],['id','status','summary','fields','evidence','missing'])||q.id!==expectedQuestions[index]||!['pending','current','needs-detail','awaiting-confirmation','complete','needs-review'].includes(q.status)||!string(q.summary,2000,true)||!record(q.fields)||Object.keys(q.fields).length>8||Object.keys(q.fields).some(field=>!fieldsByQuestion[q.id].includes(field)||!string(q.fields[field]))||!Array.isArray(q.evidence)||q.evidence.length>8||!Array.isArray(q.missing)||q.missing.length>12||q.missing.some(item=>!string(item,400)))fail();
    if(q.baselineOptions!==undefined&&(q.id!=='baseline'||q.status!=='needs-detail'||q.fields.experience!==undefined||!baselineOptionsShape(q.baselineOptions)))fail();
    if(q.conversationFrom!==undefined&&!integer(q.conversationFrom,0,value.messages.length))fail();
    if(q.acceptedSnapshot&&!snapshotValid(value,q.id,q.acceptedSnapshot))fail();
    if(q.answerProposal){const p=q.answerProposal,m=value.messages.find(m=>m.id===p.messageId);if(!keys(p,['summary','messageId','consistency'],['summary','messageId'])||!string(p.summary,2000)||!m||m.role!=='assistant'||m.questionId!==q.id||q.status!=='awaiting-confirmation')fail();if(p.consistency){const c=p.consistency;if(!keys(c,['version','baseEpoch','proposedFactsHash','assessment'])||!string(c.version,80)||!integer(c.baseEpoch)||typeof c.proposedFactsHash!=='string'||!/^[a-f0-9]{64}$/.test(c.proposedFactsHash))fail();try{validateConsistencyAssessment(c.assessment)}catch{fail()}}}
    if(q.status==='awaiting-confirmation'&&(!q.answerProposal||q.missing.length||!Object.keys(q.fields).length))fail();
    if(q.evidence.some(e=>!evidenceShape(e)||!Object.hasOwn(q.fields,e.field)||!evidenceLinked(value,q.id,e.field,e,['complete','needs-review'].includes(q.status))||e.acceptanceEventId&&(value.answerEvents??[]).find(event=>event.id===e.acceptanceEventId)?.fields[e.field]!==q.fields[e.field]))fail();
    if(Object.keys(q.fields).some(field=>q.evidence.filter(e=>e.field===field).length!==1))fail();
    if(['complete','needs-review'].includes(q.status)&&(q.missing.length||Object.keys(q.fields).length===0||q.acceptedSnapshot&&(!sameRoute(q.fields,q.acceptedSnapshot.fields)||q.summary!==q.acceptedSnapshot.summary||!sameRoute(q.evidence,q.acceptedSnapshot.evidence))))fail();
    if(q.status==='needs-review'&&!q.acceptedSnapshot)fail();
  }
  validateReceipt(value);
  if(Object.hasOwn(value,'agentOptions')&&(!value.provider||!keys(value.agentOptions,['model','effort'])||!(value.agentOptions.model===null||typeof value.agentOptions.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.agentOptions.model))||!(value.agentOptions.effort===null||['none','minimal','low','medium','high','xhigh','max'].includes(value.agentOptions.effort))))fail();
  if(value.routeDraft)validateEditorDraft(value.routeDraft);
  if(value.importedOriginal)validateRoute(value.importedOriginal);
  if(value.undoRoute)validateEditorDraft(value.undoRoute);
  if(value.history){const h=value.history;if(!keys(h,['past','future'])||!Array.isArray(h.past)||!Array.isArray(h.future)||h.past.length+h.future.length>20)fail();bounded(h,2_097_152);for(const route of [...h.past,...h.future])validateEditorDraft(route)}
  if(value.step==='editor'&&!value.routeDraft)fail();
  if(value.confirmedRevision!==undefined){if(!integer(value.confirmedRevision,1,1_000_000)||!value.routeDraft||value.routeDraft.revision!==value.confirmedRevision)fail();try{validateRoute(value.routeDraft)}catch{fail()}}
  if(value.pending&&(!keys(value.pending,['id','kind','baseRevision','questionId','backgroundEpoch','factsHash','prefill'],['id','kind','baseRevision','questionId'])||!requestToken(value.pending.id)||!['interview','generate','edit','consistency'].includes(value.pending.kind)||value.pending.baseRevision!==value.revision||!(value.pending.questionId===null||QUESTION_IDS.includes(value.pending.questionId))||(value.pending.kind==='edit')!==(value.step==='editor')||(value.pending.kind==='interview')!==(value.pending.questionId!==null)||value.pending.prefill!==undefined&&(value.pending.prefill!==true||value.pending.kind!=='interview')||value.pending.backgroundEpoch!==undefined&&!integer(value.pending.backgroundEpoch)||value.pending.factsHash!==undefined&&(typeof value.pending.factsHash!=='string'||!/^[a-f0-9]{64}$/.test(value.pending.factsHash))))fail();
  if(value.proposal){const p=value.proposal;if(!keys(p,['route','reply','baseRevision','routeRevision'])||!string(p.reply,8000)||!integer(p.baseRevision)||p.baseRevision>value.revision||!integer(p.routeRevision,1,1_000_000)||!value.routeDraft||p.routeRevision!==value.routeDraft.revision||p.route?.id!==value.routeDraft.id)fail();try{validateRoute(p.route)}catch{fail()}if(p.route.schemaVersion!==2)fail()}
  return value;
}
export function parseInterviewResult(text){
  let result;try{result=parseBoundedJSON(text)}catch{fail('PLANNING_RESPONSE_INVALID')}
  return validateInterviewResult(result);
}
function validateInterviewResult(result){
  bounded(result,MAX_ROUTE_BYTES);
  if(!keys(result,['reply','updates','summary','consistency','baselineOptions'],['reply','updates'])||!string(result.reply,8000)||(result.summary!==undefined&&!string(result.summary,2000,true))||(result.baselineOptions!==undefined&&!baselineOptionsShape(result.baselineOptions))||!Array.isArray(result.updates)||result.updates.length>QUESTION_IDS.length)fail('PLANNING_RESPONSE_INVALID');
  if(result.consistency!==undefined)validateConsistencyAssessment(result.consistency);
  const seen=new Set();
  for(const update of result.updates){
    if(!keys(update,['id','fields','evidence','missing','complete'])||!QUESTION_IDS.includes(update.id)||seen.has(update.id)||typeof update.complete!=='boolean'||!record(update.fields)||Object.keys(update.fields).length>8||Object.keys(update.fields).some(field=>!fieldsByQuestion[update.id].includes(field)||!string(update.fields[field]))||!Array.isArray(update.evidence)||update.evidence.length>8||update.evidence.some(e=>!evidenceShape(e))||!Array.isArray(update.missing)||update.missing.length>12||update.missing.some(item=>!string(item,400))||(update.complete&&update.missing.length))fail('PLANNING_RESPONSE_INVALID');seen.add(update.id);
  }
  return result;
}
export function canRequestGeneration(state){validatePlanning(state);return state.step==='intake'&&state.provider!==null&&!state.pending&&state.questions.every(q=>!isCoreQuestion(q.id)||q.status==='complete')&&!(state.consistency?.issues.length)}
export function canGenerate(state){return canRequestGeneration(state)&&consistencyReady(state)}
export function needsConsistencyCheck(state){return canRequestGeneration(state)&&!consistencyReady(state)}
export function beginInterviewPrefill(state,requestId,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);
  if(!canPrefillInterview(state)||!requestToken(requestId))fail('PLANNING_INCOMPLETE');
  if(state.revision>=999_998)fail('PLANNING_CONFLICT');
  const next=clone(state);materializeAccepted(next);
  next.revision++;
  next.pending={id:requestId,kind:'interview',baseRevision:next.revision,questionId:next.currentQuestion,backgroundEpoch:next.backgroundEpoch,factsHash:planningFactsHash(next),prefill:true};
  return validatePlanning(next);
}
export function validPlanningAttachments(value){
  return Array.isArray(value)&&value.length>=1&&value.every(ref=>
    keys(ref,['id','name','kind'])&&typeof ref.id==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.id)&&
    string(ref.name,240)&&['image','document'].includes(ref.kind))&&new Set(value.map(ref=>ref.id)).size===value.length;
}

export function appendUser(state,text,messageId,requestId,expectedRevision,now=new Date().toISOString(),target,mentions,attachments){
  expectRevision(state,expectedRevision);idle(state);if(!state.provider||!string(text,8000)||!token(messageId)||!requestToken(requestId)||!date(now))fail();
  if(target!=null){if(state.step!=='editor'||mentions!=null)fail('PLANNING_TARGET_UNAVAILABLE');validatePlanningTarget(state.routeDraft,target)}
  if(mentions!=null){if(state.step!=='editor')fail('PLANNING_TARGET_UNAVAILABLE');validatePlanningMentions(state.routeDraft,text,mentions)}
  if(attachments!==undefined&&!validPlanningAttachments(attachments))fail();
  const last=state.messages.at(-1),retry=state.step==='editor'&&last?.role==='user'&&!last.questionId&&last.text===text.trim()&&sameRoute(last.target??null,target??null)&&sameRoute(last.mentions??[],mentions??[])&&sameRoute(last.attachments??[],attachments??[]);
  if(state.messages.length>=(retry?128:127))fail('PLANNING_LIMIT');if(state.revision>=999_998)fail('PLANNING_CONFLICT');
  const next=clone(state),questionId=next.step==='intake'?intakeCurrentQuestion(next):null;materializeAccepted(next);
  if(next.step==='intake'){const q=next.questions.find(q=>q.id===questionId);if(!q||q.status==='complete')fail('PLANNING_INCOMPLETE');next.currentQuestion=q.id;delete q.answerProposal;delete q.baselineOptions;q.status='current';if(next.routeDraft?.chapters.length)next.intakeChanged=true;}
  if(!retry)addMessage(next,{id:messageId,role:'user',text:text.trim(),createdAt:now,...(next.step==='intake'?{questionId}:target?{target:clone(target)}:mentions?.length?{mentions:clone(mentions)}:{}),...(attachments?{attachments:clone(attachments)}:{})});
  next.revision++;next.pending={id:requestId,kind:next.step==='editor'?'edit':'interview',baseRevision:next.revision,questionId:next.step==='intake'?questionId:null,...(next.step==='intake'?{backgroundEpoch:next.backgroundEpoch,factsHash:planningFactsHash(next)}:{})};
  return validatePlanning(bounded(next));
}
export function applyInterview(state,result,requestId,baseRevision,now=new Date().toISOString()){
  pending(state,requestId,baseRevision,'interview');validateInterviewResult(result);if(!date(now))fail();
  if(state.pending.backgroundEpoch!==undefined&&(state.pending.backgroundEpoch!==(state.backgroundEpoch??0)||state.pending.factsHash!==planningFactsHash(state)))fail('PLANNING_CONFLICT');
  if(!result.updates.length||result.updates.some(update=>update.id!==state.pending.questionId))fail('PLANNING_RESPONSE_INVALID');
  if(state.pending.prefill&&result.consistency?.issues.length)fail('PLANNING_RESPONSE_INVALID');
  const references=interviewReferences(state,result);if(references.issues.length)fail('PLANNING_EVIDENCE_INVALID');result=references.result;
  const next=clone(state);materializeAccepted(next);
  if(!result.updates.some(update=>update.id===state.pending.questionId))fail('PLANNING_RESPONSE_INVALID');
  for(const update of result.updates){
    if(update.id!==state.pending.questionId)fail('PLANNING_RESPONSE_INVALID');
    const q=next.questions.find(item=>item.id===update.id);
    const seen=new Set();
    for(const field of Object.keys(update.fields)){
      const matches=update.evidence.filter(e=>e.field===field);
      if(matches.length!==1||!evidenceLinked(state,update.id,field,matches[0]))fail('PLANNING_EVIDENCE_INVALID');
      q.fields[field]=update.fields[field];q.evidence=q.evidence.filter(e=>e.field!==field);q.evidence.push(clone(matches[0]));seen.add(field);
    }
    if(update.evidence.some(e=>!seen.has(e.field)))fail('PLANNING_EVIDENCE_INVALID');
    q.missing=clone(update.missing);q.summary=Array.from(Object.values(q.fields).join(' · ')).slice(0,600).join('');
    if(update.complete&&Object.keys(q.fields).length===0)fail('PLANNING_RESPONSE_INVALID');
    q.status=update.complete?'awaiting-confirmation':'needs-detail';delete q.answerProposal;
    if(result.baselineOptions!==undefined){
      if(!state.pending.prefill||q.id!=='baseline'||update.complete||q.fields.experience!==undefined)fail('PLANNING_RESPONSE_INVALID');
      q.baselineOptions=clone(result.baselineOptions);
    }
    if(update.complete){
      q.answerProposal={summary:result.summary?.trim()||q.summary,messageId:'assistant_'+requestId};
      if(result.consistency){
        const snapshot={revision:(q.acceptedSnapshot?.revision??0)+1,summary:q.answerProposal.summary,fields:q.fields,evidence:q.evidence};
        for(const issue of result.consistency.issues)if(issue.questionId!==q.id&&!acceptedAnswer(next.questions.find(other=>other.id===issue.questionId)))fail('PLANNING_RESPONSE_INVALID');
        q.answerProposal.consistency={version:CONSISTENCY_VERSION,baseEpoch:next.backgroundEpoch,proposedFactsHash:planningFactsHash(next,{questionId:q.id,snapshot}),assessment:clone(result.consistency)};
      }
    }
  }
  addMessage(next,{id:'assistant_'+requestId,role:'assistant',text:result.reply,createdAt:now,questionId:state.pending.questionId??'goal'});
  delete next.pending;return changed(next);
}
export function agentInterviewDiagnostics(state,result){
  validatePlanning(state);validateInterviewResult(result);
  return {issues:interviewReferences(state,result).issues};
}
export function answerConfirmation(state,id){
  validatePlanning(state);
  const position=state.questions.findIndex(question=>question.id===id),question=state.questions[position],proposal=question?.answerProposal;
  if(!proposal)return null;
  const check=proposal.consistency,snapshot={revision:(acceptedAnswer(question)?.revision??0)+1,summary:proposal.summary,fields:question.fields,evidence:question.evidence};
  const result={kind:'confirm',canAccept:true,issues:clone(check?.assessment.issues??[]),changes:[]};
  if(check&&(check.version!==CONSISTENCY_VERSION||check.baseEpoch!==(state.backgroundEpoch??0)||check.proposedFactsHash!==planningFactsHash(state,{questionId:id,snapshot})))return {...result,kind:'stale',canAccept:false};
  if(!check&&state.consistency?.issues.length)return {...result,kind:'clarify',canAccept:false,issues:clone(state.consistency.issues)};
  if(!result.issues.length)return result;
  for(const issue of result.issues){
    const targetPosition=state.questions.findIndex(item=>item.id===issue.questionId),target=state.questions[targetPosition],before=acceptedAnswer(target),suggestion=issue.suggestion;
    if(issue.kind!=='incompatible'||!before||targetPosition>=position||!['complete','needs-review'].includes(target.status)||!suggestion||issue.fields.some(field=>!Object.hasOwn(suggestion.fields,field))||!Object.keys(suggestion.fields).some(field=>suggestion.fields[field]!==before.fields[field]))return {...result,kind:'clarify',canAccept:false,changes:[]};
    result.changes.push({questionId:issue.questionId,before:clone(before),after:{summary:suggestion.summary,fields:{...clone(before.fields),...clone(suggestion.fields)}},reason:issue.reason});
  }
  return {...result,kind:'update'};
}
export function acceptAnswer(state,id,messageId,expectedRevision,now=new Date().toISOString()){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='intake'||!date(now))fail();const q=state.questions.find(q=>q.id===id);
  if(!q?.answerProposal||q.answerProposal.messageId!==messageId)fail('PLANNING_CONFLICT');
  const confirmation=answerConfirmation(state,id);
  if(confirmation.kind==='stale')fail('PLANNING_CONFLICT');
  if(!confirmation.canAccept)fail('PLANNING_INCOMPLETE');
  if((state.answerEvents?.length??0)+confirmation.changes.length>256)fail('PLANNING_LIMIT');
  const next=clone(state);materializeAccepted(next);const question=next.questions.find(q=>q.id===id),proposal=question.answerProposal;
  const snapshot={revision:(question.acceptedSnapshot?.revision??0)+1,summary:proposal.summary,fields:clone(question.fields),evidence:clone(question.evidence)};
  if(snapshot.revision>999_999||confirmation.changes.some(change=>change.before.revision>=999_999))fail('PLANNING_CONFLICT');
  question.summary=snapshot.summary;question.status='complete';question.acceptedSnapshot=snapshot;delete question.answerProposal;
  bumpBackground(next);next.consistency.anchorQuestionId=id;next.consistency.anchorRevision=snapshot.revision;
  const requestId=proposal.messageId.slice('assistant_'.length);
  if(confirmation.kind==='update'){
    next.answerEvents??=[];
    for(const [index,change] of confirmation.changes.entries()){
      const target=next.questions.find(item=>item.id===change.questionId),issue=confirmation.issues[index],fields=clone(issue.suggestion.fields),eventId=`adopt_${next.backgroundEpoch}_${requestId}_${index+1}`;
      const event={id:eventId,kind:'suggestion',questionId:target.id,answerRevision:change.before.revision+1,epoch:next.backgroundEpoch,summary:change.after.summary,fields,createdAt:now,issueId:`candidate_${requestId}_${index+1}`,sourceRequestId:requestId};
      next.answerEvents.push(event);
      const evidence=change.before.evidence.filter(item=>!Object.hasOwn(fields,item.field));
      for(const field of Object.keys(fields))evidence.push({field,acceptanceEventId:eventId,quote:next.locale==='en'?'The user explicitly confirmed this related answer adjustment.':'用户明确确认了本条关联回答调整。'});
      target.acceptedSnapshot={revision:event.answerRevision,summary:change.after.summary,fields:clone(change.after.fields),evidence};
      Object.assign(target,{summary:change.after.summary,fields:clone(change.after.fields),evidence:clone(evidence),missing:[],status:'complete'});delete target.answerProposal;
    }
    dirtyConsistency(next);
  }else if(proposal.consistency)applyAssessment(next,proposal.consistency.assessment,requestId,id);
  if(next.routeDraft?.chapters.length)next.intakeChanged=true;
  refreshCurrent(next);return changed(next);
}
export function reanswerQuestion(state,id,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='intake'||!state.questions.some(question=>question.id===id))fail();
  const next=clone(state);materializeAccepted(next);const q=next.questions.find(q=>q.id===id);Object.assign(q,{status:'current',summary:'',fields:{},evidence:[],missing:[],conversationFrom:next.messages.length});delete q.answerProposal;delete q.baselineOptions;next.currentQuestion=id;
  if(next.routeDraft?.chapters.length)next.intakeChanged=true;return changed(next);
}
export function restartIntake(state,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='intake'||!state.provider)fail('PLANNING_INCOMPLETE');
  const next=clone(state);
  next.questions=DEFAULT_QUESTION_IDS.map((id,index)=>({id,status:index===0?'current':'pending',summary:'',fields:{},evidence:[],missing:[]}));
  next.messages=next.messages.filter(message=>!message.questionId);
  next.currentQuestion='goal';delete next.answerEvents;delete next.resources;delete next.consistency;delete next.proposal;
  bumpBackground(next);if(next.routeDraft?.chapters.length)next.intakeChanged=true;
  return changed(next);
}
export function restartIntakeFrom(state,id,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);const index=state.questions.findIndex(question=>question.id===id);
  if(state.step!=='intake'||!state.provider||index<0)fail('PLANNING_INCOMPLETE');
  const next=clone(state);materializeAccepted(next);
  const cleared=new Set(state.questions.slice(index).map(question=>question.id)),keep=message=>!cleared.has(message.questionId),oldMessages=next.messages;
  const prefixStatuses=next.questions.slice(0,index).map(question=>question.status),receipt=next.consistency;
  const remaining=clone(receipt?.issues.filter(issue=>!cleared.has(issue.questionId))??[]);
  for(let position=0;position<index;position++){
    const question=next.questions[position];
    if(question.conversationFrom!==undefined)question.conversationFrom=oldMessages.slice(0,question.conversationFrom).filter(keep).length;
    if(question.answerProposal)delete question.answerProposal.consistency;
  }
  next.questions=next.questions.map((question,position)=>position<index?question:{id:question.id,status:position===index?'current':'pending',summary:'',fields:{},evidence:[],missing:[]});
  next.messages=oldMessages.filter(keep);next.currentQuestion=id;
  if(!isCoreQuestion(id))next.questions[index].conversationFrom=next.messages.length;
  if(next.answerEvents)next.answerEvents=next.answerEvents.filter(event=>!cleared.has(event.questionId));
  delete next.consistency;delete next.proposal;bumpBackground(next);
  if(receipt?.anchorQuestionId&&!cleared.has(receipt.anchorQuestionId)){next.consistency.anchorQuestionId=receipt.anchorQuestionId;next.consistency.anchorRevision=receipt.anchorRevision}
  for(let position=0;position<index;position++)next.questions[position].status=prefixStatuses[position];
  if(remaining.length)next.consistency={...next.consistency,status:'requires_review',issues:remaining.map(issue=>({...issue,anchorQuestionId:cleared.has(issue.anchorQuestionId)?null:issue.anchorQuestionId})),checkedRequestId:receipt.checkedRequestId};
  if(next.routeDraft?.chapters.length)next.intakeChanged=true;
  return changed(next);
}
export function questionMessages(state,id){const q=state.questions.find(q=>q.id===id);return state.messages.slice(q?.conversationFrom??0).filter(message=>message.questionId===id)}
export function cancelAnswerDraft(state,id,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='intake')fail();const next=clone(state);materializeAccepted(next);const q=next.questions.find(q=>q.id===id),accepted=q?.acceptedSnapshot;if(!q||!accepted)fail('PLANNING_INCOMPLETE');
  Object.assign(q,{fields:clone(accepted.fields),summary:accepted.summary,evidence:clone(accepted.evidence),missing:[],status:next.consistency?.issues.some(issue=>issue.questionId===id)?'needs-review':'complete'});delete q.answerProposal;refreshCurrent(next);return progressed(next);
}
export function setResources(state,text,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(!string(text,4000,true))fail();if((state.resources??'')===text.trim())return state;
  const next=clone(state);materializeAccepted(next);
  const statuses=next.questions.map(question=>question.status),unresolved=clone(next.consistency?.issues??[]),checkedRequestId=next.consistency?.checkedRequestId;
  next.resources=text.trim();bumpBackground(next);
  // New resources invalidate the receipt, but are not an adoption or an
  // assessment resolving any already-known cross-answer issue.
  for(const [index,question] of next.questions.entries())question.status=statuses[index];
  if(unresolved.length)next.consistency={...next.consistency,status:'requires_review',issues:unresolved,checkedRequestId};
  if(next.routeDraft?.chapters.length)next.intakeChanged=true;return changed(next);
}
export function needsGenerationReplacement(state){return Boolean(state.routeDraft?.chapters.length&&state.intakeChanged)}
export function beginConsistencyCheck(state,requestId,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(!canRequestGeneration(state)||!requestToken(requestId))fail('PLANNING_INCOMPLETE');
  if(state.revision>=999_998)fail('PLANNING_CONFLICT');const next=clone(state);materializeAccepted(next);
  next.revision++;next.pending={id:requestId,kind:'consistency',baseRevision:next.revision,questionId:null,backgroundEpoch:next.backgroundEpoch,factsHash:planningFactsHash(next)};return validatePlanning(next);
}
export function applyConsistencyCheck(state,result,requestId,baseRevision,now=new Date().toISOString()){
  const kind=state.pending?.kind;if(!['consistency','generate'].includes(kind))fail('PLANNING_CONFLICT');pending(state,requestId,baseRevision,kind);
  if(!keys(result,['reply','consistency'])||!string(result.reply,8000)||!date(now))fail('PLANNING_RESPONSE_INVALID');validateConsistencyAssessment(result.consistency);
  if(kind==='generate'&&result.consistency.status!=='requires_review')fail('PLANNING_RESPONSE_INVALID');
  if(state.pending.backgroundEpoch!==(state.backgroundEpoch??0)||state.pending.factsHash!==planningFactsHash(state))fail('PLANNING_CONFLICT');
  const next=clone(state);materializeAccepted(next);applyAssessment(next,result.consistency,requestId);delete next.pending;return progressed(next);
}
export function acceptConsistencySuggestion(state,issueId,expectedRevision,now=new Date().toISOString()){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='intake'||!token(issueId)||!date(now))fail();
  const issue=state.consistency?.issues.find(item=>item.id===issueId),question=state.questions.find(q=>q.id===issue?.questionId),accepted=question&&acceptedAnswer(question);
  if(!issue||!issue.suggestion||!accepted||question.status!=='needs-review'||accepted.revision!==issue.answerRevision)fail('PLANNING_CONFLICT');
  if((state.answerEvents?.length??0)>=256)fail('PLANNING_LIMIT');if(accepted.revision>=999_999)fail('PLANNING_CONFLICT');
  const next=clone(state);materializeAccepted(next);const q=next.questions.find(item=>item.id===issue.questionId),before=q.acceptedSnapshot,remaining=clone(state.consistency.issues.filter(item=>item.id!==issueId));
  const snapshot={revision:before.revision+1,summary:issue.suggestion.summary,fields:{...before.fields,...clone(issue.suggestion.fields)},evidence:before.evidence.filter(e=>!Object.hasOwn(issue.suggestion.fields,e.field))};
  bumpBackground(next);const eventId=`adopt_${next.backgroundEpoch}_${issueId}`;
  const event={id:eventId,kind:'suggestion',questionId:q.id,answerRevision:snapshot.revision,epoch:next.backgroundEpoch,summary:snapshot.summary,fields:clone(issue.suggestion.fields),createdAt:now,issueId,sourceRequestId:issue.sourceRequestId};
  next.answerEvents??=[];next.answerEvents.push(event);
  for(const field of Object.keys(issue.suggestion.fields))snapshot.evidence.push({field,acceptanceEventId:eventId,quote:next.locale==='en'?'The user explicitly adopted this reviewed suggestion.':'用户明确采用了本条同步建议。'});
  q.acceptedSnapshot=snapshot;Object.assign(q,{summary:snapshot.summary,fields:clone(snapshot.fields),evidence:clone(snapshot.evidence),missing:[],status:'complete'});delete q.answerProposal;dirtyConsistency(next);
  if(remaining.length){
    for(const other of next.questions)if(remaining.some(item=>item.questionId===other.id)&&other.status==='complete')other.status='needs-review';
    next.consistency={...next.consistency,status:'requires_review',issues:remaining,checkedRequestId:state.consistency.checkedRequestId};
  }
  if(next.routeDraft?.chapters.length)next.intakeChanged=true;return changed(next);
}
export function generationProgress(state){validatePlanning(state);return state.generationDraft?{...validateGenerationDraft(state.generationDraft),resumable:generationDraftMatches(state,planningFactsHash(state))}:null}
export function startGeneration(state,requestId,expectedRevision,replaceExisting=false,generationMode='new',resourceSnapshot=null){
  expectRevision(state,expectedRevision);if(!canGenerate(state)||!requestToken(requestId))fail('PLANNING_INCOMPLETE');
  if(!['new','resume','restart'].includes(generationMode))fail();
  if(generationMode==='resume'&&!generationDraftMatches(state,planningFactsHash(state)))fail('PLANNING_GENERATION_STALE');
  if(generationMode==='new'&&state.generationDraft)fail('PLANNING_GENERATION_EXISTS');
  if(needsGenerationReplacement(state)&&replaceExisting!==true)fail('PLANNING_REPLACE_REQUIRED');
  if(state.revision>=999_998)fail('PLANNING_CONFLICT');
  const next=clone(state);
  if(generationMode==='restart')delete next.generationDraft;
  if(generationMode==='resume'){
    if(next.resourceSnapshot&&next.resourceSnapshot.provider!==next.provider)fail('PLANNING_GENERATION_STALE');
  }else if(resourceSnapshot===null)delete next.resourceSnapshot;
  else{
    if(!validResourceSnapshot(resourceSnapshot)||resourceSnapshot.provider!==next.provider)fail();
    next.resourceSnapshot=clone(resourceSnapshot);
  }
  next.revision++;next.pending={id:requestId,kind:'generate',baseRevision:next.revision,questionId:null,backgroundEpoch:next.backgroundEpoch??0,factsHash:planningFactsHash(next)};return validatePlanning(next);
}
export function saveGenerationProgress(state,progress,requestId,baseRevision,now=new Date().toISOString()){
  pending(state,requestId,baseRevision,'generate');
  if(!keys(progress,['routeId','outline','chapters'])||!date(now)||state.pending.backgroundEpoch!==(state.backgroundEpoch??0)||state.pending.factsHash!==planningFactsHash(state))fail('PLANNING_CONFLICT');
  const previous=state.generationDraft;
  if(previous){
    if(!generationDraftMatches(state,planningFactsHash(state))||progress.routeId!==previous.routeId||!generationEqual(progress.outline,previous.outline))fail('PLANNING_GENERATION_STALE');
    if(previous.revisedLessonIds!==undefined)fail('PLANNING_CONFLICT');
    if(!Array.isArray(progress.chapters)||progress.chapters.length!==previous.chapters.length)fail('PLANNING_GENERATION_INVALID');
    previous.chapters.forEach((chapter,i)=>{
      if(!chapter)return;
      const next=progress.chapters[i];
      if(!next||!generationEqual(chapter.nodes,next.nodes?.slice(0,chapter.nodes.length)))fail('PLANNING_CONFLICT');
      const ids=new Set(chapter.nodes.map(node=>node.id));
      if(!generationEqual(chapter.materialLinks??[],(next.materialLinks??[]).filter(link=>ids.has(link.targetId))))fail('PLANNING_CONFLICT');
    });
  }
  const next=clone(state);
  next.generationDraft={schemaVersion:1,id:previous?.id??'generation_'+requestId,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??now,updatedAt:now,backgroundEpoch:state.backgroundEpoch??0,factsHash:planningFactsHash(state),policyVersion:GENERATION_POLICY,locale:state.locale,baseRouteHash:generationRouteHash(state.routeDraft),...clone(progress)};
  return validatePlanning(next);
}
export function saveGenerationRevision(state,patch,requestId,baseRevision,now=new Date().toISOString()){
  pending(state,requestId,baseRevision,'generate');
  const factsHash=planningFactsHash(state);
  if(!date(now)||state.pending.backgroundEpoch!==(state.backgroundEpoch??0)||state.pending.factsHash!==factsHash)fail('PLANNING_CONFLICT');
  if(!generationDraftMatches(state,factsHash))fail('PLANNING_GENERATION_STALE');
  const previous=state.generationDraft;
  if(previous.chapters.some((chapter,index)=>chapter?.nodes.length!==previous.outline.result.chapters[index].lessons.length))fail('PLANNING_GENERATION_INVALID');
  if(patch===null&&previous.revisedLessonIds!==undefined)return state;

  const next=clone(state),draft=next.generationDraft;
  const revised=new Set(draft.revisedLessonIds??[]);
  if(patch!==null){
    if(!keys(patch,['nodes','renamedLessons','materialLinks'],['nodes','renamedLessons'])||
       !Array.isArray(patch.nodes)||patch.nodes.length<1||patch.nodes.length>3||patch.nodes.some(node=>!record(node))||
       !Array.isArray(patch.renamedLessons)||new Set(patch.renamedLessons).size!==patch.renamedLessons.length)fail('PLANNING_GENERATION_INVALID');
    const ids=new Set(patch.nodes.map(node=>node.id));
    const chapterIndex=draft.chapters.findIndex(chapter=>chapter.nodes.some(node=>node.id===patch.nodes[0].id));
    if(chapterIndex<0||patch.renamedLessons.some(id=>!ids.has(id)))fail('PLANNING_GENERATION_INVALID');
    const chapter=draft.chapters[chapterIndex],outline=draft.outline.result.chapters[chapterIndex];
    const start=chapter.nodes.findIndex(node=>node.id===patch.nodes[0].id);
    const oldLinks=chapter.materialLinks??[];
    let links=oldLinks;
    if(Object.hasOwn(patch,'materialLinks')){
      const allowed=new Map((state.resourceSnapshot?.items??[]).map(ref=>[ref.id,ref.version]));
      if(!Array.isArray(patch.materialLinks)||patch.materialLinks.some(link=>!validMaterialLink(link)||link.origin!=='ai'||link.kind!=='lesson'||!ids.has(link.targetId)||allowed.get(link.id)!==link.version))fail('PLANNING_GENERATION_INVALID');
      links=[...oldLinks.filter(link=>!ids.has(link.targetId)),...clone(patch.materialLinks)];
      chapter.materialLinks=links;
    }
    const renamed=new Set(patch.renamedLessons);
    patch.nodes.forEach((node,offset)=>{
      const index=start+offset,before=chapter.nodes[index];
      if(!before||before.id!==node.id||(before.title!==node.title)!==renamed.has(node.id))fail('PLANNING_GENERATION_INVALID');
      if(!generationEqual(before,node)||!generationEqual(oldLinks.filter(link=>link.targetId===node.id),links.filter(link=>link.targetId===node.id)))revised.add(node.id);
      chapter.nodes[index]=clone(node);
      outline.lessons[index].title=node.title;
    });
  }
  draft.revisedLessonIds=[...revised];
  draft.revision++;
  draft.updatedAt=now;
  return validatePlanning(next);
}
export function applyGenerated(state,route,requestId,baseRevision,revisedLessons=[],renamedLessons=[],materialLinks=[]){
  pending(state,requestId,baseRevision,'generate');if(!state.questions.every(q=>!isCoreQuestion(q.id)||q.status==='complete')||!consistencyReady(state))fail('PLANNING_INCOMPLETE');
  if(state.pending.backgroundEpoch!==(state.backgroundEpoch??0)||state.pending.factsHash!==planningFactsHash(state))fail('PLANNING_CONFLICT');
  try{validateRoute(route)}catch{fail('PLANNING_ROUTE_INVALID')}if(route.schemaVersion!==2)fail('PLANNING_ROUTE_INVALID');
  if(!Array.isArray(revisedLessons)||revisedLessons.length>512||new Set(revisedLessons).size!==revisedLessons.length||revisedLessons.some(id=>typeof id!=='string'))fail('PLANNING_GENERATION_INVALID');
  const revised=new Set(revisedLessons);
  if(!Array.isArray(renamedLessons)||renamedLessons.length>revised.size||new Set(renamedLessons).size!==renamedLessons.length||renamedLessons.some(id=>!revised.has(id)))fail('PLANNING_GENERATION_INVALID');
  const renamed=new Set(renamedLessons);
  if(state.generationDraft){
    const d=state.generationDraft;if(!generationDraftMatches(state,planningFactsHash(state)))fail('PLANNING_GENERATION_STALE');
    if(d.revisedLessonIds!==undefined&&revisedLessons.length)fail('PLANNING_GENERATION_INVALID');
    const chapters=d.chapters.map(chapter=>{if(!chapter)return null;const {materialLinks:_,...content}=chapter;return content});
    const original={format:'vibe-improve.route',schemaVersion:2,id:d.routeId,revision:1,title:d.outline.result.title,locale:d.locale,sourceLanguage:d.locale,chapters};
    if(revisedLessons.length){
      if(d.chapters.some((chapter,index)=>chapter?.nodes.length!==d.outline.result.chapters[index].lessons.length))fail('PLANNING_GENERATION_INVALID');
      const identity=({chapters,...metadata})=>({...metadata,chapters:chapters.map(({nodes,...chapter})=>({...chapter,nodes:nodes.map(({id})=>id)}))});
      if(!generationEqual(identity(route),identity(original)))fail('PLANNING_GENERATION_INVALID');
      route.chapters.forEach((chapter,index)=>chapter.nodes.forEach((node,offset)=>{
        const before=d.chapters[index].nodes[offset];
        const changed=!generationEqual(node,before);
        if(changed!==revised.has(node.id)||(node.title!==before.title)!==renamed.has(node.id))fail('PLANNING_GENERATION_INVALID');
        revised.delete(node.id);
      }));
      if(revised.size)fail('PLANNING_GENERATION_INVALID');
    }else if(!generationEqual(route,original))fail('PLANNING_GENERATION_INVALID');
  }else if(revisedLessons.length)fail('PLANNING_GENERATION_INVALID');
  const allowed=new Map((state.resourceSnapshot?.items??[]).map(ref=>[ref.id,ref.version]));
  if(!validRouteMaterials([{routeId:route.id,links:materialLinks}])||materialLinks.some(link=>link.origin!=='ai'||allowed.get(link.id)!==link.version||!materialTargetExists(route,link)))fail('PLANNING_GENERATION_INVALID');
  const next=clone(state);rememberRoute(next);clearEditorConversation(next);next.routeDraft=clone(route);next.step='editor';next.intakeChanged=false;
  if(materialLinks.length)next.routeMaterials=[...(next.routeMaterials??[]).filter(entry=>entry.routeId!==route.id),{routeId:route.id,links:clone(materialLinks)}];
  delete next.pending;delete next.proposal;delete next.generationDraft;delete next.resourceSnapshot;return changed(next);
}
export function setRouteMaterial(state,routeId,link,add,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);
  if(state.step!=='editor'||state.routeDraft?.id!==routeId||!validMaterialLink(link)||!materialTargetExists(state.routeDraft,link)||typeof add!=='boolean')fail();
  const existing=state.routeMaterials?.find(entry=>entry.routeId===routeId)?.links??[];
  const index=existing.findIndex(item=>materialKey(item)===materialKey(link));
  if(add?index>=0:index<0)return state;
  if(add&&(link.origin!=='editor'||existing.length>=1024))fail('PLANNING_LIMIT');
  const links=add?[...existing,clone(link)]:existing.filter((_,position)=>position!==index);
  const next=clone(state);
  next.routeMaterials=[...(next.routeMaterials??[]).filter(entry=>entry.routeId!==routeId),{routeId,links}];
  return progressed(next);
}
export function applyEdit(state,result,requestId,baseRevision,now=new Date().toISOString()){
  pending(state,requestId,baseRevision,'edit');if(!keys(result,['reply','route'],['reply'])||!string(result.reply,8000)||!state.routeDraft||!date(now))fail('PLANNING_RESPONSE_INVALID');
  let modified=false;
  if(result.route!=null){
    try{validateRoute(result.route)}catch{fail('PLANNING_ROUTE_INVALID')}
    if(result.route.schemaVersion!==2||result.route.id!==state.routeDraft.id||result.route.locale!==state.routeDraft.locale||result.route.sourceLanguage!==state.routeDraft.sourceLanguage)fail('PLANNING_ROUTE_INVALID');
    modified=!sameRoute({...result.route,revision:state.routeDraft.revision},state.routeDraft);
  }
  const next=clone(state);
  if(modified)next.proposal={route:clone(result.route),reply:result.reply,baseRevision,routeRevision:state.routeDraft.revision};
  addMessage(next,{id:'assistant_'+requestId,role:'assistant',text:result.reply,createdAt:now});delete next.pending;
  return modified?changed(next):progressed(next);
}
export function agentRouteDiagnostics(state,route){
  const issues=routeIssues(route).filter(x=>/^(?:format|schemaVersion|id|revision|title|locale|sourceLanguage|chapters|nodes|stageGoal|objectives|description|prerequisites|estimatedMinutes|activities|assessment|task|passCriteria|objectiveIds|mode|evaluatorPrompt|\d+)(?:\.(?:format|schemaVersion|id|revision|title|locale|sourceLanguage|chapters|nodes|stageGoal|objectives|description|prerequisites|estimatedMinutes|activities|assessment|task|passCriteria|objectiveIds|mode|evaluatorPrompt|\d+))*$/.test(x.path));
  if(state.pending?.kind!=='generate'&&state.routeDraft&&route)for(const key of ['id','locale','sourceLanguage'])if(route[key]!==state.routeDraft[key])issues.push({path:key,code:'identity'});
  return {issues:issues.slice(0,24).map(({path,code})=>({path,code}))};
}
export function cancelPlanningRequest(state,requestId,expectedRevision){expectRevision(state,expectedRevision);if(!state.pending||state.pending.id!==requestId)fail('PLANNING_CONFLICT');const next=clone(state);delete next.pending;return ['edit','consistency'].includes(state.pending.kind)?progressed(next):changed(next)}
export function recoverPlanning(state,now=new Date().toISOString()){
  validatePlanning(state);if(!state.pending)return state;if(!date(now))fail();
  const next=clone(state),id='interrupted_'+next.pending.id;
  const notice=next.pending.prefill
    ?(next.locale==='en'?'Checking earlier answers was interrupted. You can answer this question directly.':'整理前文时中断了，你可以直接回答这一题。')
    :(next.locale==='en'?'The previous request was interrupted. Send your message again to retry.':'上次请求已中断，请重新发送以重试。');
  if(next.messages.length<128&&!next.messages.some(message=>message.id===id))addMessage(next,{id,role:'assistant',text:notice,createdAt:now,...(next.pending.questionId?{questionId:next.pending.questionId}:{})});
  delete next.pending;return ['edit','consistency'].includes(state.pending.kind)?progressed(next):changed(next);
}
export function focusQuestion(state,id,expectedRevision){expectRevision(state,expectedRevision);idle(state);if(!state.questions.some(question=>question.id===id)||state.step!=='intake')fail();const next=clone(state);next.currentQuestion=id;return changed(next)}
export function setProvider(state,provider,expectedRevision,rememberChoice=false){
  expectRevision(state,expectedRevision);idle(state);
  if(!(provider===null||providers.includes(provider)))fail();
  const choice=provider??'manual';
  if(state.provider===provider&&(!rememberChoice||state.agentChoice===choice))return state;
  const next=clone(state);
  if(rememberChoice)next.agentChoice=choice;
  if(next.provider!==provider){
    for(const message of next.messages){
      if(message.role==='assistant'&&message.provider===undefined)message.provider=state.provider;
    }
    next.provider=provider;
    delete next.agentOptions;
  }
  return progressed(next);
}
export function openEditor(state,expectedRevision){expectRevision(state,expectedRevision);idle(state);const next=clone(state);next.step='editor';if(!next.routeDraft)next.routeDraft=emptyRoute(next.projectId,next.locale);return changed(next)}
export function resetEditor(state,expectedRevision){expectRevision(state,expectedRevision);idle(state);const next=clone(state);rememberRoute(next);next.routeDraft=emptyRoute(next.projectId,next.locale);next.routeDraft.revision=(state.routeDraft?.revision??0)+1;next.step='editor';delete next.importedOriginal;delete next.proposal;return changed(next)}
export function saveEditor(state,route,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='editor')fail();validateEditorDraft(route);if(state.routeDraft&&route.id!==state.routeDraft.id)fail('PLANNING_ROUTE_INVALID');
  if(state.routeDraft&&sameRoute(state.routeDraft,route))return state;
  const next=clone(state);rememberRoute(next);next.routeDraft=clone(route);next.routeDraft.revision=(state.routeDraft?.revision??0)+1;delete next.proposal;return changed(next);
}
export function importRoute(state,route,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);validateRoute(route);
  if(state.importedOriginal&&sameRoute(state.importedOriginal,route))return state;
  const next=clone(state);rememberRoute(next);next.routeDraft=upgradeRoute(route);next.importedOriginal=clone(route);next.step='editor';delete next.proposal;return changed(next);
}
export function confirmRoute(state,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(state.step!=='editor'||!state.routeDraft)fail();try{validateRoute(state.routeDraft)}catch{fail('PLANNING_ROUTE_INVALID')}
  const next=clone(state);next.revision++;next.confirmedRevision=next.routeDraft.revision;return validatePlanning(next);
}
export function applyProposal(state,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(!state.proposal||!state.routeDraft||state.proposal.routeRevision!==state.routeDraft.revision)fail('PLANNING_CONFLICT');
  const route=state.proposal.route;return saveEditor(state,route,expectedRevision);
}
export function discardProposal(state,expectedRevision){expectRevision(state,expectedRevision);idle(state);const next=clone(state);delete next.proposal;return changed(next)}
function travelEditor(state,expectedRevision,forward){expectRevision(state,expectedRevision);idle(state);const history=editorHistory(state),from=forward?history.future:history.past,to=forward?history.past:history.future;if(!from.length||!state.routeDraft)fail();const next=clone(state),route=from.pop();to.push(clone(state.routeDraft));keepHistory(next,history);next.routeDraft=route;next.routeDraft.revision=state.routeDraft.revision+1;delete next.proposal;return changed(next)}
export function undoEditor(state,expectedRevision){return travelEditor(state,expectedRevision,false)}
export function redoEditor(state,expectedRevision){return travelEditor(state,expectedRevision,true)}

export function reopenIntake(state,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(!state.provider)fail('PLANNING_INCOMPLETE');
  if(state.step==='intake')return state;
  const next=clone(state);next.step='intake';delete next.proposal;refreshCurrent(next);return changed(next);
}
export function removeImportedRoute(state,expectedRevision){
  expectRevision(state,expectedRevision);idle(state);if(!state.importedOriginal)return state;
  const next=clone(state),id=next.importedOriginal.id;
  if(next.routeDraft?.id===id){
    delete next.routeDraft;delete next.proposal;delete next.undoRoute;delete next.history;
    clearEditorConversation(next);
    next.step=next.provider?'intake':'editor';
    if(!next.provider)next.routeDraft=emptyRoute(next.projectId,next.locale);
    refreshCurrent(next);
  }else{if(next.undoRoute?.id===id)delete next.undoRoute;if(next.history){next.history.past=next.history.past.filter(r=>r.id!==id);next.history.future=next.history.future.filter(r=>r.id!==id)}}
  delete next.importedOriginal;return changed(next);
}

export function setAgentOptions(state,options,expectedRevision){expectRevision(state,expectedRevision);idle(state);if(!state.provider)fail();const next=clone(state);next.agentOptions=clone(options);return progressed(next)}
