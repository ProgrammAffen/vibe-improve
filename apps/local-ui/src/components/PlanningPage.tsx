import type {PlanningActivity} from '../planning/service';
import {useEffect,useRef,useState} from 'react';
import {CheckCircle2,ChevronRight,Circle,CircleDot,ClipboardList,Ellipsis,FileText,LoaderCircle,TriangleAlert} from 'lucide-react';
import {DEFAULT_QUESTION_IDS,canPrefillInterview,canRequestGeneration,generationProgress,acceptedAnswer,answerConfirmation,intakeCurrentQuestion,intakeQuestions,questionMessages,questionLabel,questionText,questionHelp,questionExample,sameRoute,type GenerationMode,type AgentOptions,type PlanningState,type PlanningTarget,type PlanningMention,type QuestionId} from '../../../../packages/domain/planning.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import type {ProjectRecord} from '../projects/domain';
import {translate,type Language} from '../i18n';
import {planningService,planningMessage,planningProgress,planningFailure,planningGenerationMessage,type PlanningEntry,type PlanningIntent,type PlanningJob} from '../planning/service';
import {learningService,type LearningProgress} from '../routes/learning';
import {routeService} from '../routes/service';
import {PROVIDERS,type ProviderId} from '../agents/domain';
import {isResourceUsable,resourceKey,resourceMessage,resourceRef,resourceService,useResourceBindings,useResourceList,type AttachmentTarget,type ResourceItem} from '../resources/service';
import GameButton from './GameButton';
import BackHomeButton from './BackHomeButton';
import PlanningNavigation from './PlanningNavigation';
import PlanningConsistencyReview from './PlanningConsistencyReview';
import PlanningAnswerReview from './PlanningAnswerReview';
import PlanningGenerationDialog from './PlanningGenerationDialog';
import {mergeGenerationOutput,type GenerationEntry} from '../planning/output';
import {generateWithConsistency,generationStage,type GenerationStage} from '../planning/generation';
import type {PlanningAttachment} from '../../../../packages/domain/planning.mjs';
import {quickAnswers} from '../planning/quick-answers';
import PlanningModelControls,{PlanningAgentControl} from './PlanningModelControls';
import Modal from './Modal';
import {PlanningComposer as Composer,PlanningMessages} from './PlanningConversation';
import {RouteEditorSurface} from './RouteEditor';
import PlanningResourcesDialog from './PlanningResourcesDialog';
import ResourceAttachments,{attachmentsFrom,ResourcePicker} from './ResourceAttachments';
export {PlanningMessages} from './PlanningConversation';
export {RouteEditorSurface} from './RouteEditor';
import './planning.css';
import './route-editor.css';

type IntakeProps={language:Language;state:PlanningState;busy?:boolean;working?:boolean;workingLabel?:string;partialReply?:string;partialProviderId?:string|null;activity?:PlanningActivity;error?:string;notice?:string;generationStatus?:string;generationFailed?:boolean;materials?:{summary:string;onOpen:()=>void;draftChange?:'added'|'removed'};onSend:(text:string,attachments?:PlanningAttachment[])=>void|boolean|Promise<boolean>;onCancel:()=>void;onFocus:(id:QuestionId)=>void;onOptions?:(options:AgentOptions)=>void;onProvider?:(provider:ProviderId)=>void;onAccept:(id:QuestionId,messageId:string)=>void;onRestart:()=>void;onReanswer:(id:QuestionId)=>void;onAdoptSuggestion:(issueId:string)=>void;onResources:(text:string)=>Promise<boolean>;onGenerate:()=>void;onResume?:()=>void;onRegenerate?:()=>void;onManual:()=>void;onPrevious:()=>void;onHome:()=>void};
export function PlanningIntakeSurface({language,state,busy=false,working=false,workingLabel,partialReply,partialProviderId,activity,error='',notice='',generationStatus,generationFailed=false,materials,onSend,onCancel,onFocus,onOptions,onProvider,onAccept,onRestart,onReanswer,onAdoptSuggestion,onResources,onGenerate,onResume,onRegenerate,onManual,onPrevious,onHome}:IntakeProps){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const questions=intakeQuestions(state);
 const focusedQuestion=intakeCurrentQuestion(state);
 const current=focusedQuestion??DEFAULT_QUESTION_IDS.at(-1)!;
 const selected=questions.find(item=>item.id===current)!;
 const complete=questions.filter(item=>item.status==='complete'&&DEFAULT_QUESTION_IDS.some(id=>id===item.id)).length;
 const [resourceNotes,setResourceNotes]=useState(''),[resourcesOpen,setResourcesOpen]=useState(false),[resourceSending,setResourceSending]=useState(false);
 const progress=generationProgress(state);
 const ready=canRequestGeneration(state);
 const resumable=progress?.resumable&&materials?.draftChange!=='removed';
 const hasRoute=Boolean(state.routeDraft?.chapters.length);
 const label=resumable?t('继续生成路线','Resume generation'):t('生成路线','Generate route');
 let status:string;
 if(generationStatus)status=generationStatus;
 else if(state.pending?.kind==='consistency')status=t('正在检查回答…','Checking answers…');
 else if(state.pending?.kind==='generate')status=t('正在生成路线…','Generating route…');
 else if(!ready)status=questions.some(item=>item.status==='needs-review')?t('请先复核回答','Review answers first'):t('请完成必答项','Complete the required items');
 else if(progress){
  const count=`${progress.completed} / ${progress.total}`;
  status=t(`已保存 ${count} 节草稿`,`${count} lesson drafts saved`);
  if(materials?.draftChange==='removed')status+=t(' · 所用资料已变更',' · Resources changed');
  else if(!resumable)status+=t(' · 生成条件已变化',' · Generation conditions have changed');
  else if(materials?.draftChange==='added')status+=t(' · 使用新增资料需重新生成',' · Regenerate to use new resources');
  else if(progress.revised!==undefined){
   status=progress.revised?t(`已保存 ${progress.revised} 节修订 · 待复审`,`${progress.revised} revised ${progress.revised===1?'lesson':'lessons'} saved · Review pending`)
     :status+t(' · 待修订',' · Revision pending');
  }else if(progress.completed===progress.total)status+=t(' · 待审核',' · Review pending');
 }
 else if(generationFailed)status=hasRoute?t('本次生成未完成 · 原路线已保留','Generation incomplete · Existing route kept'):t('本次生成未完成','Generation incomplete');
 else status=hasRoute?t('路线已保存','Route saved'):t('尚未生成路线','No route generated yet');
 const more=useRef<HTMLDetailsElement>(null);
 function chooseAction(action:()=>void){
  const menu=more.current;
  if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
  action();
 }
 const composerInput=useRef<HTMLTextAreaElement>(null);
 const followUp=selected.missing[0];
 const question=followUp??questionText(current,language);
 const messages=questionMessages(state,current);
 const isInitial=(selected.status==='current'||selected.status==='pending')&&!followUp&&!messages.length;
 const help=isInitial?questionHelp(current,language):'';
 const example=isInitial?questionExample(current,language):'';
 const goal=acceptedAnswer(questions.find(item=>item.id==='goal'));
 const unanswered=['current','pending','needs-detail'].includes(selected.status)&&!messages.some(message=>message.role==='user');
 const hasQuickAnswerFact=current==='baseline'?selected.fields.experience:current==='time'?selected.fields.weekly??selected.fields.schedule:undefined;
 const options=unanswered&&!hasQuickAnswerFact?quickAnswers(current,goal?.fields.topic??goal?.fields.outcome??'',language,state.locale===language?selected.baselineOptions:undefined):[];
 const questionList=useRef<HTMLOListElement>(null);
 useEffect(()=>{
  const list=questionList.current;
  const active=list?.querySelector(complete===DEFAULT_QUESTION_IDS.length&&!state.currentQuestion?'[data-optional-resource]':'[aria-current="step"]');
  if(!list||!active)return;
  const reveal=()=>{const viewport=list.getBoundingClientRect(),row=active.getBoundingClientRect();if(row.bottom>viewport.bottom)list.scrollTop+=row.bottom-viewport.bottom;else if(row.top<viewport.top)list.scrollTop+=row.top-viewport.top;};
  reveal();const observer=new ResizeObserver(reveal);observer.observe(list);return()=>observer.disconnect();
 },[current,complete,state.currentQuestion]);
 useEffect(()=>{
  function closeOutside(event:PointerEvent){
   const menu=more.current;
   if(menu?.open&&event.target instanceof Node&&!menu.contains(event.target))menu.open=false;
  }
  document.addEventListener('pointerdown',closeOutside);
  return()=>document.removeEventListener('pointerdown',closeOutside);
 },[]);
 return <section className="planning-page planning-page--intake"><PlanningNavigation language={language} busy={busy} onHome={onHome} onPrevious={onPrevious}/><div className="planning-stage planning-stage--intake">
  <div className="planning-intake-scroll" aria-hidden="true"/>
  <header className="planning-header"><h1>{t('规划路线','Plan your route')}</h1></header>
  <div className="planning-intake-layout">
   <section className="planning-conversation" aria-label={t('规划对话','Planning conversation')}>
    {(onProvider||state.provider&&onOptions)&&<div className="planning-agent-settings">
     {onProvider&&<PlanningAgentControl state={state} language={language} busy={busy} onProvider={onProvider}/>}
     {state.provider&&onOptions&&<PlanningModelControls key={state.provider} state={state} language={language} busy={busy} onOptions={onOptions}/>}
    </div>}
    <div className="planning-current-question">
     <div className="planning-question-heading">
      <small><CircleDot aria-hidden="true"/>{questionLabel(current,language)}</small>
      {(messages.length>0||selected.summary||selected.acceptedSnapshot)&&<button type="button" className="text-button planning-reanswer" disabled={busy} onClick={()=>onReanswer(current)}>{t('重新回答','Answer again')}</button>}
     </div>
     <h2>{question}</h2>{help&&<p className="planning-question-help">{help}</p>}{example&&<p className="planning-question-example"><strong>{t('示例','Example')}</strong> {example}</p>}
    </div>
    <PlanningMessages key={'messages:'+current+':'+(selected.conversationFrom??0)} messages={messages} providerId={state.provider} language={language} busy={working} workingLabel={workingLabel} partialReply={partialReply} partialProviderId={partialProviderId} activity={activity}>
     <PlanningConsistencyReview state={state} language={language} busy={busy} onAccept={onAdoptSuggestion} onReanswer={onReanswer}/>
     <PlanningAnswerReview state={state} questionId={current} language={language} busy={busy} onAccept={()=>onAccept(current,selected.answerProposal!.messageId)} onClarify={()=>composerInput.current?.focus()}/>
     {selected.status==='complete'&&<p className="planning-answer-collected"><CheckCircle2 aria-hidden="true"/>{t('已采集','Collected')} · {selected.summary}</p>}
     {options.length>0&&<div className="planning-quick-answers" role="group" aria-label={t('快捷回答','Quick answers')}>
      {options.map(option=><button className="text-button" key={option.label} type="button" title={option.label} disabled={busy||!state.provider} onClick={()=>void onSend(option.reply)}>{option.label}</button>)}
     </div>}
    </PlanningMessages>
    <Composer key={'composer:'+current+':'+(state.backgroundEpoch??0)+':'+(selected.conversationFrom??0)}
      inputRef={composerInput} language={language} busy={working}
      disabled={busy&&!working||!state.provider||selected.status==='complete'} attachmentProject={state.provider?state.projectId:undefined}
      onSend={(text,_,files)=>onSend(text,files)} onCancel={onCancel}/>
   </section>
   <section className="planning-checklist" aria-label={t('采集清单','Intake checklist')}>
    <header><h2><ClipboardList aria-hidden="true"/>{t('采集清单','Checklist')}</h2><output aria-live="polite" aria-label={t('已完成必答项','Completed required items')}>{complete} / {DEFAULT_QUESTION_IDS.length}</output></header>
    <ol ref={questionList} className="planning-question-list" tabIndex={0} aria-label={t('采集清单，可上下滚动','Intake checklist, scroll to see more')}>
     {questions.map(item=>{const active=item.id===focusedQuestion,done=item.status==='complete',review=item.status==='needs-review',summary=review?acceptedAnswer(item)?.summary??item.summary:item.summary;return <li key={item.id} className={`${active?'is-current':''} ${done?'is-complete':''} ${review?'needs-review':''}`}><button type="button" onClick={()=>onFocus(item.id)} disabled={busy} aria-current={active?'step':undefined} aria-label={t('查看','Review')+' '+questionLabel(item.id,language)+(review?t('，待复核',', review needed'):done?t('，已采集',', collected'):'')} title={summary||item.missing.join(' · ')||questionLabel(item.id,language)}><span className="planning-question-state" aria-hidden="true">{review?<TriangleAlert/>:done?<CheckCircle2/>:active?<CircleDot/>:<Circle/>}</span><span className="planning-question-copy"><strong>{questionLabel(item.id,language)}</strong><small>{review?t('待复核 · ','Review needed · '):done?t('已采集 · ','Collected · '):item.status==='awaiting-confirmation'?t('待确认 · ','Review · '):''}{summary||(active&&item.missing.length?item.missing.join(' · '):active?t('待回答','Awaiting reply'):t('待采集','Pending'))}</small></span></button></li>})}
     <li data-optional-resource className="planning-optional-resource">
      <button type="button" disabled={busy} aria-haspopup="dialog" onClick={event=>{
       // The dialog restores focus to the opener when it closes.
       event.currentTarget.focus({preventScroll:true});
       if(materials)materials.onOpen();
       else{setResourceNotes(state.resources??'');setResourcesOpen(true);}
      }}>
       <span className="planning-question-state"><FileText aria-hidden="true"/></span>
       <span className="planning-question-copy">
        <strong>{t('学习资料（可选）','Resources (optional)')}</strong>
        <small>{materials?.summary??(state.resources?t('已补充说明','Notes added'):t('未添加','None added'))}</small>
       </span><ChevronRight className="planning-optional-arrow" aria-hidden="true"/>
      </button>
     </li>
    </ol>
    <footer className="planning-intake-footer">
     <p className="planning-generation-progress" role="status">{status}</p>
     <div className="planning-intake-actions">
      <details className="planning-intake-more" ref={more} onBlur={event=>{
       if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;
      }} onKeyDown={event=>{
       if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}
      }}>
       <summary><Ellipsis aria-hidden="true"/>{t('更多','More')}</summary>
       <div className="planning-intake-menu">
        {!hasRoute&&<button type="button" disabled={busy} onClick={()=>chooseAction(onManual)}>{t('手动编辑路线','Edit route manually')}</button>}
        {resumable&&<button type="button" disabled={busy||!ready} onClick={()=>onRegenerate&&chooseAction(onRegenerate)}>{t('重新生成','Regenerate route')}</button>}
        <button type="button" disabled={busy} onClick={()=>chooseAction(onRestart)}>{t('重新采集','Start over')}</button>
       </div>
      </details>
      <div className="planning-route-actions">
       <GameButton variant="secondary" disabled={busy||!hasRoute} onClick={onManual}>{t('编辑已有路线','Edit existing route')}</GameButton>
       <GameButton disabled={busy||!ready} onClick={!progress?onGenerate:resumable?onResume:onRegenerate}>{label}</GameButton>
      </div>
     </div>
    </footer>
   </section>
  </div>
  <div className="planning-page-feedback" aria-live="polite">{notice&&<p className="planning-synced-notice" role="status">{notice}</p>}{error&&<p className="form-message is-error" role="alert">{error}</p>}</div>
  {resourcesOpen&&<Modal title={t('学习资料（可选）','Resources (optional)')} closeLabel={t('关闭','Close')} busy={busy||resourceSending} onClose={()=>setResourcesOpen(false)}><textarea className="planning-resource-input" aria-label={t('资料链接或名称','Resource links or names')} placeholder={t('资料链接或名称','Resource links or names')} value={resourceNotes} maxLength={4000} disabled={busy||resourceSending} onChange={event=>setResourceNotes(event.target.value)}/>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy||resourceSending} onClick={()=>setResourcesOpen(false)}>{t('取消','Cancel')}</GameButton><GameButton disabled={busy||resourceSending||resourceNotes.trim()===(state.resources??'')} onClick={()=>{setResourceSending(true);void Promise.resolve().then(()=>onResources(resourceNotes.trim())).then(accepted=>{if(accepted!==false){setResourceNotes('');setResourcesOpen(false)}}).catch(()=>{}).finally(()=>setResourceSending(false))}}>{t('保存','Save')}</GameButton></div></Modal>}
 </div></section>;
}

type PlanningPageProps={
 language:Language;
 project:ProjectRecord;
 entryMode?:PlanningEntry|'resume';
 onPrevious:()=>void;
 onHome:()=>void;
 onConfirmed?:(route:RouteDocument)=>void;
 learningRefresh?:number;
 onResetLearning?:(route:RouteDocument,progress:LearningProgress)=>void;
};

type NewGenerationMode=Exclude<GenerationMode,'resume'>;

export default function PlanningPage({language,project,entryMode='resume',onPrevious,onHome,onConfirmed,learningRefresh=0,onResetLearning}:PlanningPageProps){
 const [state,setState]=useState<PlanningState|null>(null),[draft,setDraft]=useState<RouteDocument|null>(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState(''),[conversationError,setConversationError]=useState(''),[notice,setNotice]=useState(''),[workingLabel,setWorkingLabel]=useState<string|undefined>(),[partialReply,setPartialReply]=useState<string|undefined>(),[importReview,setImportReview]=useState<string|null>(null),[activity,setActivity]=useState<PlanningActivity|undefined>();
 const [removeImport,setRemoveImport]=useState<number|null>(null),[generationConfirmation,setGenerationConfirmation]=useState<NewGenerationMode|null>(null),[restartReview,setRestartReview]=useState(false),[reanswerReview,setReanswerReview]=useState<QuestionId|null>(null),[generationOpen,setGenerationOpen]=useState(false),[generationRunning,setGenerationRunning]=useState(false),[generationEntries,setGenerationEntries]=useState<GenerationEntry[]>([]),[generationError,setGenerationError]=useState('');
 const [routeGenerationStage,setRouteGenerationStage]=useState<GenerationStage>({phase:'prepare'});
 const [resourceDialog,setResourceDialog]=useState(false),[attachmentTarget,setAttachmentTarget]=useState<AttachmentTarget>();
 const [preparingGeneration,setPreparingGeneration]=useState(false);
 const checkingResources=useRef(false);
 const resources=useResourceList(project.id);
 const materialData=useResourceBindings(project.id,state?.step==='editor'?state.routeDraft?.id:undefined,state?.revision);
 const [partialProviderId,setPartialProviderId]=useState<string|null>();
 const [generationBlock,setGenerationBlock]=useState<Pick<PlanningJob,'qualityReason'|'qualitySummary'>>();
 const generationActive=useRef(false),generationCancelled=useRef(false);
 const mounted=useRef(true),acting=useRef(false),currentJob=useRef<PlanningJob|null>(null),draftRef=useRef<RouteDocument|null>(null),dirtyRef=useRef(false),stateRef=useRef<PlanningState|null>(null);stateRef.current=state;draftRef.current=draft;dirtyRef.current=dirty;
 const [progressRead,setProgressRead]=useState<{key:string;progress?:LearningProgress}>();
 const [progressRetry,setProgressRetry]=useState(0);
 const savedRoute=state?.routeDraft;
 const progressKey=onResetLearning&&savedRoute?JSON.stringify([project.id,savedRoute.id,savedRoute.revision,learningRefresh,progressRetry]):undefined;
 const learningProgress=progressRead?.key===progressKey?progressRead?.progress:undefined;
 const learningRead=progressKey&&!learningProgress?(progressRead?.key===progressKey?'failed':'loading'):undefined;
 useEffect(()=>{
  if(!progressKey||!savedRoute)return;
  let current=true;
  void learningService.read(project.id,savedRoute).then(progress=>{
   if(current)setProgressRead({key:progressKey,progress});
  },()=>{
   if(current)setProgressRead({key:progressKey});
  });
  return()=>{current=false};
 },[progressKey]);
 function accept(next:PlanningState){if(!mounted.current)return;setState(next);stateRef.current=next;setDraft(next.routeDraft??null);draftRef.current=next.routeDraft??null;setDirty(false);dirtyRef.current=false}
 async function load(){setBusy(true);setError('');try{const old=await planningService.read(project.id);if(entryMode==='resume'&&old)accept(old);else if(entryMode==='import'&&old){const imported=(await routeService.read(project.id)).routeDraft?.route;if(imported&&(!old.importedOriginal||!sameRoute(imported,old.importedOriginal))){accept(old);if(mounted.current)setImportReview(imported.title)}else accept(await planningService.enter(project.id,language,'import'))}else accept(await planningService.enter(project.id,language,entryMode==='resume'?'manual':entryMode))}catch(cause){if(mounted.current)setError(planningMessage(cause,language))}finally{if(mounted.current)setBusy(false)}}
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;const job=currentJob.current;if(job)void planningService.cancel(project.id,job.id).catch(()=>{})}},[project.id,entryMode]);
 async function action(operation:()=>Promise<void|boolean>,conversation=false,preserveNotice=false):Promise<boolean>{
  if(acting.current)return false;
  acting.current=true;setBusy(true);setError('');if(!preserveNotice)setNotice('');if(conversation)setConversationError('');
  try{return await operation()!==false}catch(cause){
   if(mounted.current){
    if(generationActive.current)setGenerationError(planningGenerationMessage(cause,language));
    else (conversation?setConversationError:setError)(planningMessage(cause,language));
   }
   return false;
  }finally{acting.current=false;if(mounted.current){setBusy(false);setWorking(false);setWorkingLabel(undefined)}}
 }
 useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(''),6000);return()=>window.clearTimeout(timer)},[notice]);
 async function save(current=stateRef.current){if(!current||!draftRef.current)return current;if(learningRead)throw new Error('PLANNING_STORAGE_UNAVAILABLE');const next=await planningService.save(current,draftRef.current);accept(next);return next}
 function updateOptions(options:AgentOptions){void action(async()=>{let current=stateRef.current;if(dirtyRef.current)current=await save();if(current)accept(await planningService.options(current,options))})}
 function updateProvider(provider:ProviderId){
  void action(async()=>{
   const current=stateRef.current;
   if(!current||current.provider===provider)return;
   const next=await planningService.provider(current,provider);
   if(mounted.current){setState(next);stateRef.current=next}
  },false,true);
 }
 function setRoute(route:RouteDocument){if(learningRead)return;setDraft(route);draftRef.current=route;setDirty(true);dirtyRef.current=true;setNotice('')}
 function captureGeneration(job:PlanningJob){
  if(!mounted.current||!generationActive.current||!['generate','consistency'].includes(job.intent))return;
  setGenerationEntries(previous=>mergeGenerationOutput(previous,job));
  const stage=generationStage(job);
  setRouteGenerationStage(previous=>stage.phase==='prepare'&&previous.phase!=='prepare'?previous:stage);
 }
 async function ai(intent:PlanningIntent,text?:string,mentions?:PlanningMention[],target?:PlanningTarget,replaceExisting=false,generationMode:GenerationMode='new',selected:ResourceItem[]=[],files:PlanningAttachment[]=[]){
  const prefill=intent==='interview'&&text===undefined;
  return action(async()=>{
   let base=stateRef.current;
   if(!base)return false;
   if(dirtyRef.current)base=await save(base);
   if(!base)return false;
   const prefillLabel=prefill?translate(language,'正在整理已有回答…','Checking earlier answers…'):undefined;
   const label=(job:PlanningJob)=>prefillLabel??planningProgress(job,language);
   setWorking(true);setPartialReply(undefined);setPartialProviderId(base.provider);setActivity(undefined);
   if(prefillLabel)setWorkingLabel(prefillLabel);
   try{
    let job=await planningService.begin(base,intent,text,mentions,target,replaceExisting,generationMode,selected.map(resourceRef),files);
    if(!mounted.current){if(job.state==='pending')await planningService.cancel(project.id,job.id).catch(()=>null);return false}
    currentJob.current=job;captureGeneration(job);setWorkingLabel(label(job));if(!generationActive.current)setPartialReply(job.partialReply);setActivity(job.activity);
    const saved=await planningService.read(project.id).catch(()=>null);if(saved)accept(saved);
    while(job.state==='pending'&&mounted.current){
     await new Promise(resolve=>window.setTimeout(resolve,200));
     if(!mounted.current)break;
     job=await planningService.job(project.id,job.id);currentJob.current=job;captureGeneration(job);
     if(mounted.current){setWorkingLabel(label(job));setActivity(job.state==='completed'?undefined:job.activity);if(!generationActive.current)setPartialReply(previous=>job.state==='completed'?undefined:job.partialReply??previous)}
    }
    currentJob.current=null;
    if(job.result)accept(job.result);else{const latest=await planningService.read(project.id);if(latest)accept(latest)}
    if(job.state==='failed'){
     if(mounted.current&&generationActive.current&&job.qualityReason)setGenerationBlock({qualityReason:job.qualityReason,qualitySummary:job.qualitySummary});
     if(job.userReply||job.qualityReason)setPartialReply(undefined);
     throw planningFailure(job);
    }
    if(job.state==='cancelled'){if(mounted.current)setNotice(translate(language,'已停止','Stopped'));return false}
   }catch(cause){
    const active=currentJob.current;currentJob.current=null;
    if(active?.state==='pending')await planningService.cancel(project.id,active.id).catch(()=>null);
    const latest=await planningService.read(project.id).catch(()=>null);if(latest)accept(latest);
    throw cause;
   }
  },true,prefill);
 }
 async function confirmAnswer(id:QuestionId,messageId:string){
  let revision:number|undefined;
  const confirmed=await action(async()=>{
   setPartialReply(undefined);setActivity(undefined);setConversationError('');
   const current=stateRef.current;if(!current)return false;
   const updates=answerConfirmation(current,id)?.changes??[];
   const next=await planningService.acceptAnswer(current,id,messageId);
   revision=next.revision;accept(next);
   if(updates.length){
    const labels=updates.map(change=>questionLabel(change.questionId,language)).join(language==='en'?', ':'、');
    setNotice(translate(language,`${labels}已同步更新`,`${labels} updated`));
   }
  });
  const next=stateRef.current;
  if(confirmed&&mounted.current&&next?.projectId===project.id&&next.revision===revision&&window.vibeNative?.projects&&canPrefillInterview(next))await ai('interview');
 }
 async function generate(replaceExisting=false,generationMode:GenerationMode='new',selected:ResourceItem[]=[]){
  if(acting.current||!stateRef.current||!canRequestGeneration(stateRef.current))return false;
  const provided=generationMode==='resume'?stateRef.current.resourceSnapshot?.items.length??0:selected.length;
  const restored=generationMode==='resume'?generationProgress(stateRef.current):null;
  setRouteGenerationStage(restored?.resumable
    ?{phase:restored.completed===restored.total?'review':'lessons',completed:restored.completed,total:restored.total}
    :{phase:'prepare'});
  generationActive.current=true;generationCancelled.current=false;setGenerationEntries([]);setGenerationError('');setGenerationBlock(undefined);setActivity(undefined);setWorkingLabel(undefined);setGenerationOpen(true);setGenerationRunning(true);
  try{
   const result=await generateWithConsistency(()=>mounted.current&&!generationCancelled.current?stateRef.current:null,(intent,replace,mode)=>
     ai(intent,undefined,undefined,undefined,replace??false,mode,intent==='generate'?selected:[]),replaceExisting,generationMode);
   if(mounted.current&&result&&stateRef.current?.step==='editor'){
     setGenerationOpen(false);
     if(provided){
       const next=stateRef.current,links=next.routeMaterials?.find(entry=>entry.routeId===next.routeDraft?.id)?.links??[];
       const linked=new Set(links.map(link=>link.id)).size;
       setNotice(translate(language,'已关联 '+linked+' / '+provided+' 项参考资料',linked+' / '+provided+' resources linked'));
     }
   }
   return result;
  }finally{generationActive.current=false;if(mounted.current)setGenerationRunning(false)}
 }
 async function requestGeneration(mode:NewGenerationMode='new',replaceExisting=false){
  const current=stateRef.current;
  if(checkingResources.current||generationActive.current||acting.current||!current||!canRequestGeneration(current))return;
  if(current.routeDraft?.chapters.length&&!replaceExisting){
   setGenerationConfirmation(mode);
   return;
  }
  checkingResources.current=true;setPreparingGeneration(true);
  let items:ResourceItem[];
  try{
   items=await resources.refresh().catch(()=>[]);
  }finally{
   checkingResources.current=false;
   if(mounted.current)setPreparingGeneration(false);
  }
  if(!mounted.current||stateRef.current?.revision!==current.revision)return;
  void generate(replaceExisting,mode,items.filter(isResourceUsable));
 }

 function linkedTo(target:AttachmentTarget){
  return (stateRef.current?.routeMaterials?.find(entry=>entry.routeId===draftRef.current?.id)?.links??[])
    .filter(link=>link.kind===target.kind&&link.targetId===target.targetId);
 }
 async function updateMaterial(target:AttachmentTarget,item:{id:string;version:string},add:boolean,segmentId?:string){
  let failed:unknown;
  const done=await action(async()=>{
   try{
    const saved=dirtyRef.current?await save():stateRef.current;
    if(!saved?.routeDraft)return false;
    accept(await resourceService.bind(saved,saved.routeDraft.id,target,item,add,segmentId));
   }catch(cause){if(!add)throw cause;failed=cause;return false}
  });
  if(failed)throw failed;
  return done;
 }

 function cancel(){const job=currentJob.current;if(job)void planningService.cancel(project.id,job.id).catch(cause=>{if(mounted.current)(generationActive.current?setGenerationError:setConversationError)(planningMessage(cause,language))})}
 function previous(){const current=stateRef.current;if(current?.step==='editor'&&current.provider&&!current.importedOriginal&&current.messages.some(message=>message.questionId)){void action(async()=>{let saved=stateRef.current;if(dirtyRef.current)saved=await save();if(saved)accept(await planningService.reopenIntake(saved))})}else leave(onPrevious)}
 function leave(callback:()=>void){if(working)return;if(dirtyRef.current)void action(async()=>{await save();callback()});else callback()}
 async function confirm(){
  const saved=dirtyRef.current?await save():stateRef.current;
  if(!saved?.routeDraft)return;
  const next=await planningService.confirm(saved);
  accept(next);
  if(mounted.current&&next.routeDraft)onConfirmed?.(next.routeDraft);
 }
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const saveResourceNotes=(value:string)=>action(async()=>{if(stateRef.current)accept(await planningService.resources(stateRef.current,value))});
 if(!state)return <section className="planning-page planning-page--intake"><div className="planning-stage planning-stage--intake"><div className="planning-intake-scroll" aria-hidden="true"/><div className="planning-loading"><h1>{translate(language,'规划路线','Plan your route')}</h1>{busy?<LoaderCircle aria-label={translate(language,'读取中','Loading')}/>:<><p className="form-message is-error">{error}</p><GameButton onClick={()=>void load()}>{translate(language,'重试','Retry')}</GameButton><BackHomeButton language={language} onClick={onHome}/></>}</div></div></section>;
 const materialSummary=resources.items.length?t('已添加 '+resources.items.length+' 项',resources.items.length+' added')
   :resources.error?t('读取失败','Could not load')
   :resources.loaded?t('未添加','None added'):t('读取中…','Loading…');
 let draftChange:'added'|'removed'|undefined;
 if(state.generationDraft&&resources.loaded&&!resources.error){
  const saved=new Set((state.resourceSnapshot?.items??[]).map(resourceKey));
  const readable=new Set(resources.items.filter(isResourceUsable).map(resourceKey));
  if([...saved].some(key=>!readable.has(key)))draftChange='removed';
  else if([...readable].some(key=>!saved.has(key)))draftChange='added';
 }
 const progress=generationOpen?generationProgress(state):null;
 const savedGeneration=progress&&draftChange==='removed'?{...progress,resumable:false}:progress;
 return <>{state.step==='editor'&&draft?<RouteEditorSurface language={language} state={state} route={draft} busy={busy} working={working} workingLabel={workingLabel} partialReply={partialReply} partialProviderId={partialProviderId} activity={activity} dirty={dirty} error={error} conversationError={conversationError} notice={notice} onOptions={updateOptions} onProvider={updateProvider} onRoute={setRoute} onSave={()=>void action(async()=>{await save();setNotice(translate(language,'草稿已保存','Draft saved'))})} onConfirm={()=>void action(confirm)} onSend={(text,mentions,target,files)=>ai('edit',text,mentions,target,false,'new',[],files)} onCancel={cancel} onApply={()=>void action(async()=>{if(stateRef.current)accept(await planningService.applyProposal(stateRef.current))})} onDiscard={()=>void action(async()=>{if(stateRef.current)accept(await planningService.discardProposal(stateRef.current))})} onUndo={()=>void action(async()=>{const current=dirtyRef.current?await save():stateRef.current;if(current)accept(await planningService.undo(current))})} onRedo={()=>void action(async()=>{if(stateRef.current)accept(await planningService.redo(stateRef.current))})} onRemoveImport={()=>void action(async()=>{const route=await routeService.read(project.id);setRemoveImport(route.revision)})} onPrevious={previous} onHome={()=>leave(onHome)}
  studiedNodeIds={learningProgress?.startedNodeIds} learningRead={learningRead} onRetryLearning={()=>setProgressRetry(value=>value+1)}
  onResetLearning={onResetLearning&&savedRoute&&learningProgress&&learningProgress.recordedNodeCount>0?()=>onResetLearning(savedRoute,learningProgress):undefined}
  renderMaterials={resources.enabled?(target,locked)=><ResourceAttachments projectId={project.id} language={language}
    items={attachmentsFrom(linkedTo(target),[...resources.items,...(materialData?.items??[])])}
    onChoose={locked?undefined:()=>setAttachmentTarget(target)}
    onRemove={locked?undefined:link=>void updateMaterial(target,link,false,link.segmentId)}/>:undefined}
 />:<PlanningIntakeSurface language={language} state={state} busy={busy||preparingGeneration||generationRunning} working={working&&!generationOpen} workingLabel={generationOpen?undefined:workingLabel} partialReply={generationOpen?undefined:partialReply} partialProviderId={partialProviderId} activity={generationOpen?undefined:activity} error={generationOpen?'':conversationError||error} notice={notice}
  generationStatus={generationRunning?workingLabel??t('正在准备生成…','Preparing generation…'):undefined}
  generationFailed={Boolean(generationError)} onOptions={updateOptions} onProvider={updateProvider} onSend={(text,files)=>ai('interview',text,undefined,undefined,false,'new',[],files)} onCancel={cancel}
  onFocus={id=>void action(async()=>{setPartialReply(undefined);setActivity(undefined);setConversationError('');if(stateRef.current)accept(await planningService.focus(stateRef.current,id))})}
  onAccept={(id,messageId)=>void confirmAnswer(id,messageId)} onRestart={()=>setRestartReview(true)} onReanswer={id=>setReanswerReview(id)}
  onAdoptSuggestion={issueId=>void action(async()=>{setPartialReply(undefined);setActivity(undefined);setConversationError('');if(stateRef.current)accept(await planningService.adoptSuggestion(stateRef.current,issueId))})}
  materials={resources.enabled?{summary:materialSummary,onOpen:()=>setResourceDialog(true),draftChange}:undefined}
  onResources={saveResourceNotes} onGenerate={()=>void requestGeneration()} onResume={()=>void generate(true,'resume')} onRegenerate={()=>void requestGeneration('restart')} onManual={()=>void action(async()=>{if(stateRef.current)accept(await planningService.openEditor(stateRef.current))})} onPrevious={previous} onHome={()=>leave(onHome)}/>}
 {resourceDialog&&<PlanningResourcesDialog state={state} language={language} limits={resources.limits}
    onSaved={async()=>{await resources.refresh().catch(()=>{});setResourceDialog(false)}}
    onClose={()=>setResourceDialog(false)}/>}
 {attachmentTarget&&<ResourcePicker projectId={project.id} language={language} bindings={linkedTo(attachmentTarget)} busy={busy}
    onAdd={(item,segmentId)=>updateMaterial(attachmentTarget,item,true,segmentId)} onClose={()=>setAttachmentTarget(undefined)}/>}
 {generationOpen&&!generationConfirmation&&<PlanningGenerationDialog language={language} entries={generationEntries} stage={routeGenerationStage} running={generationRunning} activity={activity} label={workingLabel} error={generationError} qualityReason={generationBlock?.qualityReason} qualitySummary={generationBlock?.qualitySummary} reviewNeeded={state.questions.some(question=>question.status==='needs-review')} onStop={()=>{generationCancelled.current=true;cancel()}} savedProgress={savedGeneration??undefined} onResume={()=>void generate(true,'resume')} onRestart={()=>void requestGeneration('restart')} onClose={()=>{setGenerationOpen(false);setActivity(undefined)}}/>}
 {reanswerReview&&<Modal title={translate(language,'重新回答','Answer again')} closeLabel={translate(language,'关闭','Close')} busy={busy} onClose={()=>setReanswerReview(null)}><p className="confirmation-copy">{translate(language,`重新回答“${questionLabel(reanswerReview,'zh-CN')}”将清空该问题及之后所有问题的回答，之前已确认的回答会保留。是否继续？`,`Answering “${questionLabel(reanswerReview,'en')}” again will clear this answer and all later answers. Earlier confirmed answers will be kept. Continue?`)}</p>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setReanswerReview(null)}>{translate(language,'取消','Cancel')}</GameButton><GameButton disabled={busy} onClick={()=>void action(async()=>{if(stateRef.current){accept(await planningService.reanswer(stateRef.current,reanswerReview));setPartialReply(undefined);setActivity(undefined);setConversationError('');setReanswerReview(null)}})}>{translate(language,'重新回答','Answer again')}</GameButton></div></Modal>}
 {restartReview&&<Modal title={translate(language,'重新采集','Start over')} closeLabel={translate(language,'关闭','Close')} busy={busy} onClose={()=>setRestartReview(false)}><p className="confirmation-copy">{translate(language,'清空全部回答并从头开始？','Clear all answers and start over?')}</p><div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setRestartReview(false)}>{translate(language,'取消','Cancel')}</GameButton><GameButton disabled={busy} onClick={()=>void action(async()=>{if(stateRef.current){accept(await planningService.restartIntake(stateRef.current));setPartialReply(undefined);setActivity(undefined);setConversationError('');setRestartReview(false)}})}>{translate(language,'重新采集','Start over')}</GameButton></div></Modal>}
 {generationConfirmation&&<Modal className="planning-generation-confirmation" title={t('重新生成路线','Regenerate route')} closeLabel={t('关闭','Close')} onClose={()=>setGenerationConfirmation(null)} focusHeading>
    <p className="confirmation-copy">{t('新路线生成后会覆盖当前路线。','The new route will replace your current route once generation completes.')}</p>
    <div className="confirmation-actions">
     <GameButton variant="secondary" onClick={()=>setGenerationConfirmation(null)}>{t('取消','Cancel')}</GameButton>
     <GameButton onClick={()=>{setGenerationConfirmation(null);void requestGeneration(generationConfirmation,true)}}>{t('生成路线','Generate route')}</GameButton>
    </div>
 </Modal>}
 {removeImport!==null&&<Modal title={translate(language,'删除导入路线','Delete imported route')} closeLabel={translate(language,'关闭','Close')} onClose={()=>setRemoveImport(null)} busy={busy}><p className="confirmation-copy">{translate(language,'删除项目中的导入路线及其编辑草稿，原路线文件保留。','Delete the imported route and its edited draft from this project. The original file is kept.')}</p>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setRemoveImport(null)}>{translate(language,'取消','Cancel')}</GameButton><GameButton variant="danger" disabled={busy} onClick={()=>void action(async()=>{const next=await planningService.removeImport(project.id,state.revision,removeImport);if(next)accept(next);setRemoveImport(null);onPrevious()})}>{translate(language,'删除路线','Delete route')}</GameButton></div></Modal>}
 {importReview!==null&&<Modal title={translate(language,'替换当前路线','Replace current route')} closeLabel={translate(language,'关闭','Close')} onClose={()=>setImportReview(null)} busy={busy}><p className="confirmation-copy">{translate(language,'用导入路线替换当前章节？可通过撤销恢复。','Replace the current chapters with this import? Undo can restore them.')}</p><p className="confirmation-copy">{importReview}</p>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setImportReview(null)}>{translate(language,'取消','Cancel')}</GameButton><GameButton disabled={busy} onClick={()=>void action(async()=>{if(stateRef.current){accept(await planningService.enter(project.id,language,'import',stateRef.current.revision));setImportReview(null)}})}>{translate(language,'确认替换','Replace')}</GameButton></div></Modal>}
 </>;
}
