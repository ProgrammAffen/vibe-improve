import type {PlanningActivity} from '../planning/service';
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowDown,ArrowUp,ChevronDown,ChevronRight,FileText,LockKeyhole,MessageSquarePlus,Move,ArrowRight,Plus,Redo2,Trash2,Undo2} from 'lucide-react';
import {assertStudiedRouteUnchanged,type AgentOptions,type PlanningState,type PlanningTarget,type PlanningMention} from '../../../../packages/domain/planning.mjs';
import {planningMentionToken,refreshPlanningMentions} from '../../../../packages/domain/planning-references.mjs';
import {routeIssues,type RouteDocument,type RouteChapter,type RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {messageEditRoutes,routeChanges} from '../../../../packages/domain/route-changes.mjs';
import {routeOutline,routeTargetPosition,moveRouteItem,moveRouteItemBy} from '../../../../packages/domain/route-order.mjs';
import {routePrerequisiteOptions,setRoutePrerequisites} from '../../../../packages/domain/route-prerequisites.mjs';
import {PROVIDERS,type ProviderId} from '../agents/domain';
import {translate,type Language} from '../i18n';
import type {AttachmentTarget} from '../resources/service';
import PlanningNavigation from './PlanningNavigation';
import GameButton from './GameButton';
import GameSelect from './GameSelect';
import Modal from './Modal';
import EditorMenu,{type EditorMenuItem} from './RouteEditorMenu';
import RouteMoveDialog from './RouteMoveDialog';
import PlanningModelControls,{PlanningAgentControl} from './PlanningModelControls';
import {PlanningComposer,PlanningMessages} from './PlanningConversation';
import type {PlanningAttachment,PlanningMessage} from '../../../../packages/domain/planning.mjs';
import RouteChangePreview from './RouteChangePreview';

type EditorProps={language:Language;state:PlanningState;route:RouteDocument;busy?:boolean;working?:boolean;workingLabel?:string;partialReply?:string;partialProviderId?:string|null;activity?:PlanningActivity;dirty?:boolean;error?:string;conversationError?:string;notice?:string;onOptions?:(options:AgentOptions)=>void;onProvider?:(provider:ProviderId)=>void;onRoute:(route:RouteDocument)=>void;onSave:()=>void;onConfirm:()=>void;onSend:(text:string,mentions?:PlanningMention[],target?:PlanningTarget,files?:PlanningAttachment[])=>void|boolean|Promise<boolean>;onCancel:()=>void;onApply:()=>void;onDiscard:()=>void;onUndo:()=>void;onRedo?:()=>void;onPrevious:()=>void;onHome:()=>void;onRemoveImport?:()=>void;studiedNodeIds?:ReadonlySet<string>;learningRead?:'loading'|'failed';onRetryLearning?:()=>void;renderMaterials?:(target:AttachmentTarget,locked:boolean)=>ReactNode};
const ASSET=import.meta.env.BASE_URL+'assets/images/';
const newID=(prefix:string)=>prefix+'_'+crypto.randomUUID().replaceAll('-','');
const NO_STUDIED_NODES:ReadonlySet<string>=new Set();

function EditorIcon({label,onClick,children,disabled=false}:{label:string;onClick:()=>void;children:ReactNode;disabled?:boolean}){
 return <button type="button" className="icon-button route-editor-icon" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function RouteEditorSurface({language,state,route,busy=false,working=false,workingLabel,partialReply,partialProviderId,activity,dirty=false,error='',conversationError='',notice='',onOptions,onProvider,onRoute,onSave,onConfirm,onSend,onCancel,onApply,onDiscard,onUndo,onRedo,onPrevious,onHome,onRemoveImport,studiedNodeIds=NO_STUDIED_NODES,learningRead,onRetryLearning,renderMaterials}:EditorProps){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const [selection,setSelection]=useState<{chapterId:string;nodeId:string|null}>({chapterId:route.chapters[0]?.id??'',nodeId:route.chapters[0]?.nodes[0]?.id??null});
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(route.chapters[0]?[route.chapters[0].id]:[]));
 const [issuesOpen,setIssuesOpen]=useState(false),[issuePath,setIssuePath]=useState<string|null>(null);
 const detailRef=useRef<HTMLElement>(null),titleRef=useRef<HTMLInputElement>(null),composerRef=useRef<HTMLTextAreaElement>(null);
 const outlineRef=useRef<HTMLElement>(null),movedTarget=useRef<PlanningTarget|null>(null);
 const referenceSequence=useRef(0),[referenceRequest,setReferenceRequest]=useState<{sequence:number;mention:PlanningMention}>();
 function addToChat(target:PlanningTarget){setReferenceRequest({sequence:++referenceSequence.current,mention:{target,token:planningMentionToken(route,target,language)}})}
 async function sendMessage(text:string,mentions?:PlanningMention[],target?:PlanningTarget,files?:PlanningAttachment[]){const refreshed=mentions?.length?refreshPlanningMentions(route,text,mentions,language):{text,mentions};return await onSend(refreshed.text,refreshed.mentions,target?routeTargetPosition(route,target)?.target??target:undefined,files)!==false}
 const [remove,setRemove]=useState<{chapterId:string;nodeId?:string}|null>(null);
 const [moving,setMoving]=useState<PlanningTarget|null>(null);
 const selectedPosition=routeTargetPosition(route,{chapterId:selection.chapterId,...(selection.nodeId?{nodeId:selection.nodeId}:{})});
 const chapter=selectedPosition?route.chapters[selectedPosition.chapterIndex]:route.chapters.find(item=>item.id===selection.chapterId)??route.chapters[0];
 const node=selectedPosition?.nodeIndex!=null?chapter?.nodes[selectedPosition.nodeIndex]:undefined;
 const nodes=route.chapters.flatMap(item=>item.nodes),outline=routeOutline(route);
 const selectedProvider=PROVIDERS.find(item=>item.id===state.provider),proposal=state.proposal;
 const editingDisabled=busy||Boolean(learningRead);
 const studiedChapters=new Set(route.chapters.filter(ch=>ch.nodes.some(lesson=>studiedNodeIds.has(lesson.id))).map(ch=>ch.id));
 const protectedPrerequisites=new Set(nodes.filter(lesson=>studiedNodeIds.has(lesson.id)).flatMap(lesson=>lesson.prerequisites));
 const detailLocked=node?studiedNodeIds.has(node.id):chapter?studiedChapters.has(chapter.id):false;
 const detailDisabled=editingDisabled||detailLocked;
 const detailTarget=chapter?{chapterId:chapter.id,...(node?{nodeId:node.id}:{})}:undefined;
 const lockLabel=t('已有学习进度 · 只读','Learning progress recorded · Read only');
 function respectsLocks(next:RouteDocument|undefined){
  if(!next)return true;
  try{assertStudiedRouteUnchanged(route,next,studiedNodeIds);return true}catch{return false}
 }
 const proposalLocked=Boolean(proposal&&!respectsLocks(proposal.route));
 function targetLocked(target:PlanningTarget){return target.nodeId?studiedNodeIds.has(target.nodeId):studiedChapters.has(target.chapterId)}
 function removalLocked(target:PlanningTarget){
  if(targetLocked(target))return true;
  if(target.nodeId)return protectedPrerequisites.has(target.nodeId);
  return route.chapters.find(ch=>ch.id===target.chapterId)?.nodes.some(lesson=>protectedPrerequisites.has(lesson.id))??false;
 }
 const editorMessages=state.messages.filter(message=>!message.questionId),lastMessage=editorMessages.at(-1),answeredMessage=lastMessage?.role==='assistant'?editorMessages.slice(0,-1).reverse().find(message=>message.role==='user'):undefined;
 const messageEdits=useMemo(()=>new Map(state.messages.filter(message=>message.routeEdit).map(message=>[message.id,messageEditRoutes(state,message)])),[state]);
 const legacyBefore=!proposal&&!working&&!editorMessages.some(message=>message.routeEdit)&&lastMessage?.role==='assistant'&&!lastMessage.editOutcome?(state.history?.past.at(-1)??state.undoRoute):undefined;
 const legacySavedBefore=legacyBefore&&state.routeDraft&&legacyBefore.id===state.routeDraft.id&&routeChanges(legacyBefore,state.routeDraft,language).length?legacyBefore:undefined;
 function pendingPreview(){return proposal&&state.routeDraft?<RouteChangePreview key={'pending-'+proposal.baseRevision} before={state.routeDraft} after={proposal.route} language={language} status="pending" warning={proposalLocked?t('这项修改涉及已学章节，无法采用。','This change affects studied lessons and cannot be applied.'):undefined}>
  <GameButton disabled={editingDisabled||dirty||proposalLocked} onClick={onApply}>{t('采用修改','Apply')}</GameButton><GameButton variant="secondary" disabled={busy} onClick={onDiscard}>{t('放弃','Discard')}</GameButton>
 </RouteChangePreview>:null}
 function messageChanges(message:PlanningMessage){
  if(message.editOutcome==='no-changes')return <span className="route-edit-message-status" data-edit-outcome="no-changes">{t('路线未修改','Route unchanged')}</span>;
  const edit=messageEdits.get(message.id);
  if(!edit)return null;
  if(edit.status==='pending')return pendingPreview();
  if(edit.status==='applied'&&edit.before&&edit.after)return <RouteChangePreview key={'applied-'+message.id} before={edit.before} after={edit.after} language={language} status="applied"/>;
  return <span className="route-edit-message-status">{edit.status==='applied'?t('修改已采用','Changes applied'):t('修改未采用','Changes not applied')}</span>;
 }
 const unanswered=lastMessage?.role==='user'&&!state.pending&&!busy&&!working;
 const conversationFeedback=conversationError||(unanswered?t('上一条消息未收到回复，可重试。','The last message has no reply. Retry when ready.'):'');
 useEffect(()=>{
  if(!chapter){if(selection.chapterId)setSelection({chapterId:'',nodeId:null});return}
  if(chapter.id!==selection.chapterId||selection.nodeId&&!node){setSelection({chapterId:chapter.id,nodeId:node?.id??chapter.nodes[0]?.id??null});setExpanded(old=>new Set(old).add(chapter.id))}
 },[chapter?.id,node?.id,selection.chapterId,selection.nodeId]);
 useEffect(()=>{
  const target=movedTarget.current,container=outlineRef.current;if(!target||!container)return;movedTarget.current=null;
  const row=container.querySelector<HTMLElement>(target.nodeId?'[data-route-node="'+CSS.escape(target.nodeId)+'"]':'[data-route-chapter="'+CSS.escape(target.chapterId)+'"]');if(!row)return;
  const bounds=container.getBoundingClientRect(),item=row.getBoundingClientRect();
  if(item.top<bounds.top)container.scrollTop-=bounds.top-item.top;else if(item.bottom>bounds.bottom)container.scrollTop+=item.bottom-bounds.bottom;
 },[route]);
 function select(ch:RouteChapter,lesson:RouteNode|null){setSelection({chapterId:ch.id,nodeId:lesson?.id??null});setExpanded(old=>new Set(old).add(ch.id))}
 function edit(change:(copy:RouteDocument)=>void){if(editingDisabled)return;const copy=structuredClone(route);change(copy);copy.schemaVersion=2;onRoute(copy)}
 function editChapter(change:(item:RouteChapter)=>void){if(chapter&&!detailLocked)edit(copy=>{const item=copy.chapters.find(ch=>ch.id===chapter.id);if(item)change(item)})}
 function editNode(change:(item:RouteNode)=>void){if(node&&!detailLocked)edit(copy=>{const item=copy.chapters.find(ch=>ch.id===chapter?.id)?.nodes.find(n=>n.id===node.id);if(item)change(item)})}
 function changePrerequisites(values:string[]){if(!node||detailDisabled)return;const next=setRoutePrerequisites(route,node.id,values);if(next!==route)onRoute({...next,schemaVersion:2})}
 function addChapter(after?:string){if(editingDisabled||route.chapters.length>=24)return;const id=newID('chapter');edit(copy=>copy.chapters.splice(after?copy.chapters.findIndex(ch=>ch.id===after)+1:copy.chapters.length,0,{id,title:'',stageGoal:'',nodes:[]}));setSelection({chapterId:id,nodeId:null});setExpanded(old=>new Set(old).add(id))}
 function addNode(ch:RouteChapter,after?:string){if(editingDisabled||ch.nodes.length>=64||nodes.length>=512)return;const id=newID('lesson');edit(copy=>copy.chapters.find(item=>item.id===ch.id)?.nodes.splice(after?ch.nodes.findIndex(n=>n.id===after)+1:ch.nodes.length,0,{id,title:'',objectives:[{id:newID('objective'),description:''}],prerequisites:[],estimatedMinutes:30}));setSelection({chapterId:ch.id,nodeId:id});setExpanded(old=>new Set(old).add(ch.id))}
 function moved(next:RouteDocument,source:PlanningTarget){
  if(editingDisabled||targetLocked(source)||next===route)return;next.schemaVersion=2;onRoute(next);
  const position=routeTargetPosition(next,source);if(position){movedTarget.current=position.target;setSelection({chapterId:position.target.chapterId,nodeId:position.target.nodeId??null});setExpanded(old=>new Set(old).add(position.target.chapterId))}
 }
 function moveBy(source:PlanningTarget,offset:-1|1){if(!editingDisabled&&!targetLocked(source))moved(moveRouteItemBy(route,source,offset),source)}
 function moveTo(source:PlanningTarget,destination:PlanningTarget){if(!editingDisabled&&!targetLocked(source))moved(moveRouteItem(route,source,destination),source);setMoving(null)}
 function movementMenu(source:PlanningTarget,index:number,count:number):EditorMenuItem{
  const item={label:t('移动','Move'),icon:<Move/>};
  if(editingDisabled||targetLocked(source))return {...item,disabled:true};
  return {...item,children:[{label:t('上移','Move up'),icon:<ArrowUp/>,disabled:index===0,onClick:()=>moveBy(source,-1)},{label:t('下移','Move down'),icon:<ArrowDown/>,disabled:index===count-1,onClick:()=>moveBy(source,1)},{label:t('移动到','Move to'),icon:<ArrowRight/>,onClick:()=>setMoving(source)}]};
 }
 function removeSelected(){
  if(!remove||editingDisabled||removalLocked(remove))return;
  edit(copy=>{const ids=new Set(remove.nodeId?[remove.nodeId]:(copy.chapters.find(ch=>ch.id===remove.chapterId)?.nodes.map(n=>n.id)??[]));if(remove.nodeId){const ch=copy.chapters.find(ch=>ch.id===remove.chapterId);if(ch)ch.nodes=ch.nodes.filter(n=>n.id!==remove.nodeId)}else copy.chapters=copy.chapters.filter(ch=>ch.id!==remove.chapterId);for(const ch of copy.chapters)for(const n of ch.nodes)n.prerequisites=n.prerequisites.filter(id=>!ids.has(id))});
  setRemove(null);
 }
 function removeObjective(id:string){editNode(n=>{n.objectives=n.objectives.filter(o=>o.id!==id);if(n.assessment){n.assessment.objectiveIds=n.assessment.objectiveIds.filter(key=>key!==id);if(!n.assessment.objectiveIds.length)n.assessment.objectiveIds=n.objectives.map(o=>o.id)}})}
 const issues=routeIssues(route);
 function issueLabel(path:string){const parts=path.split('.'),ci=parts[0]==='chapters'?Number(parts[1]):-1,ni=parts[2]==='nodes'?Number(parts[3]):-1,key=parts.at(-1)??'';const names:Record<string,string>={title:t('名称','Name'),stageGoal:t('大章目标','Stage goal'),nodes:t('小章节','Lessons'),chapters:t('章节与依赖','Chapters and dependencies'),description:t('学习目标','Learning goal'),objectives:t('学习目标','Learning goals'),task:t('验收测验','Assessment quiz'),answer:t('测验答案／评判标准','Quiz answers / grading criteria'),passCriteria:t('测验答案／评判标准','Quiz answers / grading criteria'),evaluatorPrompt:t('测验答案／评判标准','Quiz answers / grading criteria'),estimatedMinutes:t('预计时长','Estimated time'),prerequisites:t('前置章节','Prerequisites'),activities:t('学习活动','Learning activities'),requirement:t('小节性质','Lesson requirement'),review:t('复习设置','Review settings'),content:t('复习内容','Review content')};return (ci>=0?ni>=0?`${ci+1}.${ni+1} · `:t('大章 ','Chapter ')+(ci+1)+' · ':'')+(parts.includes('review')&&(key==='passCriteria'||parts.at(-2)==='passCriteria')?t('回答正确的指标','Criteria for a correct answer'):(names[key]??names[parts.at(-2)??'']??t('章节内容','Chapter content')))}
 useEffect(()=>{
  if(issuePath===null)return;
  const parts=issuePath.split('.'),key=parts.at(-1)??'',field=/^[0-9]+$/.test(key)?parts.at(-2)??key:key;
  const host=detailRef.current;
  if(issuePath==='title')titleRef.current?.focus();
  else if(host){
   const sectionName=issuePath.includes('.assessment')||issuePath.includes('.review')||field==='requirement'?'settings':undefined;
   if(sectionName){
    const section=host.querySelector<HTMLDetailsElement>('[data-route-section="'+sectionName+'"]');
    if(section)section.open=true;
   }
   const fieldName=issuePath.includes('.review')||issuePath.includes('.assessment')?'legacyFollowup':field;
   const targets=host.querySelectorAll<HTMLElement>('[data-route-field="'+CSS.escape(fieldName)+'"]');
   const target=targets[field==='description'?Number(parts[parts.indexOf('objectives')+1])||0:0];
   const control=(target?.matches('input,textarea,select,button')?target:target?.querySelector<HTMLElement>('input,textarea,select,button'))
    ??host.querySelector<HTMLElement>('[data-route-field="title"] input');
   control?.focus();
   control?.scrollIntoView({block:'nearest'});
  }
  setIssuePath(null);
 },[issuePath,selection.chapterId,selection.nodeId]);
 const selectedNodePath=chapter&&node?`chapters.${route.chapters.indexOf(chapter)}.nodes.${chapter.nodes.indexOf(node)}`:undefined;
 const incompleteFollowup=(['assessment','review'] as const).filter(field=>selectedNodePath&&issues.some(issue=>issue.path===selectedNodePath+'.'+field||issue.path.startsWith(selectedNodePath+'.'+field+'.')));
 function locateIssue(path:string){const parts=path.split('.'),ch=route.chapters[Number(parts[1])];if(parts[0]==='chapters'&&ch)select(ch,parts[2]==='nodes'?ch.nodes[Number(parts[3])]??null:null);setIssuesOpen(false);setIssuePath(path)}
 return <section className="planning-page planning-page--editor"><PlanningNavigation language={language} busy={busy} onHome={onHome} onPrevious={onPrevious}/><div className={`planning-stage planning-stage--editor route-editor ${state.provider?'has-assistant':'is-manual'}`}>
  <img className="planning-scene" src={ASSET+'route-editor-scroll-cutout-v2.png'} alt="" draggable={false}/>
  <header className="route-editor-header">
   <div className="route-editor-heading"><h1>{t('编辑路线','Edit route')}</h1><input ref={titleRef} aria-label={t('路线名称','Route name')} placeholder={t('路线名称','Route name')} value={route.title} maxLength={160} disabled={editingDisabled} onChange={event=>edit(copy=>{copy.title=event.target.value})}/></div>
   <div className="route-editor-route-actions"><EditorMenu label={t('路线操作','Route actions')} disabled={busy} items={[
    {label:t('添加大章节','Add chapter'),icon:<Plus/>,disabled:editingDisabled||route.chapters.length>=24,onClick:()=>addChapter()},
    ...(state.importedOriginal&&onRemoveImport?[{label:t('删除导入路线','Delete import'),icon:<Trash2/>,onClick:onRemoveImport,danger:true,disabled:editingDisabled||(route.id===state.importedOriginal.id&&studiedChapters.size>0)}]:[]),
   ]}/></div>
  </header>
  <div className="route-editor-layout">
   <nav ref={outlineRef} className="route-editor-outline" aria-label={t('章节目录','Chapter outline')}>
    <ol className="route-outline-chapters">{outline.map(({chapter:ch,number:chapterNumber,lessons},ci)=>{const open=expanded.has(ch.id),active=ch.id===chapter?.id;return <li key={ch.id}>
     <div data-route-chapter={ch.id} className={`route-outline-chapter ${active?'is-current':''} ${active&&!node?'is-selected':''}`}>
      <button type="button" className="icon-button route-editor-icon route-outline-toggle" aria-label={(open?t('收起','Collapse'):t('展开','Expand'))+' '+(ch.title||t('大章节','Chapter'))} aria-expanded={open} aria-controls={'outline-'+ch.id} disabled={busy} onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(ch.id))next.delete(ch.id);else next.add(ch.id);return next})}>{open?<ChevronDown/>:<ChevronRight/>}</button>
      <button type="button" className="route-outline-title" title={ch.title} disabled={busy} aria-current={active&&!node?'true':undefined} aria-description={studiedChapters.has(ch.id)?lockLabel:undefined} onClick={()=>select(ch,null)}><span key={chapterNumber} className="route-outline-chapter-number">{chapterNumber}</span><strong>{ch.title||t('新大章节','New chapter')}</strong>{studiedChapters.has(ch.id)&&<LockKeyhole className="route-outline-lock" aria-hidden="true"/>}</button>
      <EditorMenu label={t('大章操作','Chapter actions')+' '+(ch.title||chapterNumber)} disabled={busy} items={[{label:t('添加大章节','Add chapter'),icon:<Plus/>,disabled:editingDisabled||route.chapters.length>=24,onClick:()=>addChapter(ch.id)},{label:t('添加到对话','Add to chat'),icon:<MessageSquarePlus/>,disabled:!state.provider,onClick:()=>addToChat({chapterId:ch.id})},movementMenu({chapterId:ch.id},ci,route.chapters.length),{label:t('删除大章','Delete chapter'),icon:<Trash2/>,danger:true,disabled:editingDisabled||removalLocked({chapterId:ch.id}),onClick:()=>setRemove({chapterId:ch.id})}]}/>
     </div>
     {open&&<ol id={'outline-'+ch.id} className="route-outline-lessons">{lessons.map(({node:n,number:lessonNumber},ni)=><li key={n.id} data-route-node={n.id} className={node?.id===n.id?'is-selected':''}>
      <button type="button" className="route-outline-title" title={n.title} disabled={busy} aria-current={node?.id===n.id?'true':undefined} aria-description={studiedNodeIds.has(n.id)?lockLabel:undefined} onClick={()=>select(ch,n)}><span key={lessonNumber} className="route-outline-lesson-number">{lessonNumber}</span><strong>{n.title||t('新小章节','New lesson')}</strong>{studiedNodeIds.has(n.id)&&<LockKeyhole className="route-outline-lock" aria-hidden="true"/>}</button>
      <EditorMenu label={t('小章操作','Lesson actions')+' '+(n.title||lessonNumber)} disabled={busy} items={[{label:t('添加小章节','Add lesson'),icon:<Plus/>,disabled:editingDisabled||ch.nodes.length>=64||nodes.length>=512,onClick:()=>addNode(ch,n.id)},{label:t('添加到对话','Add to chat'),icon:<MessageSquarePlus/>,disabled:!state.provider,onClick:()=>addToChat({chapterId:ch.id,nodeId:n.id})},movementMenu({chapterId:ch.id,nodeId:n.id},ni,ch.nodes.length),{label:t('删除小章','Delete lesson'),icon:<Trash2/>,danger:true,disabled:editingDisabled||removalLocked({chapterId:ch.id,nodeId:n.id}),onClick:()=>setRemove({chapterId:ch.id,nodeId:n.id})}]}/>
     </li>)}{!lessons.length&&<li className="route-outline-empty-lesson"><span>{t('暂无小章节','No lessons')}</span><EditorMenu label={t('小章操作','Lesson actions')+' '+chapterNumber} disabled={busy} items={[{label:t('添加小章节','Add lesson'),icon:<Plus/>,disabled:editingDisabled||nodes.length>=512,onClick:()=>addNode(ch)}]}/></li>}</ol>}
    </li>})}</ol>
   </nav>
   <section ref={detailRef} key={`${chapter?.id??'empty'}:${node?.id??'chapter'}`} className="route-editor-detail" aria-label={t('章节编辑','Chapter editor')}>
    {learningRead&&<div className="route-editor-progress-status">
     <p role={learningRead==='failed'?'alert':'status'}>{learningRead==='failed'?t('无法读取学习记录，暂时无法编辑。','Learning progress could not be read. Editing is paused.'):t('正在读取学习记录…','Loading learning progress…')}</p>
     {learningRead==='failed'&&onRetryLearning&&<button type="button" className="text-button" disabled={busy} onClick={onRetryLearning}>{t('重试','Retry')}</button>}
    </div>}
    {chapter?<><div className="route-editor-detail-heading"><div><small>{node?t('小章节','Lesson'):t('大章节','Chapter')}</small><h2 title={node?.title??chapter.title}>{selectedPosition?.number??''} {node?.title||chapter.title||t('新章节','New chapter')}</h2></div>{detailTarget&&<EditorIcon label={node?t('删除当前小章','Delete current lesson'):t('删除当前大章','Delete current chapter')} disabled={editingDisabled||removalLocked(detailTarget)} onClick={()=>setRemove(detailTarget)}><Trash2/></EditorIcon>}</div>
     {detailLocked&&<div className="route-editor-locked"><LockKeyhole aria-hidden="true"/><div><strong>{lockLabel}</strong><p>{t('已开始学习或已掌握的小节保持只读。','Lessons that have been started or marked as mastered are read only.')}</p></div></div>}
     {!detailLocked&&detailTarget&&removalLocked(detailTarget)&&<p className="route-editor-locked">{t('已学小节依赖这里的前置内容，无法删除。','A studied lesson depends on this prerequisite, so it cannot be deleted.')}</p>}
     {node?<>
      <label data-route-field="title" className="route-editor-field"><span>{t('小章名称','Lesson name')}</span><input value={node.title} maxLength={160} disabled={editingDisabled} readOnly={detailLocked} onChange={event=>editNode(n=>{n.title=event.target.value})}/></label>
      <div data-route-field="objectives" className="route-editor-field route-editor-objectives"><div className="route-editor-field-heading"><span>{t('学习目标','Learning goals')}</span><EditorIcon label={t('添加目标','Add goal')} disabled={detailDisabled||node.objectives.length>=12} onClick={()=>editNode(n=>{n.objectives.push({id:newID('objective'),description:''});if(n.assessment)n.assessment.objectiveIds=n.objectives.map(o=>o.id)})}><Plus/></EditorIcon></div>{node.objectives.map((o,index)=><div key={o.id} className="route-editor-objective"><textarea data-route-field="description" aria-label={t('学习目标','Learning goal')+' '+(index+1)} value={o.description} disabled={editingDisabled} readOnly={detailLocked} maxLength={2000} onChange={event=>editNode(n=>{n.objectives[index].description=event.target.value})}/>{node.objectives.length>1&&<EditorIcon label={t('删除目标','Delete goal')+' '+(index+1)} disabled={detailDisabled} onClick={()=>removeObjective(o.id)}><Trash2/></EditorIcon>}</div>)}</div>
      {renderMaterials?.({kind:'lesson',targetId:node.id},detailDisabled)}
      <label data-route-field="estimatedMinutes" className="route-editor-duration"><span>{t('预计时长','Estimated time')}</span><input type="number" min={1} max={1440} aria-label={t('预计时长（分钟）','Estimated time (minutes)')} value={node.estimatedMinutes} disabled={editingDisabled} readOnly={detailLocked} onChange={event=>editNode(n=>{n.estimatedMinutes=Math.max(1,Math.min(1440,Number(event.target.value)||1))})}/><span>{t('分钟','min')}</span></label>
      <div className="route-editor-disclosures">
       <details data-route-section="settings"><summary>{t('其他设置','Other settings')}<ChevronRight/></summary><div className="route-editor-disclosure-body">
        <div data-route-field="requirement" className="route-editor-field"><span>{t('小节性质','Lesson requirement')}</span><GameSelect aria-label={t('小节性质','Lesson requirement')} value={node.requirement??'required'} disabled={detailDisabled} onChange={value=>editNode(n=>{n.requirement=value as 'required'|'optional'})} options={[{value:'required',label:t('必学','Required')},{value:'optional',label:t('选学','Elective')}]}/></div>
        <div data-route-field="prerequisites" className="route-editor-field route-editor-prerequisites"><span>{t('前置章节','Prerequisites')}</span><GameSelect multiple aria-label={t('前置章节','Prerequisites')} value={node.prerequisites} placeholder={t('无前置章节','No prerequisites')} disabled={detailDisabled} onChange={changePrerequisites} options={routePrerequisiteOptions(route,node.id).map(option=>({value:option.value,disabled:option.disabled,label:option.problem==='missing'?t('已失效的小节','Unavailable lesson'):(option.number+' '+(option.title||t('未命名小节','Untitled lesson')))+(option.problem==='cycle'?t('（会形成循环）',' (would create a cycle)'):option.problem==='self'?t('（当前小节）',' (current lesson)'):'')}))}/></div>
        {incompleteFollowup.length>0&&<div data-route-field="legacyFollowup" className="route-editor-legacy-followup">
         <p>{t('旧测验或复习配置尚未填写完整。','A legacy quiz or review configuration is incomplete.')}</p>
         <button type="button" className="text-button" disabled={detailDisabled} onClick={()=>editNode(n=>{for(const field of incompleteFollowup)delete n[field]})}>{t('移除未完成的旧配置','Remove incomplete legacy configuration')}</button>
        </div>}
       </div></details>
      </div>
     </>:<>
      <label data-route-field="title" className="route-editor-field"><span>{t('大章名称','Chapter name')}</span><input value={chapter.title} maxLength={160} disabled={editingDisabled} readOnly={detailLocked} onChange={event=>editChapter(ch=>{ch.title=event.target.value})}/></label>
      <label data-route-field="stageGoal" className="route-editor-field"><span>{t('大章目标','Stage goal')}</span><textarea value={chapter.stageGoal??''} maxLength={2000} disabled={editingDisabled} readOnly={detailLocked} onChange={event=>editChapter(ch=>{ch.stageGoal=event.target.value})}/></label>
      {renderMaterials?.({kind:'chapter',targetId:chapter.id},detailDisabled)}
     </>}
    </>:<div className="route-editor-empty"><FileText aria-hidden="true"/><span>{t('暂无章节','No chapters')}</span></div>}
   </section>
   {state.provider&&<aside className="route-editor-assistant" aria-label={t('AI对话','AI conversation')}>
    <header><h2>{t('AI 对话','AI chat')}</h2>
     {onProvider?<PlanningAgentControl state={state} language={language} busy={busy} onProvider={onProvider} showLabel={false}/>
      :<span><img src={ASSET+(selectedProvider?.icon??'agent-codex.png')} alt=""/>{selectedProvider?.name??state.provider}</span>}
    </header>
    {onOptions&&<PlanningModelControls key={state.provider} state={state} language={language} busy={busy} onOptions={onOptions}/>}
    <PlanningMessages messages={editorMessages} providerId={state.provider} language={language} busy={working} workingLabel={workingLabel} partialReply={partialReply} partialProviderId={partialProviderId} activity={activity} route={route} renderMessageExtra={messageChanges}>
    {proposal&&!editorMessages.some(message=>message.routeEdit?.requestRevision===proposal.baseRevision)&&pendingPreview()}
    {legacySavedBefore&&state.routeDraft&&<RouteChangePreview key={'saved-'+state.routeDraft.revision} before={legacySavedBefore} after={state.routeDraft} language={language} status="saved"/>}
    </PlanningMessages>
    {conversationFeedback&&<div className="route-editor-conversation-feedback"><p role={conversationError?'alert':'status'}>{conversationFeedback}</p>{lastMessage?.role==='user'&&<GameButton variant="secondary" disabled={busy||working||Boolean(state.pending)} onClick={()=>void sendMessage(lastMessage.text,lastMessage.mentions,lastMessage.target,lastMessage.attachments)}>{t('重试','Retry')}</GameButton>}</div>}
    <PlanningComposer attachmentProject={state.projectId} inputRef={composerRef} route={route} referenceRequest={referenceRequest} language={language} busy={working} disabled={busy&&!working} onSend={(text,mentions,files)=>sendMessage(text,mentions,undefined,files)} onCancel={onCancel} answeredMessage={answeredMessage} placeholder={t('提问或描述想调整的内容…','Ask about or adjust your route…')}/>
   </aside>}
  </div>
  <footer className="route-editor-footer"><span className="route-editor-save-state" role="status">{notice||(dirty?t('未保存','Unsaved'):state.confirmedRevision?t('已确认','Confirmed'):t('已保存','Saved'))}</span>{!state.provider&&onProvider&&<PlanningAgentControl state={state} language={language} busy={busy} onProvider={onProvider} showLabel={false} above/>}{issues.length>0&&<button type="button" className="text-button route-editor-review" disabled={busy} onClick={()=>setIssuesOpen(true)}>{t('待补全 ','Review ')}{issues.length}{t(' 项',' items')}</button>}<EditorIcon label={t('撤销','Undo')} onClick={onUndo} disabled={editingDisabled||!dirty&&(!state.undoRoute&&!state.history?.past.length||!respectsLocks(state.history?.past.at(-1)??state.undoRoute))}><Undo2/></EditorIcon><EditorIcon label={t('前进','Redo')} onClick={()=>onRedo?.()} disabled={editingDisabled||dirty||!state.history?.future.length||!respectsLocks(state.history?.future.at(-1))}><Redo2/></EditorIcon><GameButton variant="secondary" disabled={editingDisabled} onClick={onSave}>{t('保存草稿','Save draft')}</GameButton><GameButton disabled={editingDisabled} onClick={()=>issues.length?setIssuesOpen(true):onConfirm()}>{t('确认路线','Confirm route')}</GameButton></footer>
  {error&&<div className="route-editor-feedback"><p className="form-message is-error" role="alert">{error}</p></div>}
  {issuesOpen&&<Modal title={t('待补全内容','Complete these items')} closeLabel={t('关闭','Close')} onClose={()=>setIssuesOpen(false)}><ul className="route-editor-issues">{issues.map(issue=><li key={issue.path}><button className="text-button" onClick={()=>locateIssue(issue.path)}><span title={issueLabel(issue.path)}>{issueLabel(issue.path)}</span><small>{issue.code==='required'?t('必填','Required'):issue.code==='dependencies'?t('检查依赖','Check dependencies'):issue.code==='duplicate'?t('重复','Duplicate'):issue.code==='count'?t('调整数量','Adjust count'):t('检查内容','Review content')}</small><ChevronRight/></button></li>)}</ul></Modal>}
  {moving&&!targetLocked(moving)&&<RouteMoveDialog route={route} source={moving} language={language} busy={busy} onMove={target=>moveTo(moving,target)} onClose={()=>setMoving(null)}/>}
  {remove&&<Modal title={remove.nodeId?t('删除小章节','Delete lesson'):t('删除大章节','Delete chapter')} closeLabel={t('关闭','Close')} onClose={()=>setRemove(null)} busy={busy}><p className="confirmation-copy">{t('删除章节及其下属内容，并移除其他章节对它的前置引用。','Delete this chapter and its content, and remove references to it from other lessons.')}</p><div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setRemove(null)}>{t('取消','Cancel')}</GameButton><GameButton variant="danger" disabled={editingDisabled||removalLocked(remove)} onClick={removeSelected}>{t('确认删除','Delete')}</GameButton></div></Modal>}
 </div></section>;
}
