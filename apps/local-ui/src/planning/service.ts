import {restartIntake,setResources,resetEditor,acceptAnswer,acceptConsistencySuggestion,cancelAnswerDraft,restartIntakeFrom,reopenIntake,setAgentOptions,type GenerationMode,type AgentOptions,type PlanningTarget,type PlanningMention,removeImportedRoute,createPlanning,validatePlanning,focusQuestion,openEditor,saveEditor,confirmRoute,canGenerate,applyProposal,discardProposal,undoEditor,redoEditor,importRoute,type PlanningState,type QuestionId} from '../../../../packages/domain/planning.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import type {Language} from '../i18n';
import {routeService} from '../routes/service';

export type PlanningIntent='interview'|'generate'|'edit'|'consistency';
export type PlanningActivity={durationMs:number;lastActivityMs:number;thinkingCharacters:number;outputCharacters:number;events:{sequence:number;stage:string;atMs:number;thinkingCharacters:number;outputCharacters:number}[]};
export function parsePlanningActivity(value:unknown):PlanningActivity|undefined{
 if(value===undefined)return undefined;
 const fail=()=>{throw new Error('PLANNING_RESPONSE_INVALID')},object=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)),number=(v:unknown,max=86_400_000)=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=max;
 if(!object(value,['durationMs','lastActivityMs','thinkingCharacters','outputCharacters','events']))return fail();
 const a=value as PlanningActivity,stages=['preparing','connecting','waiting','thinking','generating','receiving','finishing','parsing','validating','total_timeout','idle_timeout','handshake_timeout'];
 if(!number(a.durationMs)||!number(a.lastActivityMs)||a.lastActivityMs>a.durationMs||!number(a.thinkingCharacters,16_777_216)||!number(a.outputCharacters,16_777_216)||!Array.isArray(a.events)||a.events.length>60)return fail();
 let sequence=0,atMs=0;
 for(const e of a.events){if(!object(e,['sequence','stage','atMs','thinkingCharacters','outputCharacters'])||!number(e.sequence)||e.sequence<=sequence||!stages.includes(e.stage)||!number(e.atMs)||e.atMs<atMs||e.atMs>a.durationMs||!number(e.thinkingCharacters,16_777_216)||!number(e.outputCharacters,16_777_216))return fail();sequence=e.sequence;atMs=e.atMs}
 return a;
}
export type GenerationOutput={sequence:number;kind:'outline'|'lessons'|'consistency';form:'reply'|'content';text:string;state:'streaming'|'complete'|'incomplete'};
export type PlanningJob={id:string;projectId:string;intent:PlanningIntent;state:'pending'|'completed'|'failed'|'cancelled';result?:PlanningState;errorCode?:string;userReply?:string;partialReply?:string;generationOutput?:GenerationOutput[];activity?:PlanningActivity;diagnostic?:{promptVersion?:string;stage:string;durationMs:number;receivedCharacters:number;completedChapters?:number;chapterCount?:number}};
export function planningProgress(job:PlanningJob,language:Language){
 const labels:Record<string,[string,string]>={preparing:['准备中…','Preparing…'],connecting:['连接智能体…','Connecting…'],waiting:['等待智能体响应…','Waiting for the agent…'],thinking:['智能体正在思考…','Agent is thinking…'],generating:['正在生成内容…','Generating…'],receiving:['正在接收结果…','Receiving…'],finishing:['正在完成请求…','Finishing…'],parsing:['正在检查结果…','Checking the result…'],validating:['正在校验路线…','Validating…']};
 const item=labels[job.diagnostic?.stage??''];if(!item)return job.intent==='consistency'?(language==='en'?'Checking answers…':'正在检查回答…'):undefined;
 const seconds=Math.floor(Math.max(0,Math.min(1_800_000,Number(job.diagnostic?.durationMs)||0))/10_000)*10;
 const {completedChapters,chapterCount}=job.diagnostic??{};
 const chapter=Number.isInteger(completedChapters)&&Number.isInteger(chapterCount)&&completedChapters!>=0&&chapterCount!>=1&&chapterCount!<=24&&completedChapters!<=chapterCount!?(language==='en'?`${completedChapters}/${chapterCount} chapters ready · `:`已完成 ${completedChapters}/${chapterCount} 章 · `):'';
 return (job.intent==='consistency'?(language==='en'?'Checking answers · ':'检查回答 · '):'')+chapter+item[language==='en'?1:0]+(seconds>=10?` · ${seconds}s`:'');
}
export type PlanningEntry='ai'|'manual'|'import';
const errors=['PLANNING_GENERATION_INVALID','PLANNING_GENERATION_STALE','PLANNING_GENERATION_EXISTS','PLANNING_NEEDS_INPUT','PLANNING_CANNOT_COMPLETE','PLANNING_REPLACE_REQUIRED','PLANNING_TARGET_UNAVAILABLE','PLANNING_AGENT_OPTIONS','PLANNING_AGENT_AUTH_REQUIRED','PLANNING_AGENT_BUSY','PLANNING_AGENT_CANCELLED','PLANNING_AGENT_FAILED','PLANNING_AGENT_INVALID','PLANNING_AGENT_NETWORK','PLANNING_AGENT_OUTPUT_TOO_LARGE','PLANNING_AGENT_PERMISSION_REQUIRED','PLANNING_AGENT_PROTOCOL','PLANNING_AGENT_QUOTA','PLANNING_AGENT_RESULT_REJECTED','PLANNING_AGENT_ROUTE_MISSING','PLANNING_AGENT_ROUTE_ENCODING','PLANNING_AGENT_TIMEOUT','PLANNING_AGENT_UNAVAILABLE','PLANNING_AGENT_UNSUPPORTED','PLANNING_PROJECT_UNAVAILABLE','PLANNING_TOO_LARGE','PLANNING_ROUTE_INVALID','PLANNING_EVIDENCE_INVALID','PLANNING_INVALID','PLANNING_CONFLICT','PLANNING_STORAGE_UNAVAILABLE','PLANNING_INCOMPLETE','PLANNING_LIMIT','PLANNING_CANCELLED','PLANNING_RESPONSE_INVALID','PLANNING_TIMEOUT','PLANNING_BUSY','AGENT_DESKTOP_REQUIRED','AGENT_AUTH_REQUIRED','AGENT_UNAVAILABLE','AGENT_TIMEOUT','AGENT_INVALID','AGENT_BUSY','AGENT_PROJECT_UNAVAILABLE','AGENT_PERMISSION_REQUIRED','AGENT_CANCELLED','ROUTE_INVALID','ROUTE_VERSION_UNSUPPORTED','ROUTE_TOO_MANY_NODES','ROUTE_CONFLICT'] as const;
export function planningError(cause:unknown){const message=cause instanceof Error?cause.message:String(cause);return errors.find(code=>message.includes(code))??'PLANNING_STORAGE_UNAVAILABLE'}
class PlanningTaskNotice extends Error {constructor(code:string,readonly reply:string){super(code)}}
export function planningFailure(job:PlanningJob):Error{const code=job.errorCode??'PLANNING_RESPONSE_INVALID';return job.userReply&&['PLANNING_NEEDS_INPUT','PLANNING_CANNOT_COMPLETE'].includes(code)?new PlanningTaskNotice(code,job.userReply):new Error(code+(code==='PLANNING_AGENT_TIMEOUT'?':'+(job.diagnostic?.stage??''):''))}
export function planningMessage(cause:unknown,language:Language){
 if(cause instanceof PlanningTaskNotice)return cause.reply;
 const detail=cause instanceof Error?cause.message:String(cause);
 if(detail.includes('PLANNING_AGENT_TIMEOUT:total_timeout'))return language==='en'?'The request reached its time limit. Your route was kept.':'已达到本次请求的总时限，原路线已保留。';
 if(detail.includes('PLANNING_AGENT_TIMEOUT:idle_timeout'))return language==='en'?'The agent stopped producing output. Your route was kept. Check the connection or retry with another model.':'智能体长时间没有有效输出，原路线已保留。请检查连接或更换模型后重试。';
 const messages:Record<typeof errors[number],[string,string]>={
  PLANNING_GENERATION_INVALID:['保存的生成草稿未通过校验，请重新生成。原路线已保留。','The saved generation draft is invalid. Start again. Your route was kept.'],
  PLANNING_GENERATION_STALE:['规划背景或原路线已改变，请重新生成。','The background or original route has changed. Start generation again.'],
  PLANNING_GENERATION_EXISTS:['有未完成的生成草稿，请选择继续或重新生成。','An unfinished generation draft exists. Resume it or start again.'],
  PLANNING_NEEDS_INPUT:['请补充规划所需的信息后再继续。','Provide the missing planning information to continue.'],
  PLANNING_CANNOT_COMPLETE:['智能体暂时无法完成本次规划，请调整范围后重试。','The agent cannot complete this planning task. Adjust the scope and retry.'],
  PLANNING_REPLACE_REQUIRED:['修改问题会覆盖已生成路线，是否修改？','Regenerating will replace your existing route. Continue?'],
  PLANNING_TARGET_UNAVAILABLE:['引用的章节已不存在，请重新添加到对话。','The referenced chapter is unavailable. Add it again.'],
  PLANNING_AGENT_OPTIONS:['模型或推理强度已不可用，请重新选择。','The model or reasoning effort is unavailable. Choose again.'],
  PLANNING_AGENT_AUTH_REQUIRED:['智能体需要重新登录。','The agent needs you to sign in again.'],
  PLANNING_AGENT_BUSY:['智能体正在处理其他请求，请稍后重试。','The agent is busy. Try again shortly.'],
  PLANNING_AGENT_CANCELLED:['已停止，已有内容已保留。','Stopped. Existing content was kept.'],
  PLANNING_AGENT_FAILED:['智能体未能完成请求，请重试或手动编辑。','The agent could not finish. Retry or edit manually.'],
  PLANNING_AGENT_INVALID:['智能体请求无效，请重新打开项目。','The agent request is invalid. Open the project again.'],
  PLANNING_AGENT_NETWORK:['智能体连接失败，请检查网络后重试。','The agent could not connect. Check the connection and retry.'],
  PLANNING_AGENT_OUTPUT_TOO_LARGE:['智能体返回的内容过多，请缩小修改范围。','The agent response is too large. Request a smaller change.'],
  PLANNING_AGENT_PERMISSION_REQUIRED:['此操作需要额外权限，当前请求已停止。','The agent needs additional permission. This request was stopped.'],
  PLANNING_AGENT_PROTOCOL:['智能体返回的内容无法解析，请重试。','The agent response could not be read. Try again.'],
  PLANNING_AGENT_QUOTA:['智能体额度不足，请检查对应账户。','Check the agent account quota before retrying.'],
  PLANNING_AGENT_ROUTE_ENCODING:['AI 返回的路线格式不完整，原路线已保留。请重试或更换模型。','The AI returned an incomplete route format. Your route was kept. Retry or choose another model.'],
  PLANNING_AGENT_ROUTE_MISSING:['AI 只返回了说明，未提交路线。原路线已保留，请重试或更换模型。','The AI returned a summary without a route. Your route was kept. Retry or choose another model.'],
  PLANNING_AGENT_RESULT_REJECTED:['AI 返回的路线未通过校验，原路线已保留。请重试。','The AI route did not pass validation. Your route was kept. Try again.'],
  PLANNING_AGENT_TIMEOUT:['智能体响应超时，请重试。','The agent timed out. Try again.'],
  PLANNING_AGENT_UNAVAILABLE:['当前智能体暂不可用，可重试或手动编辑。','The agent is unavailable. Retry or edit manually.'],
  PLANNING_AGENT_UNSUPPORTED:['该智能体暂不支持路线规划，可更换智能体或手动编辑。','This agent cannot plan routes yet. Choose another agent or edit manually.'],
  PLANNING_PROJECT_UNAVAILABLE:['项目目录不可用，请重新定位。','The project folder is unavailable. Locate it again.'],
  PLANNING_TOO_LARGE:['规划内容过多，请缩短输入或减少章节。','The plan is too large. Shorten the input or reduce chapters.'],
  PLANNING_ROUTE_INVALID:['请补全路线名称、大章目标和小章目标，并检查前置依赖。','Complete the route name, chapter goals and lesson goals, and check prerequisites.'],
  PLANNING_EVIDENCE_INVALID:['智能体返回的信息关联异常，请重试或手动编辑。','The agent returned invalid message references. Retry or edit manually.'],
  PLANNING_INVALID:['规划数据无效，请重新打开项目。','The planning data is invalid. Open the project again.'],
  PLANNING_CONFLICT:['规划已更新，请重新读取后继续。','The plan changed. Reload it to continue.'],
  PLANNING_STORAGE_UNAVAILABLE:['无法保存或读取规划，请重试。','Cannot save or read the plan. Try again.'],
  PLANNING_INCOMPLETE:['请补全必要信息或章节字段。','Complete the required information or chapter fields.'],
  PLANNING_LIMIT:['规划内容过多，请缩短本次输入。','The planning content is too large. Shorten this input.'],
  PLANNING_CANCELLED:['已停止，已有内容已保留。','Stopped. Existing content was kept.'],
  PLANNING_RESPONSE_INVALID:['智能体的结果格式无效，请重试。','The agent returned an invalid result. Try again.'],
  PLANNING_TIMEOUT:['智能体响应超时，请重试。','The agent timed out. Try again.'],
  PLANNING_BUSY:['请等待当前操作完成。','Wait for the current operation to finish.'],
  AGENT_DESKTOP_REQUIRED:['请在桌面应用中使用智能体对话。','Use agent conversations in the desktop app.'],
  AGENT_AUTH_REQUIRED:['智能体需要重新登录。','The agent needs you to sign in again.'],
  AGENT_UNAVAILABLE:['当前智能体暂不可用，可重试或手动编辑。','The agent is unavailable. Retry or edit manually.'],
  AGENT_TIMEOUT:['智能体响应超时，请重试。','The agent timed out. Try again.'],
  AGENT_INVALID:['智能体请求无效，请重新打开项目。','The agent request is invalid. Open the project again.'],
  AGENT_BUSY:['智能体仍在处理当前请求。','The agent is still processing the current request.'],
  AGENT_PROJECT_UNAVAILABLE:['项目目录不可用，请重新定位。','The project folder is unavailable. Locate it again.'],
  AGENT_PERMISSION_REQUIRED:['此操作需要智能体权限，当前对话已停止。','The agent needs permission. This request was stopped.'],
  AGENT_CANCELLED:['已停止，已有内容已保留。','Stopped. Existing content was kept.'],
  ROUTE_INVALID:['章节、目标或前置依赖需要修正。','Correct the chapters, goals or prerequisites.'],
  ROUTE_VERSION_UNSUPPORTED:['暂不支持此路线版本。','This route version is not supported.'],
  ROUTE_TOO_MANY_NODES:['路线最多包含512个小章节。','A route can contain up to 512 lessons.'],
  ROUTE_CONFLICT:['路线已更新，请重新读取。','The route changed. Reload it.'],
 };return messages[planningError(cause)][language==='en'?1:0];
}
const native=()=>window.vibeNative?.projects;
function projectID(id:string){if(!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Error('PLANNING_INVALID')}
async function request<T>(action:string,values:Record<string,unknown>):Promise<T>{try{return await native()!.request(action,values) as T}catch(cause){throw new Error(planningError(cause))}}
let database:Promise<IDBDatabase>|undefined;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const q=indexedDB.open('vibe-improve.planning.v1',1);q.onupgradeneeded=()=>q.result.createObjectStore('plans',{keyPath:'projectId'});q.onsuccess=()=>resolve(q.result);q.onerror=()=>{database=undefined;reject(new Error('PLANNING_STORAGE_UNAVAILABLE'))}})}
async function browserRead(id:string){const storage=await db();return new Promise<PlanningState|null>((resolve,reject)=>{const q=storage.transaction('plans').objectStore('plans').get(id);q.onsuccess=()=>{try{resolve(q.result?validatePlanning(q.result):null)}catch{reject(new Error('PLANNING_STORAGE_UNAVAILABLE'))}};q.onerror=()=>reject(new Error('PLANNING_STORAGE_UNAVAILABLE'))})}
async function browserMutate(id:string,change:(state:PlanningState|null)=>PlanningState){const storage=await db();return new Promise<PlanningState>((resolve,reject)=>{const tx=storage.transaction('plans','readwrite'),store=tx.objectStore('plans');let next:PlanningState,error='PLANNING_STORAGE_UNAVAILABLE';const q=store.get(id);q.onsuccess=()=>{try{next=validatePlanning(change(q.result?validatePlanning(q.result):null));store.put(next)}catch(cause){error=planningError(cause);tx.abort()}};tx.oncomplete=()=>resolve(next!);tx.onerror=tx.onabort=()=>reject(new Error(error))})}
function required(value:PlanningState|null){if(!value)throw new Error('PLANNING_INVALID');return value}
function job(value:unknown,id:string):PlanningJob{const x=value as PlanningJob;if(!x||x.projectId!==id||typeof x.id!=='string'||!['interview','generate','edit','consistency'].includes(x.intent)||!['pending','completed','failed','cancelled'].includes(x.state))throw new Error('PLANNING_RESPONSE_INVALID');if(x.partialReply!==undefined&&(typeof x.partialReply!=='string'||x.partialReply.length>8000||!['pending','failed','cancelled'].includes(x.state)))throw new Error('PLANNING_RESPONSE_INVALID');if(x.userReply!==undefined&&(typeof x.userReply!=='string'||!x.userReply.trim()||x.userReply.length>8000||x.state!=='failed'||!['PLANNING_NEEDS_INPUT','PLANNING_CANNOT_COMPLETE'].includes(x.errorCode??'')))throw new Error('PLANNING_RESPONSE_INVALID');return{...x,generationOutput:parseGenerationOutput(x.generationOutput),activity:parsePlanningActivity(x.activity),...(x.result?{result:validatePlanning(x.result)}:{})}}
export function parseGenerationOutput(value:unknown):GenerationOutput[]|undefined{
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>1024)throw new Error('PLANNING_RESPONSE_INVALID');
 let sequence=0,bytes=0;
 for(const item of value){
  if(!item||typeof item!=='object'||Object.keys(item).length!==5||!['sequence','kind','form','text','state'].every(key=>key in item))throw new Error('PLANNING_RESPONSE_INVALID');
  if(!Number.isInteger(item.sequence)||item.sequence<=sequence||item.sequence>1024||!['outline','lessons','consistency'].includes(item.kind)||!['reply','content'].includes(item.form)||!['streaming','complete','incomplete'].includes(item.state)||typeof item.text!=='string'||item.text.includes('\0'))throw new Error('PLANNING_RESPONSE_INVALID');
  sequence=item.sequence;bytes+=new TextEncoder().encode(item.text).length;if(bytes>8_388_608)throw new Error('PLANNING_RESPONSE_INVALID');
 }
 return value as GenerationOutput[];
}
export type PlanningModel={id:string;name:string;isDefault:boolean;efforts:string[]};
export type ModelCatalog={provider:string;models:PlanningModel[]};
export const planningService={
 models:async(id:string,refresh=false):Promise<ModelCatalog>=>{projectID(id);if(!native())return {provider:'',models:[]};const data=await request<ModelCatalog>('planning.models',{projectId:id,...(refresh?{refresh:true}:{})});if(!data||typeof data.provider!=='string'||!Array.isArray(data.models)||data.models.length>300||data.models.some(m=>!m||typeof m.id!=='string'||typeof m.name!=='string'||!Array.isArray(m.efforts)))throw new Error('PLANNING_RESPONSE_INVALID');return data},
 options:async(state:PlanningState,options:AgentOptions)=>native()?validatePlanning(await request('planning.options',{projectId:state.projectId,options,expectedRevision:state.revision})):browserMutate(state.projectId,s=>setAgentOptions(required(s),options,state.revision)),
 removeImport:async(id:string,expectedPlanningRevision:number|null,expectedRouteRevision:number):Promise<PlanningState|null>=>{
  projectID(id);if(native()){const result=await request<unknown>('planning.import.remove',{projectId:id,expectedPlanningRevision,expectedRouteRevision});return result===null?null:validatePlanning(result)}
  const saved=await browserRead(id);if((saved?.revision??null)!==expectedPlanningRevision||saved?.pending)throw new Error('PLANNING_CONFLICT');
  const route=await routeService.read(id);if(route.revision!==expectedRouteRevision)throw new Error('PLANNING_CONFLICT');await routeService.removeImport(route,Boolean(saved?.routeDraft&&saved.routeDraft.id!==saved.importedOriginal?.id));
  return saved?browserMutate(id,s=>removeImportedRoute(required(s),expectedPlanningRevision!)):null;
 },
 read:async(id:string):Promise<PlanningState|null>=>{projectID(id);if(!native()){const saved=await browserRead(id);if(saved?.importedOriginal&&!(await routeService.read(id)).routeDraft)return browserMutate(id,s=>removeImportedRoute(required(s),required(s).revision));return saved;}const value=await request<unknown>('planning.read',{projectId:id});return value===null?null:validatePlanning(value)},
 enter:async(id:string,locale:Language,mode:PlanningEntry,expectedRevision?:number):Promise<PlanningState>=>{
  projectID(id);if(native())return validatePlanning(await request('planning.enter',{projectId:id,locale,mode,...(expectedRevision!==undefined?{expectedRevision}:{})}));
  if(mode==='ai')throw new Error('AGENT_DESKTOP_REQUIRED');const imported=mode==='import'?(await routeService.read(id)).routeDraft?.route:undefined;
  return browserMutate(id,old=>{if(old){if(mode==='import'&&expectedRevision!==undefined){if(!imported)throw new Error('PLANNING_INVALID');return importRoute(old,imported,expectedRevision)}return old.step==='editor'?old:openEditor(old,old.revision)}return createPlanning(id,null,locale,imported)});
 },
 restartIntake:async(state:PlanningState)=>native()?validatePlanning(await request('planning.intake.restart',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>restartIntake(required(s),state.revision)),
 resources:async(state:PlanningState,text:string)=>native()?validatePlanning(await request('planning.resources.save',{projectId:state.projectId,text,expectedRevision:state.revision})):browserMutate(state.projectId,s=>setResources(required(s),text,state.revision)),
 acceptAnswer:async(state:PlanningState,questionId:QuestionId,messageId:string)=>native()?validatePlanning(await request('planning.answer.accept',{projectId:state.projectId,questionId,messageId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>acceptAnswer(required(s),questionId,messageId,state.revision)),
 cancelAnswerDraft:async(state:PlanningState,questionId:QuestionId)=>native()?validatePlanning(await request('planning.answer.cancel-draft',{projectId:state.projectId,questionId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>cancelAnswerDraft(required(s),questionId,state.revision)),
 adoptSuggestion:async(state:PlanningState,issueId:string)=>native()?validatePlanning(await request('planning.consistency.suggestion.accept',{projectId:state.projectId,issueId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>acceptConsistencySuggestion(required(s),issueId,state.revision)),
 reanswer:async(state:PlanningState,questionId:QuestionId)=>native()?validatePlanning(await request('planning.answer.reset',{projectId:state.projectId,questionId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>restartIntakeFrom(required(s),questionId,state.revision)),
 focus:async(state:PlanningState,questionId:QuestionId)=>native()?validatePlanning(await request('planning.focus',{projectId:state.projectId,questionId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>focusQuestion(required(s),questionId,state.revision)),
 reopenIntake:async(state:PlanningState)=>native()?validatePlanning(await request('planning.reopen-intake',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>reopenIntake(required(s),state.revision)),
 resetEditor:async(state:PlanningState)=>native()?validatePlanning(await request('planning.route.reset',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>resetEditor(required(s),state.revision)),
 openEditor:async(state:PlanningState)=>native()?validatePlanning(await request('planning.open-editor',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>openEditor(required(s),state.revision)),
 save:async(state:PlanningState,route:RouteDocument)=>native()?validatePlanning(await request('planning.save',{projectId:state.projectId,route,expectedRevision:state.revision})):browserMutate(state.projectId,s=>saveEditor(required(s),route,state.revision)),
 confirm:async(state:PlanningState)=>native()?validatePlanning(await request('planning.confirm',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>confirmRoute(required(s),state.revision)),
 begin:async(state:PlanningState,intent:PlanningIntent,text?:string,mentions?:PlanningMention[],target?:PlanningTarget,replaceExisting=false,generationMode:GenerationMode='new')=>{if(!native())throw new Error('AGENT_DESKTOP_REQUIRED');if(intent==='generate'&&!canGenerate(state))throw new Error('PLANNING_INCOMPLETE');return job(await request('planning.begin',{projectId:state.projectId,intent,expectedRevision:state.revision,...(intent==='generate'?{generationMode}:{}),...(replaceExisting?{replaceExisting:true}:{}),...(text!==undefined?{text}:{}),...(mentions?.length?{mentions}:target?{target}:{})}),state.projectId)},
 job:async(id:string,jobId:string)=>job(await request('planning.state',{projectId:id,jobId}),id),
 cancel:async(id:string,jobId:string)=>job(await request('planning.cancel',{projectId:id,jobId}),id),
 applyProposal:async(state:PlanningState)=>native()?validatePlanning(await request('planning.proposal.apply',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>applyProposal(required(s),state.revision)),
 discardProposal:async(state:PlanningState)=>native()?validatePlanning(await request('planning.proposal.discard',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>discardProposal(required(s),state.revision)),
 undo:async(state:PlanningState)=>native()?validatePlanning(await request('planning.undo',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>undoEditor(required(s),state.revision)),
 redo:async(state:PlanningState)=>native()?validatePlanning(await request('planning.redo',{projectId:state.projectId,expectedRevision:state.revision})):browserMutate(state.projectId,s=>redoEditor(required(s),state.revision)),
};
