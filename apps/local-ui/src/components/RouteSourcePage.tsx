import {useEffect,useId,useRef,useState} from 'react';
import {BadgeCheck,CloudDownload} from 'lucide-react';
import {translate,type Language} from '../i18n';
import {agentService} from '../agents/service';
import type {AgentChoice} from '../agents/domain';
import type {ProjectRecord} from '../projects/domain';
import {routeService,routeMessage,type RoutePreparation,type RouteStage} from '../routes/service';
import {planningService,planningMessage,type PlanningEntry} from '../planning/service';
import {summarizeRoute,type RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import Modal from './Modal';
import GameButton,{GameButtonArt} from './GameButton';
import BackHomeButton from './BackHomeButton';
import GameToggle from './GameToggle';
import './routes.css';

const ASSET=import.meta.env.BASE_URL+'assets/images/';
type SurfaceProps={language:Language;source:'create'|'import';ai:boolean;canUseAI:boolean;busy?:boolean;error?:string;draftTitle?:string;onRetry?:()=>void;onSource:(source:'create'|'import')=>void;onAI:(value:boolean)=>void;onPrevious:()=>void;onHome:()=>void;onNext:()=>void;onPreview:()=>void;onDelete?:()=>void};
export function RouteSourceSurface({language,source,ai,canUseAI,busy=false,error='',draftTitle,onRetry,onSource,onAI,onPrevious,onHome,onNext,onPreview,onDelete}:SurfaceProps){
  const t=(zh:string,en:string)=>translate(language,zh,en);
  const switchId=useId();
  return <section className="route-page"><div className="route-stage">
    <img className="route-world" src={ASSET+'route-grassland-base-v2.png'} alt="" draggable={false}/>
    <BackHomeButton language={language} className="route-home" onClick={onHome}/>
    <h1 className="route-source-title">{t('选择路线','Choose a route')}</h1>
    <div className="route-ai-control"><GameButtonArt variant="secondary"/><label htmlFor={switchId}>{t('AI 辅助','AI assistance')}</label><GameToggle id={switchId} label={t('AI 辅助','AI assistance')} checked={ai&&canUseAI} disabled={!canUseAI||busy} onChange={onAI}/></div>
    {(['create','import'] as const).map(kind=><button key={kind} type="button" className={`route-stone route-stone--${kind} ${source===kind?'is-selected':''}`} aria-pressed={source===kind} disabled={busy} onClick={()=>onSource(kind)}>
      <span className="route-stone-art"><img src={ASSET+(kind==='create'?'route-stone-create-v1.png':'route-stone-import-v1.png')} alt="" draggable={false}/></span>
      <span className="route-stone-label">{kind==='create'?t('创建路线','Create route'):t('导入路线','Import route')}</span>
      {source===kind&&<BadgeCheck className="route-stone-check" aria-hidden="true"/>}
    </button>)}
    <div className={`route-source-feedback ${draftTitle?'has-draft':''}`} aria-live="polite">{error?<><p className="form-message is-error" role="alert">{error}</p>{onRetry&&<button className="text-button" type="button" onClick={onRetry}>{t('重新读取','Reload')}</button>}</>:draftTitle?<><button className="text-button" type="button" title={t('已保存路线：','Saved route: ')+draftTitle} onClick={onPreview}>{t('已保存路线：','Saved route: ')}{draftTitle}</button>{onDelete&&<GameButton variant="danger" disabled={busy} onClick={onDelete}>{t('删除路线','Delete route')}</GameButton>}</>:null}</div>
    <footer className="route-source-footer"><GameButton variant="secondary" onClick={onPrevious} disabled={busy}>{t('上一步','Previous')}</GameButton><GameButton onClick={onNext} disabled={busy}>{busy?t('保存中…','Saving…'):t('下一步','Next')}</GameButton></footer>
  </div></section>;
}
export function RouteImportDialog({language,busy=false,error='',onClose,onChoose}:{language:Language;busy?:boolean;error?:string;onClose:()=>void;onChoose:()=>void}){
  const t=(zh:string,en:string)=>translate(language,zh,en);
  return <Modal title={t('导入路线','Import route')} closeLabel={t('关闭','Close')} onClose={onClose} busy={busy} className="route-import-dialog">
    <div className="route-import-options">
      <section className="route-import-online" aria-disabled="true"><CloudDownload aria-hidden="true" strokeWidth={2.4}/><h3>{t('在线路线','Online routes')}</h3><span>{t('暂未开放','Unavailable')}</span></section>
      <section className="route-import-local"><span className="route-local-icon"><img src={ASSET+'route-local-folder-v1.png'} alt=""/></span><h3>{t('本地路线','Local route')}</h3><GameButton onClick={onChoose} disabled={busy}>{busy?t('读取中…','Reading…'):t('选择文件','Choose file')}</GameButton></section>
    </div>
    {error&&<p className="form-message is-error" role="alert">{error}</p>}
    <div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={onClose}>{t('取消','Cancel')}</GameButton></div>
  </Modal>;
}
export function RoutePreviewDialog({language,route,fileName,busy=false,error='',saved=false,onClose,onSave,onChoose,onContinue}:{language:Language;route:RouteDocument;fileName:string;busy?:boolean;error?:string;saved?:boolean;onClose:()=>void;onSave:()=>void;onChoose:()=>void;onContinue?:()=>void}){
  const t=(zh:string,en:string)=>translate(language,zh,en),summary=summarizeRoute(route);
  return <Modal title={t('路线预览','Route preview')} closeLabel={t('关闭','Close')} onClose={onClose} busy={busy} className="route-preview-dialog">
    <header className="route-preview-header"><h3>{route.title}</h3><span>{t(`${summary.chapters} 个大章节 · ${summary.nodes} 个小章节`,`${summary.chapters} chapters · ${summary.nodes} lessons`)}</span><small>{fileName}</small></header>
    <div className="route-preview-chapters">{route.chapters.map((chapter,index)=><details key={chapter.id} open={index===0}><summary>{chapter.title}<span>{t(`${chapter.nodes.length} 节`,`${chapter.nodes.length} ${chapter.nodes.length===1?'lesson':'lessons'}`)}</span></summary><ol>{chapter.nodes.map(node=><li key={node.id}><strong>{node.title}</strong><ul>{node.objectives.map(objective=><li key={objective.id}>{objective.description}</li>)}</ul>{node.assessment&&<details className="route-preview-assessment"><summary>{t('验收标准','Completion criteria')}</summary><p>{node.assessment.task}</p><ul>{node.assessment.passCriteria.map(criterion=><li key={criterion}>{criterion}</li>)}</ul></details>}</li>)}</ol></details>)}</div>
    {error&&<p className="form-message is-error" role="alert">{error}</p>}
    <div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={onChoose}>{t('重新选择','Choose another')}</GameButton><GameButton disabled={busy} onClick={saved?(onContinue??onClose):onSave}>{busy?t('保存中…','Saving…'):t('编辑章节','Edit chapters')}</GameButton></div>
  </Modal>;
}
export default function RouteSourcePage({language,project,onPrevious,onHome,onPlanning}:{language:Language;project:ProjectRecord;onPrevious:()=>void;onHome:()=>void;onPlanning:(mode:PlanningEntry)=>void}){
  const [state,setState]=useState<RoutePreparation|null>(null),[choice,setChoice]=useState<AgentChoice|null>(null),[source,setSource]=useState<'create'|'import'>('create'),[ai,setAI]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState(''),[modal,setModal]=useState<'import'|'preview'|'remove'|'replace-source'|null>(null),[stage,setStage]=useState<RouteStage|null>(null);
  const sourceReview=useRef<{kind:'create'|'import';revision:number}|null>(null);
  const deletion=useRef<{routeRevision:number;planningRevision:number|null}|null>(null);
  const mounted=useRef(true),acting=useRef(false),file=useRef<HTMLInputElement>(null),pending=useRef<RouteStage|null>(null);
  const t=(zh:string,en:string)=>translate(language,zh,en),canUseAI=Boolean(choice&&choice!=='manual');
  async function load(){setBusy(true);try{const [saved,agent]=await Promise.all([routeService.read(project.id),agentService.choice(project.id)]);if(mounted.current){setState(saved);setChoice(agent);setSource(saved.source??'create');setAI(agent!=='manual'&&Boolean(agent)&&(saved.source===null?true:saved.aiAssisted));setError('')}}catch(cause){if(mounted.current)setError(routeMessage(cause,language))}finally{if(mounted.current)setBusy(false)}}
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;const value=pending.current;if(value)void routeService.cancelImport(project.id,value.importId).catch(()=>{})}},[project.id]);
  async function action(operation:()=>Promise<void>){if(acting.current)return;acting.current=true;setBusy(true);setError('');try{await operation()}catch(cause){if(mounted.current)setError(String(cause).includes('PLANNING_')?planningMessage(cause,language):routeMessage(cause,language))}finally{acting.current=false;if(mounted.current)setBusy(false)}}
  async function begin(kind:'create'|'import',confirmed=false){if(!state)return;await action(async()=>{
    const plan=await planningService.read(project.id),changed=state.source!==null&&state.source!==kind;
    if(changed&&plan?.routeDraft?.chapters.length&&!confirmed){sourceReview.current={kind,revision:plan.revision};setModal('replace-source');return}
    if(confirmed&&(!sourceReview.current||sourceReview.current.kind!==kind||sourceReview.current.revision!==plan?.revision))throw new Error('PLANNING_CONFLICT');
    if(changed&&kind==='create'&&!(ai&&canUseAI)&&plan)await planningService.resetEditor(plan);
    const next=await routeService.choose(state,kind,ai&&canUseAI);
    sourceReview.current=null;
    if(mounted.current){setState(next);if(kind==='create'){setModal(null);onPlanning(ai&&canUseAI?'ai':'manual')}else if(next.routeDraft&&!changed){setModal(null);onPlanning('import')}else setModal('import')}
  })}
  async function close(){if(busy)return;const value=pending.current;pending.current=null;setStage(null);setError('');setModal(null);if(value)await routeService.cancelImport(project.id,value.importId).catch(()=>{})}
  async function local(){if(acting.current)return;if(!window.vibeNative?.projects){file.current?.click();return}await action(async()=>{const selected=await routeService.chooseNative(project.id);if(selected){if(mounted.current){pending.current=selected;setStage(selected);setModal('preview')}else await routeService.cancelImport(project.id,selected.importId)}})}
  async function selectedFile(selected:File){await action(async()=>{const value=await routeService.stageFile(project.id,selected);if(mounted.current){pending.current=value;setStage(value);setModal('preview')}else await routeService.cancelImport(project.id,value.importId)})}
  async function save(){if(!state||!stage)return;await action(async()=>{const next=await routeService.saveImport(state,stage);if(mounted.current){setState(next);setStage(null);pending.current=null;setModal(null);onPlanning('import')}})}
  async function reviewDelete(){if(!state?.routeDraft)return;await action(async()=>{const saved=await planningService.read(project.id);deletion.current={routeRevision:state.revision,planningRevision:saved?.revision??null};setModal('remove')})}
  async function remove(){const target=deletion.current;if(!target)return;await action(async()=>{await planningService.removeImport(project.id,target.planningRevision,target.routeRevision);const next=await routeService.read(project.id);if(mounted.current){setState(next);setSource('create');setModal(null);setStage(null);pending.current=null;deletion.current=null}})}
  const draft=stage??state?.routeDraft;
  return <><RouteSourceSurface language={language} source={source} ai={ai} canUseAI={canUseAI} busy={busy||!state} error={!modal?error:''} draftTitle={state?.routeDraft?.route.title} onRetry={!state?()=>void load():undefined} onSource={setSource} onAI={setAI} onPrevious={onPrevious} onHome={onHome} onNext={()=>void begin(source)} onPreview={()=>setModal('preview')} onDelete={()=>void reviewDelete()}/>
    <input className="route-file-input" ref={file} type="file" accept=".json,application/json" aria-label={t('选择路线文件','Choose route file')} onChange={event=>{const value=event.target.files?.[0];event.target.value='';if(value)void selectedFile(value)}}/>
    {modal==='replace-source'&&<Modal title={t('更换路线来源','Change route source')} closeLabel={t('关闭','Close')} busy={busy} onClose={()=>void close()}><p className="confirmation-copy">{t('已生成的路线会被覆盖，是否确定？','Your existing route will be replaced. Continue?')}</p>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>void close()}>{t('取消','Cancel')}</GameButton><GameButton disabled={busy} onClick={()=>void begin(source,true)}>{t('确定','Confirm')}</GameButton></div></Modal>}
    {modal==='remove'&&<Modal title={t('删除导入路线','Delete imported route')} closeLabel={t('关闭','Close')} busy={busy} onClose={()=>void close()}><p className="confirmation-copy">{t('删除项目中的导入路线及其编辑草稿，原路线文件保留。','Delete the imported route and its edited draft from this project. The original file is kept.')}</p>{error&&<p className="form-message is-error" role="alert">{error}</p>}<div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>void close()}>{t('取消','Cancel')}</GameButton><GameButton variant="danger" disabled={busy} onClick={()=>void remove()}>{t('删除路线','Delete route')}</GameButton></div></Modal>}
    {modal==='import'&&<RouteImportDialog language={language} busy={busy} error={error} onClose={()=>void close()} onChoose={()=>void local()}/>}
    {modal==='preview'&&draft&&<RoutePreviewDialog language={language} route={draft.route} fileName={draft.fileName} busy={busy} error={error} saved={!stage} onClose={()=>void close()} onContinue={()=>onPlanning('import')} onChoose={()=>{void close().then(()=>setModal('import'))}} onSave={()=>void save()}/>}
  </>;
}
