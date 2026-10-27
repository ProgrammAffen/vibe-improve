import {useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {FolderOpen, RefreshCw} from 'lucide-react';
import GameButton from './GameButton';
import BackHomeButton from './BackHomeButton';
import Modal from './Modal';
import {translate, type Language} from '../i18n';
import {projectService} from '../projects/service';
import {projectErrorCode, projectMessage, selectProjects, validProjectName, type DirectoryChoice, type ProjectRecord} from '../projects/domain';
import {projectNameLabel} from '../projects/presentation';
import './projects.css';

const ASSET=import.meta.env.BASE_URL+'assets/images/';
function ProjectButton({children,...props}: Parameters<typeof GameButton>[0]) {
  return <GameButton {...props}>{children}</GameButton>;
}
function ProjectWorld({kind,language,onBack,children}: {kind:'list'|'create';language:Language;onBack:()=>void;children:ReactNode}) {
  return <section className={'project-page project-page--'+kind} data-layout-region={'project-'+kind}>
    <div className="project-stage">
      <img className="project-background" src={ASSET+(kind==='list'?'project-grassland-scene-v2.png':'project-create-blackboard-scene-v1.png')} alt="" draggable={false}/>
      <BackHomeButton language={language} className="project-back" onClick={onBack}/>
      {children}
    </div>
  </section>;
}
function Panel({children,className=''}:{children:ReactNode;className?:string}) {
  return <section className={'project-panel '+className}><div className="project-panel-content">{children}</div></section>;
}
function Failure({error,language}:{error:string;language:Language}) {
  return error ? <p className="project-error" role="alert">{projectMessage(projectErrorCode(error),language==='en')}</p> : null;
}
function recentDate(value:string,language:Language) {
  const date=new Date(value),now=new Date();
  if(!Number.isFinite(date.getTime()))return '—';
  const day=new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  if(day===today)return translate(language,'今天','Today');
  if(day===today-86400_000)return translate(language,'昨天','Yesterday');
  return new Intl.DateTimeFormat(language,{month:'short',day:'numeric',...(date.getFullYear()!==now.getFullYear()&&{year:'numeric'})}).format(date);
}
export type ProjectListSurfaceProps={
  language:Language;records:ProjectRecord[];loading?:boolean;busy?:boolean;error?:string;
  onBack:()=>void;onNew:()=>void;onOpen:(record:ProjectRecord)=>void;onLocate:(record:ProjectRecord)=>void;onRemove:(record:ProjectRecord)=>void;onRetry:()=>void;
};
export function ProjectListSurface({language,records,loading=false,busy=false,error='',onBack,onNew,onOpen,onLocate,onRemove,onRetry}:ProjectListSurfaceProps) {
  const t=(zh:string,en:string)=>translate(language,zh,en);
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
  const scroller=useRef<HTMLDivElement>(null);
  const ordered=selectProjects(records,'','recent');
  const pageCount=Math.max(1,Math.ceil(ordered.length/pageSize)),currentPage=Math.min(page,pageCount);
  const visible=ordered.slice((currentPage-1)*pageSize,currentPage*pageSize);
  useLayoutEffect(()=>{setPage(currentPage);if(scroller.current)scroller.current.scrollTop=0},[currentPage,pageSize]);
  return <ProjectWorld kind="list" language={language} onBack={onBack}>
    <Panel className="project-list-panel">
      <header className="project-list-toolbar">
        <h1>{t('项目列表','Project list')}</h1>
      </header>
      <Failure error={error} language={language}/>
      {error&&records.length>0&&<div className="project-list-recovery"><ProjectButton variant="secondary" leadingIcon={<RefreshCw/>} disabled={busy||loading} onClick={onRetry}>{t('重新读取','Reload')}</ProjectButton></div>}
      <div className="project-list-scroll" ref={scroller} tabIndex={0} role="region" aria-label={t('滚动浏览项目','Scroll projects')} aria-busy={loading} data-layout-region="project-list-scroll">
        <table className="project-table">
          <colgroup><col className="project-col-name"/><col className="project-col-progress"/><col className="project-col-date"/><col className="project-col-action"/></colgroup>
          <thead><tr><th scope="col">{t('项目','Project')}</th><th scope="col">{t('学习进度','Learning progress')}</th><th scope="col">{t('最近打开','Last opened')}</th><th scope="col"><span className="project-sr-only">{t('操作','Actions')}</span></th></tr></thead>
          <tbody>{visible.map(record=><tr key={record.id} className={!record.available?'is-unavailable':''}>
            <th scope="row"><button type="button" className="text-button project-record-name" title={record.name} aria-label={t('打开项目：','Open project: ')+record.name} disabled={busy} onClick={()=>record.available?onOpen(record):onLocate(record)}>{projectNameLabel(record.name)}</button></th>
            <td>{record.totalNodes>0?<div className="project-progress"><progress aria-label={t('章节完成进度','Chapter progress')} max={record.totalNodes} value={record.completedNodes}/><span>{record.completedNodes} / {record.totalNodes}</span></div>:<span className="project-pending">{t('待规划','Not planned')}</span>}</td>
            <td><time dateTime={record.lastOpenedAt}>{recentDate(record.lastOpenedAt,language)}</time></td>
            <td><div className="project-row-actions"><ProjectButton variant={record.available?'primary':'secondary'} className="project-open" aria-label={t('打开项目：','Open project: ')+record.name} onClick={()=>record.available?onOpen(record):onLocate(record)} disabled={busy}>{record.available?t('打开','Open'):t('重新定位','Locate folder')}</ProjectButton><ProjectButton variant="danger" className="project-delete" aria-label={t('删除项目：','Delete project: ')+record.name} onClick={()=>onRemove(record)} disabled={busy}>{t('删除','Delete')}</ProjectButton></div></td>
          </tr>)}</tbody>
        </table>
        {loading?<div className="project-empty" role="status">{t('正在读取项目…','Loading projects…')}</div>:visible.length===0?<div className="project-empty">
          <FolderOpen aria-hidden="true"/>
          <h2>{error?t('项目读取失败','Could not load projects'):t('暂无项目','No projects yet')}</h2>
          {error?<ProjectButton variant="secondary" leadingIcon={<RefreshCw/>} onClick={onRetry} disabled={busy}>{t('重试','Retry')}</ProjectButton>:<ProjectButton onClick={onNew} disabled={busy}>{t('创建项目','Create project')}</ProjectButton>}
        </div>:null}
      </div>
      <footer className="project-pagination" aria-label={t('项目分页','Project pagination')}>
        <span className="project-total">{t(`共 ${records.length} 个项目`,`${records.length} projects`)}</span>
        <label className="project-page-size">{t('每页','Per page')}<select aria-label={t('每页项目数','Projects per page')} value={pageSize} disabled={loading||busy} onChange={event=>{setPageSize(Number(event.target.value));setPage(1)}}>{[5,10,20].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <div className="project-page-navigation"><ProjectButton variant="secondary" disabled={loading||busy||currentPage===1} onClick={()=>setPage(currentPage-1)}>{t('上一页','Previous')}</ProjectButton><span className="project-page-count" aria-live="polite">{t(`第 ${currentPage} / ${pageCount} 页`,`${currentPage} / ${pageCount}`)}</span><ProjectButton variant="secondary" disabled={loading||busy||currentPage===pageCount} onClick={()=>setPage(currentPage+1)}>{t('下一页','Next')}</ProjectButton></div>
      </footer>
    </Panel>
  </ProjectWorld>;
}
export function ProjectListPage({language,onBack,onNew,onOpen}:{language:Language;onBack:()=>void;onNew:()=>void;onOpen:(record:ProjectRecord)=>void}) {
  const [records,setRecords]=useState<ProjectRecord[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useState<ProjectRecord|null>(null),[removalError,setRemovalError]=useState('');
  const mounted=useRef(true),acting=useRef(false);
  async function load(){setLoading(true);try{const result=await projectService.list();if(mounted.current){setRecords(result);setError('');}}catch(cause){if(mounted.current)setError(projectErrorCode(cause));}finally{if(mounted.current)setLoading(false)}}
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false}},[]);
  async function act(action:()=>Promise<unknown>){if(acting.current)return;acting.current=true;setBusy(true);setError('');try{await action()}catch(cause){if(mounted.current)setError(projectErrorCode(cause))}finally{acting.current=false;if(mounted.current)setBusy(false)}}
  async function remove(){
    if(!pending||acting.current)return;
    acting.current=true;setBusy(true);setRemovalError('');
    try{
      await projectService.remove(pending);
      if(mounted.current){setRecords(previous=>previous.filter(item=>item.id!==pending.id));setPending(null)}
    }catch(cause){
      const code=projectErrorCode(cause);
      if(code==='PROJECT_CONFLICT'){
        if(mounted.current)setPending(null);
        try{const refreshed=await projectService.list();if(mounted.current){setRecords(refreshed);setError(code)}}
        catch(refreshFailure){if(mounted.current)setError(projectErrorCode(refreshFailure))}
      }else if(mounted.current)setRemovalError(code);
    }finally{acting.current=false;if(mounted.current)setBusy(false)}
  }
  return <><ProjectListSurface language={language} records={records} loading={loading} busy={busy} error={error} onBack={onBack} onNew={onNew} onRetry={()=>void load()}
    onOpen={record=>void act(async()=>onOpen(await projectService.open(record.id)))}
    onRemove={record=>{if(!acting.current){setRemovalError('');setPending(record)}}}
    onLocate={record=>void act(async()=>{if(record.kind==='project'){if(await projectService.chooseProject(record.id))await load()}else{const parent=await projectService.chooseParent();if(parent){await projectService.update(record,record.name,parent);await load()}}})}/>
    {pending&&<ProjectRemovalDialog language={language} record={pending} busy={busy} error={removalError} onClose={()=>{if(!acting.current)setPending(null)}} onConfirm={()=>void remove()}/>}</>;
}
export function ProjectRemovalDialog({language,record,busy=false,error='',onClose,onConfirm}:{language:Language;record:ProjectRecord;busy?:boolean;error?:string;onClose:()=>void;onConfirm:()=>void}) {
  const t=(zh:string,en:string)=>translate(language,zh,en);
  return <Modal title={t('删除项目','Delete project')} closeLabel={t('关闭','Close')} className="confirmation-dialog project-delete-dialog" busy={busy} onClose={onClose}>
    <strong className="project-delete-name">{record.name}</strong><p className="confirmation-copy">{t('从项目列表移除，项目文件保留。','Remove from the list. Project files are kept.')}</p><Failure error={error} language={language}/>
    <div className="confirmation-actions"><ProjectButton variant="secondary" disabled={busy} onClick={onClose}>{t('取消','Cancel')}</ProjectButton><ProjectButton variant="danger" disabled={busy} onClick={onConfirm}>{busy?t('删除中…','Deleting…'):t('删除','Delete')}</ProjectButton></div>
  </Modal>;
}
export type NewProjectSurfaceProps={
  language:Language;name:string;directory?:DirectoryChoice;existing?:boolean;fixedLocation?:boolean;busy?:boolean;error?:string;nameError?:boolean;disabled?:boolean;
  onName:(value:string)=>void;onChoose:()=>void;onSubmit:(event:FormEvent)=>void;onBlur:()=>void;onBack:()=>void;
};
export function NewProjectSurface({language,name,directory,existing=false,fixedLocation=false,busy=false,error='',nameError=false,disabled=false,onName,onChoose,onSubmit,onBlur,onBack}:NewProjectSurfaceProps) {
  const t=(zh:string,en:string)=>translate(language,zh,en);
  return <ProjectWorld kind="create" language={language} onBack={onBack}>
    <Panel className="project-create-panel">
      <form className="project-form" onSubmit={onSubmit} aria-labelledby="project-form-title">
        <h1 id="project-form-title">{existing?t('项目设置','Project settings'):t('创建项目','Create project')}</h1>
        <div className="project-form-fields">
          <div className="project-input-group project-name-group"><label htmlFor="project-name">{t('项目名称','Project name')}</label><input id="project-name" name="project-name" value={name} onChange={event=>onName(event.target.value)} onBlur={onBlur} maxLength={80} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={nameError} aria-describedby={nameError?'project-name-error':undefined} autoFocus/><div className="project-field-feedback" aria-live="polite"><p className="project-error" id="project-name-error">{nameError?projectMessage('PROJECT_NAME_INVALID',language==='en'):''}</p></div></div>
          <div className="project-input-group"><label htmlFor="project-directory">{t('项目目录','Project location')}</label><div className="project-directory-control"><input id="project-directory" value={directory?.path??''} placeholder={t('选择项目目录','Choose project location')} readOnly title={directory?.path}/>{!fixedLocation&&<button type="button" className="icon-button project-folder-button" onClick={onChoose} disabled={busy} aria-label={t('选择目录','Choose folder')} title={t('选择目录','Choose folder')}><FolderOpen aria-hidden="true" strokeWidth={2.2}/></button>}</div></div>
          <Failure error={error} language={language}/>
          {existing&&<span className="project-form-state">{t('路线待规划','Route not planned')}</span>}
        </div>
        <div className="project-form-actions"><ProjectButton type="submit" disabled={busy||disabled}>{busy?t('保存中…','Saving…'):existing?t('下一步','Next'):t('保存草稿','Save draft')}</ProjectButton></div>
      </form>
    </Panel>
  </ProjectWorld>;
}
export function NewProjectPage({language,onBack,onSaved,record}:{language:Language;onBack:()=>void;onSaved:(record:ProjectRecord)=>void;record:ProjectRecord|null}) {
  const [name,setName]=useState(record?.name??''),[directory,setDirectory]=useState<DirectoryChoice|undefined>(record?.directory??(record?.kind==='project'?{token:'',path:record.path,name:record.name}:undefined)),[error,setError]=useState(''),[busy,setBusy]=useState(false),[touched,setTouched]=useState(false),[ready,setReady]=useState(Boolean(record));
  const command=useRef({signature:'',id:''}),saving=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;if(!record)projectService.loadDraft().then(draft=>{if(mounted.current){setName(draft.name??'');setDirectory(draft.directory);setReady(true)}}).catch(cause=>{if(mounted.current){setError(projectErrorCode(cause));setReady(true)}});return()=>{mounted.current=false}},[record?.id]);
  useEffect(()=>{if(!ready||record||saving.current)return;const timer=setTimeout(()=>{if(!saving.current)void projectService.saveDraft(name,directory).catch(cause=>{if(mounted.current)setError(projectErrorCode(cause))})},450);return()=>clearTimeout(timer)},[name,directory,ready,record]);
  async function choose(){if(busy)return;setBusy(true);setError('');try{const next=await projectService.chooseParent();if(next)setDirectory(next)}catch(cause){setError(projectErrorCode(cause))}finally{setBusy(false)}}
  async function back(){if(busy)return;if(!record&&ready){setBusy(true);try{await projectService.saveDraft(name,directory)}catch(cause){setError(projectErrorCode(cause));setBusy(false);return}}onBack()}
  async function submit(event:FormEvent){event.preventDefault();setTouched(true);if(!validProjectName(name)||!directory||busy)return;setBusy(true);saving.current=true;setError('');
    try{let result:ProjectRecord;if(record)result=await projectService.update(record,name,directory);else{const signature=JSON.stringify([name,directory.token]);if(command.current.signature!==signature)command.current={signature,id:crypto.randomUUID()};result=await projectService.create(name,directory,command.current.id)}onSaved(result)}
    catch(cause){if(mounted.current){setError(projectErrorCode(cause));setBusy(false);saving.current=false}}
  }
  return <NewProjectSurface language={language} name={name} directory={directory} existing={Boolean(record)} fixedLocation={record?.kind==='project'} busy={busy} error={error} nameError={touched&&!validProjectName(name)} disabled={!ready||!validProjectName(name)||!directory} onName={value=>{setName(value);setError('')}} onChoose={()=>void choose()} onSubmit={event=>void submit(event)} onBlur={()=>setTouched(true)} onBack={()=>void back()}/>;
}
