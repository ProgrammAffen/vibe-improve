import type {PlanningActivity} from '../planning/service';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowDown,ArrowUp,ChevronDown,ChevronRight,FileText,MessageSquarePlus,Move,ArrowRight,Plus,Redo2,Trash2,Undo2} from 'lucide-react';
import type {AgentOptions,PlanningState,PlanningTarget,PlanningMention} from '../../../../packages/domain/planning.mjs';
import {planningMentionToken,refreshPlanningMentions} from '../../../../packages/domain/planning-references.mjs';
import {routeIssues,type RouteDocument,type RouteChapter,type RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {routeOutline,routeTargetPosition,moveRouteItem,moveRouteItemBy} from '../../../../packages/domain/route-order.mjs';
import {PROVIDERS} from '../agents/domain';
import {translate,type Language} from '../i18n';
import PlanningNavigation from './PlanningNavigation';
import GameButton from './GameButton';
import GameToggle from './GameToggle';
import Modal from './Modal';
import EditorMenu,{type EditorMenuItem} from './RouteEditorMenu';
import RouteMoveDialog from './RouteMoveDialog';
import PlanningModelControls from './PlanningModelControls';
import {PlanningComposer,PlanningMessages} from './PlanningConversation';

type EditorProps={language:Language;state:PlanningState;route:RouteDocument;busy?:boolean;working?:boolean;workingLabel?:string;partialReply?:string;activity?:PlanningActivity;dirty?:boolean;error?:string;conversationError?:string;notice?:string;onOptions?:(options:AgentOptions)=>void;onRoute:(route:RouteDocument)=>void;onSave:()=>void;onConfirm:()=>void;onSend:(text:string,mentions?:PlanningMention[],target?:PlanningTarget)=>void|boolean|Promise<boolean>;onCancel:()=>void;onApply:()=>void;onDiscard:()=>void;onUndo:()=>void;onRedo?:()=>void;onPrevious:()=>void;onHome:()=>void;onRemoveImport?:()=>void};
const ASSET=import.meta.env.BASE_URL+'assets/images/';
const newID=(prefix:string)=>prefix+'_'+crypto.randomUUID().replaceAll('-','');

function EditorIcon({label,onClick,children,disabled=false}:{label:string;onClick:()=>void;children:ReactNode;disabled?:boolean}){
 return <button type="button" className="icon-button route-editor-icon" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function RouteEditorSurface({language,state,route,busy=false,working=false,workingLabel,partialReply,activity,dirty=false,error='',conversationError='',notice='',onOptions,onRoute,onSave,onConfirm,onSend,onCancel,onApply,onDiscard,onUndo,onRedo,onPrevious,onHome,onRemoveImport}:EditorProps){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const [selection,setSelection]=useState<{chapterId:string;nodeId:string|null}>({chapterId:route.chapters[0]?.id??'',nodeId:route.chapters[0]?.nodes[0]?.id??null});
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(route.chapters[0]?[route.chapters[0].id]:[]));
 const [issuesOpen,setIssuesOpen]=useState(false),[issuePath,setIssuePath]=useState<string|null>(null);
 const detailRef=useRef<HTMLElement>(null),titleRef=useRef<HTMLInputElement>(null),composerRef=useRef<HTMLTextAreaElement>(null);
 const outlineRef=useRef<HTMLElement>(null),movedTarget=useRef<PlanningTarget|null>(null);
 const referenceSequence=useRef(0),[referenceRequest,setReferenceRequest]=useState<{sequence:number;mention:PlanningMention}>();
 function addToChat(target:PlanningTarget){setReferenceRequest({sequence:++referenceSequence.current,mention:{target,token:planningMentionToken(route,target,language)}})}
 async function sendMessage(text:string,mentions?:PlanningMention[],target?:PlanningTarget){const refreshed=mentions?.length?refreshPlanningMentions(route,text,mentions,language):{text,mentions};return await onSend(refreshed.text,refreshed.mentions,target?routeTargetPosition(route,target)?.target??target:undefined)!==false}
 const [remove,setRemove]=useState<{chapterId:string;nodeId?:string}|null>(null);
 const [moving,setMoving]=useState<PlanningTarget|null>(null);
 const selectedPosition=routeTargetPosition(route,{chapterId:selection.chapterId,...(selection.nodeId?{nodeId:selection.nodeId}:{})});
 const chapter=selectedPosition?route.chapters[selectedPosition.chapterIndex]:route.chapters.find(item=>item.id===selection.chapterId)??route.chapters[0];
 const node=selectedPosition?.nodeIndex!=null?chapter?.nodes[selectedPosition.nodeIndex]:undefined;
 const nodes=route.chapters.flatMap(item=>item.nodes),outline=routeOutline(route);
 const selectedProvider=PROVIDERS.find(item=>item.id===state.provider),proposal=state.proposal;
 const editorMessages=state.messages.filter(message=>!message.questionId),lastMessage=editorMessages.at(-1),answeredText=lastMessage?.role==='assistant'?editorMessages.slice(0,-1).reverse().find(message=>message.role==='user')?.text:undefined;
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
 function edit(change:(copy:RouteDocument)=>void){if(busy)return;const copy=structuredClone(route);change(copy);copy.schemaVersion=2;onRoute(copy)}
 function editChapter(change:(item:RouteChapter)=>void){if(chapter)edit(copy=>{const item=copy.chapters.find(ch=>ch.id===chapter.id);if(item)change(item)})}
 function editNode(change:(item:RouteNode)=>void){if(node)editChapter(ch=>{const item=ch.nodes.find(n=>n.id===node.id);if(item)change(item)})}
 function addChapter(after?:string){if(route.chapters.length>=24)return;const id=newID('chapter');edit(copy=>copy.chapters.splice(after?copy.chapters.findIndex(ch=>ch.id===after)+1:copy.chapters.length,0,{id,title:'',stageGoal:'',nodes:[]}));setSelection({chapterId:id,nodeId:null});setExpanded(old=>new Set(old).add(id))}
 function addNode(ch:RouteChapter,after?:string){if(ch.nodes.length>=64||nodes.length>=512)return;const id=newID('lesson');edit(copy=>copy.chapters.find(item=>item.id===ch.id)?.nodes.splice(after?ch.nodes.findIndex(n=>n.id===after)+1:ch.nodes.length,0,{id,title:'',objectives:[{id:newID('objective'),description:''}],prerequisites:[],estimatedMinutes:30}));setSelection({chapterId:ch.id,nodeId:id});setExpanded(old=>new Set(old).add(ch.id))}
 function moved(next:RouteDocument,source:PlanningTarget){
  if(busy||next===route)return;next.schemaVersion=2;onRoute(next);
  const position=routeTargetPosition(next,source);if(position){movedTarget.current=position.target;setSelection({chapterId:position.target.chapterId,nodeId:position.target.nodeId??null});setExpanded(old=>new Set(old).add(position.target.chapterId))}
 }
 function moveBy(source:PlanningTarget,offset:-1|1){if(!busy)moved(moveRouteItemBy(route,source,offset),source)}
 function moveTo(source:PlanningTarget,destination:PlanningTarget){if(!busy)moved(moveRouteItem(route,source,destination),source);setMoving(null)}
 function moveToChapter(id:string){if(chapter&&node&&id!==chapter.id)moveTo({chapterId:chapter.id,nodeId:node.id},{chapterId:id})}
 function movementMenu(source:PlanningTarget,index:number,count:number):EditorMenuItem{return{label:t('移动','Move'),icon:<Move/>,children:[{label:t('上移','Move up'),icon:<ArrowUp/>,disabled:index===0,onClick:()=>moveBy(source,-1)},{label:t('下移','Move down'),icon:<ArrowDown/>,disabled:index===count-1,onClick:()=>moveBy(source,1)},{label:t('移动到','Move to'),icon:<ArrowRight/>,onClick:()=>setMoving(source)}]}}
 function removeSelected(){
  if(!remove)return;
  edit(copy=>{const ids=new Set(remove.nodeId?[remove.nodeId]:(copy.chapters.find(ch=>ch.id===remove.chapterId)?.nodes.map(n=>n.id)??[]));if(remove.nodeId){const ch=copy.chapters.find(ch=>ch.id===remove.chapterId);if(ch)ch.nodes=ch.nodes.filter(n=>n.id!==remove.nodeId)}else copy.chapters=copy.chapters.filter(ch=>ch.id!==remove.chapterId);for(const ch of copy.chapters)for(const n of ch.nodes)n.prerequisites=n.prerequisites.filter(id=>!ids.has(id))});
  setRemove(null);
 }
 function removeObjective(id:string){editNode(n=>{n.objectives=n.objectives.filter(o=>o.id!==id);if(n.assessment){n.assessment.objectiveIds=n.assessment.objectiveIds.filter(key=>key!==id);if(!n.assessment.objectiveIds.length)n.assessment.objectiveIds=n.objectives.map(o=>o.id)}})}
 const issues=routeIssues(route);
 function issueLabel(path:string){const parts=path.split('.'),ci=parts[0]==='chapters'?Number(parts[1]):-1,ni=parts[2]==='nodes'?Number(parts[3]):-1,key=parts.at(-1)??'';const names:Record<string,string>={title:t('名称','Name'),stageGoal:t('大章目标','Stage goal'),nodes:t('小章节','Lessons'),chapters:t('章节与依赖','Chapters and dependencies'),description:t('学习目标','Learning goal'),objectives:t('学习目标','Learning goals'),task:t('验收任务','Assessment task'),passCriteria:t('达标条件','Pass criteria'),evaluatorPrompt:t('评判提示词','Evaluation prompt'),estimatedMinutes:t('预计时长','Estimated time'),prerequisites:t('前置章节','Prerequisites'),activities:t('学习活动','Learning activities')};return (ci>=0?ni>=0?`${ci+1}.${ni+1} · `:t('大章 ','Chapter ')+(ci+1)+' · ':'')+(names[key]??names[parts.at(-2)??'']??t('章节内容','Chapter content'))}
 useEffect(()=>{if(issuePath===null)return;const parts=issuePath.split('.'),key=parts.at(-1)??'',field=/^[0-9]+$/.test(key)?parts.at(-2)??key:key;const host=detailRef.current;if(issuePath==='title'){titleRef.current?.focus()}else if(host){const section=host.querySelector<HTMLDetailsElement>(issuePath.includes('.assessment')?'[data-route-section="assessment"]':'[data-route-section="more"]');if(issuePath.includes('.assessment')||['prerequisites','activities'].includes(field)){if(section)section.open=true}const targets=host.querySelectorAll<HTMLElement>('[data-route-field="'+CSS.escape(field)+'"]'),target=targets[field==='description'?Number(parts[parts.indexOf('objectives')+1])||0:0];const control=target?.matches('input,textarea,select,button')?target:target?.querySelector<HTMLElement>('input,textarea,select,button');control?.focus();control?.scrollIntoView({block:'nearest'})}setIssuePath(null)},[issuePath,selection.chapterId,selection.nodeId]);
 function locateIssue(path:string){const parts=path.split('.'),ch=route.chapters[Number(parts[1])];if(parts[0]==='chapters'&&ch)select(ch,parts[2]==='nodes'?ch.nodes[Number(parts[3])]??null:null);setIssuesOpen(false);setIssuePath(path)}
 return <section className="planning-page planning-page--editor"><PlanningNavigation language={language} busy={busy} onHome={onHome} onPrevious={onPrevious}/><div className={`planning-stage planning-stage--editor route-editor ${state.provider?'has-assistant':'is-manual'}`}>
  <img className="planning-scene" src={ASSET+'route-editor-scroll-cutout-v2.png'} alt="" draggable={false}/>
  <header className="route-editor-header">
   <div className="route-editor-heading"><h1>{t('编辑路线','Edit route')}</h1><input ref={titleRef} aria-label={t('路线名称','Route name')} placeholder={t('路线名称','Route name')} value={route.title} maxLength={160} disabled={busy} onChange={event=>edit(copy=>{copy.title=event.target.value})}/></div>
   <div className="route-editor-route-actions"><EditorMenu label={t('路线操作','Route actions')} disabled={busy} items={[{label:t('添加大章节','Add chapter'),icon:<Plus/>,disabled:route.chapters.length>=24,onClick:()=>addChapter()},...(state.importedOriginal&&onRemoveImport?[{label:t('删除导入路线','Delete import'),icon:<Trash2/>,onClick:onRemoveImport,danger:true}]:[])]}/></div>
  </header>
  <div className="route-editor-layout">
   <nav ref={outlineRef} className="route-editor-outline" aria-label={t('章节目录','Chapter outline')}>
    <ol className="route-outline-chapters">{outline.map(({chapter:ch,number:chapterNumber,lessons},ci)=>{const open=expanded.has(ch.id),active=ch.id===chapter?.id;return <li key={ch.id}>
     <div data-route-chapter={ch.id} className={`route-outline-chapter ${active?'is-current':''} ${active&&!node?'is-selected':''}`}>
      <button type="button" className="icon-button route-editor-icon route-outline-toggle" aria-label={(open?t('收起','Collapse'):t('展开','Expand'))+' '+(ch.title||t('大章节','Chapter'))} aria-expanded={open} aria-controls={'outline-'+ch.id} disabled={busy} onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(ch.id))next.delete(ch.id);else next.add(ch.id);return next})}>{open?<ChevronDown/>:<ChevronRight/>}</button>
      <button type="button" className="route-outline-title" title={ch.title} disabled={busy} aria-current={active&&!node?'true':undefined} onClick={()=>select(ch,null)}><span key={chapterNumber} className="route-outline-chapter-number">{chapterNumber}</span><strong>{ch.title||t('新大章节','New chapter')}</strong></button>
      <EditorMenu label={t('大章操作','Chapter actions')+' '+(ch.title||chapterNumber)} disabled={busy} items={[{label:t('添加大章节','Add chapter'),icon:<Plus/>,disabled:route.chapters.length>=24,onClick:()=>addChapter(ch.id)},{label:t('添加到对话','Add to chat'),icon:<MessageSquarePlus/>,disabled:!state.provider,onClick:()=>addToChat({chapterId:ch.id})},movementMenu({chapterId:ch.id},ci,route.chapters.length),{label:t('删除大章','Delete chapter'),icon:<Trash2/>,danger:true,onClick:()=>setRemove({chapterId:ch.id})}]}/>
     </div>
     {open&&<ol id={'outline-'+ch.id} className="route-outline-lessons">{lessons.map(({node:n,number:lessonNumber},ni)=><li key={n.id} data-route-node={n.id} className={node?.id===n.id?'is-selected':''}>
      <button type="button" className="route-outline-title" title={n.title} disabled={busy} aria-current={node?.id===n.id?'true':undefined} onClick={()=>select(ch,n)}><span key={lessonNumber} className="route-outline-lesson-number">{lessonNumber}</span><strong>{n.title||t('新小章节','New lesson')}</strong></button>
      <EditorMenu label={t('小章操作','Lesson actions')+' '+(n.title||lessonNumber)} disabled={busy} items={[{label:t('添加小章节','Add lesson'),icon:<Plus/>,disabled:ch.nodes.length>=64||nodes.length>=512,onClick:()=>addNode(ch,n.id)},{label:t('添加到对话','Add to chat'),icon:<MessageSquarePlus/>,disabled:!state.provider,onClick:()=>addToChat({chapterId:ch.id,nodeId:n.id})},movementMenu({chapterId:ch.id,nodeId:n.id},ni,ch.nodes.length),{label:t('删除小章','Delete lesson'),icon:<Trash2/>,danger:true,onClick:()=>setRemove({chapterId:ch.id,nodeId:n.id})}]}/>
     </li>)}{!lessons.length&&<li className="route-outline-empty-lesson"><span>{t('暂无小章节','No lessons')}</span><EditorMenu label={t('小章操作','Lesson actions')+' '+chapterNumber} disabled={busy} items={[{label:t('添加小章节','Add lesson'),icon:<Plus/>,disabled:nodes.length>=512,onClick:()=>addNode(ch)}]}/></li>}</ol>}
    </li>})}</ol>
   </nav>
   <section ref={detailRef} key={`${chapter?.id??'empty'}:${node?.id??'chapter'}`} className="route-editor-detail" aria-label={t('章节编辑','Chapter editor')}>
    {chapter?<><div className="route-editor-detail-heading"><div><small>{node?t('小章节','Lesson'):t('大章节','Chapter')}</small><h2 title={node?.title??chapter.title}>{selectedPosition?.number??''} {node?.title||chapter.title||t('新章节','New chapter')}</h2></div><EditorIcon label={node?t('删除当前小章','Delete current lesson'):t('删除当前大章','Delete current chapter')} disabled={busy} onClick={()=>setRemove({chapterId:chapter.id,...(node?{nodeId:node.id}:{})})}><Trash2/></EditorIcon></div>
     {node?<>
      <label data-route-field="title" className="route-editor-field"><span>{t('小章名称','Lesson name')}</span><input value={node.title} maxLength={160} disabled={busy} onChange={event=>editNode(n=>{n.title=event.target.value})}/></label>
      <div data-route-field="objectives" className="route-editor-field route-editor-objectives"><div className="route-editor-field-heading"><span>{t('学习目标','Learning goals')}</span><EditorIcon label={t('添加目标','Add goal')} disabled={busy||node.objectives.length>=12} onClick={()=>editNode(n=>{n.objectives.push({id:newID('objective'),description:''});if(n.assessment)n.assessment.objectiveIds=n.objectives.map(o=>o.id)})}><Plus/></EditorIcon></div>{node.objectives.map((o,index)=><div key={o.id} className="route-editor-objective"><textarea data-route-field="description" aria-label={t('学习目标','Learning goal')+' '+(index+1)} value={o.description} disabled={busy} maxLength={2000} onChange={event=>editNode(n=>{n.objectives[index].description=event.target.value})}/>{node.objectives.length>1&&<EditorIcon label={t('删除目标','Delete goal')+' '+(index+1)} disabled={busy} onClick={()=>removeObjective(o.id)}><Trash2/></EditorIcon>}</div>)}</div>
      <label data-route-field="estimatedMinutes" className="route-editor-duration"><span>{t('预计时长','Estimated time')}</span><input type="number" min={1} max={1440} aria-label={t('预计时长（分钟）','Estimated time (minutes)')} value={node.estimatedMinutes} disabled={busy} onChange={event=>editNode(n=>{n.estimatedMinutes=Math.max(1,Math.min(1440,Number(event.target.value)||1))})}/><span>{t('分钟','min')}</span></label>
      <div className="route-editor-disclosures">
       <details data-route-section="assessment"><summary>{t('验收标准（可选）','Assessment (optional)')}<ChevronRight/></summary><div className="route-editor-disclosure-body">
        <div className="route-editor-assessment-control"><span>{t('启用验收','Enable assessment')}</span><GameToggle label={t('启用验收','Enable assessment')} checked={Boolean(node.assessment)} disabled={busy} onChange={checked=>editNode(n=>{if(checked)n.assessment={task:'',passCriteria:[''],objectiveIds:n.objectives.map(o=>o.id),mode:'quantitative'};else delete n.assessment})}/></div>
        {node.assessment&&<><label className="route-editor-field"><span>{t('验收方式','Assessment mode')}</span><select value={node.assessment.mode??'quantitative'} disabled={busy} onChange={event=>editNode(n=>{if(n.assessment){n.assessment.mode=event.target.value as 'quantitative'|'qualitative';if(n.assessment.mode==='qualitative')n.assessment.evaluatorPrompt??='';else delete n.assessment.evaluatorPrompt}})}><option value="quantitative">{t('量化标准','Quantitative')}</option><option value="qualitative">{t('AI评判','AI evaluation')}</option></select></label>
         <label data-route-field="task" className="route-editor-field"><span>{t('验收任务','Assessment task')}</span><textarea value={node.assessment.task} disabled={busy} maxLength={4000} onChange={event=>editNode(n=>{if(n.assessment)n.assessment.task=event.target.value})}/></label>
         <label data-route-field="passCriteria" className="route-editor-field"><span>{t('达标条件','Pass criteria')}</span><textarea value={node.assessment.passCriteria.join('\n')} placeholder={t('每行一项','One per line')} disabled={busy} maxLength={6000} onChange={event=>editNode(n=>{if(n.assessment)n.assessment.passCriteria=event.target.value.split('\n').slice(0,24)})} onBlur={()=>{if(node.assessment?.passCriteria.some(line=>!line.trim()))editNode(n=>{if(n.assessment)n.assessment.passCriteria=n.assessment.passCriteria.filter(line=>line.trim())})}}/></label>
         {node.assessment.mode==='qualitative'&&<label data-route-field="evaluatorPrompt" className="route-editor-field"><span>{t('评判提示词','Evaluation prompt')}</span><textarea value={node.assessment.evaluatorPrompt??''} disabled={busy} maxLength={4000} onChange={event=>editNode(n=>{if(n.assessment)n.assessment.evaluatorPrompt=event.target.value})}/></label>}
        </>}
       </div></details>
       <details data-route-section="more"><summary>{t('更多设置','More settings')}<ChevronRight/></summary><div className="route-editor-disclosure-body">
        <label className="route-editor-field"><span>{t('所属大章','Chapter')}</span><select value={chapter.id} disabled={busy} onChange={event=>moveToChapter(event.target.value)}>{route.chapters.map(ch=><option key={ch.id} value={ch.id} disabled={ch.id!==chapter.id&&ch.nodes.length>=64}>{ch.title||t('新大章节','New chapter')}</option>)}</select></label>
        <details className="route-editor-prerequisites"><summary>{t('前置章节','Prerequisites')}<ChevronRight/></summary><div>{nodes.filter(n=>n.id!==node.id).map(n=><label key={n.id}><input type="checkbox" checked={node.prerequisites.includes(n.id)} disabled={busy||!node.prerequisites.includes(n.id)&&node.prerequisites.length>=64} onChange={event=>editNode(item=>{item.prerequisites=event.target.checked?[...item.prerequisites,n.id]:item.prerequisites.filter(id=>id!==n.id)})}/><span>{n.title||t('未命名小章','Untitled lesson')}</span></label>)}{nodes.length<2&&<span>{t('暂无其他小章','No other lessons')}</span>}</div></details>
        <label data-route-field="activities" className="route-editor-field"><span>{t('学习活动','Learning activities')}</span><textarea aria-label={t('学习活动，每行一项','Learning activities, one per line')} placeholder={t('每行一项','One per line')} value={(node.activities??[]).join('\n')} disabled={busy} maxLength={6000} onChange={event=>editNode(n=>{if(event.target.value.trim())n.activities=event.target.value.split('\n').slice(0,24);else delete n.activities})} onBlur={()=>{if(node.activities?.some(line=>!line.trim()))editNode(n=>{if(n.activities){n.activities=n.activities.filter(line=>line.trim());if(!n.activities.length)delete n.activities}})}}/></label>
       </div></details>
      </div>
     </>:<>
      <label data-route-field="title" className="route-editor-field"><span>{t('大章名称','Chapter name')}</span><input value={chapter.title} maxLength={160} disabled={busy} onChange={event=>editChapter(ch=>{ch.title=event.target.value})}/></label>
      <label data-route-field="stageGoal" className="route-editor-field"><span>{t('大章目标','Stage goal')}</span><textarea value={chapter.stageGoal??''} maxLength={2000} disabled={busy} onChange={event=>editChapter(ch=>{ch.stageGoal=event.target.value})}/></label>
     </>}
    </>:<div className="route-editor-empty"><FileText aria-hidden="true"/><span>{t('暂无章节','No chapters')}</span></div>}
   </section>
   {state.provider&&<aside className="route-editor-assistant" aria-label={t('AI对话','AI conversation')}>
    <header><h2>{t('AI 对话','AI chat')}</h2><span><img src={ASSET+(selectedProvider?.icon??'agent-codex.png')} alt=""/>{selectedProvider?.name??state.provider}</span></header>
    {onOptions&&<PlanningModelControls state={state} language={language} busy={busy} onOptions={onOptions}/>}
    <PlanningMessages messages={state.messages.filter(message=>!message.questionId)} providerId={state.provider} language={language} busy={working} workingLabel={workingLabel} partialReply={partialReply} activity={activity} route={route}>
    {proposal&&<details key={proposal.baseRevision} className="route-editor-proposal"><summary><FileText/>{t('查看修改','Review changes')}<ChevronRight/></summary><p>{proposal.reply}</p><div><GameButton disabled={busy||dirty} onClick={onApply}>{t('采用修改','Apply')}</GameButton><GameButton variant="secondary" disabled={busy} onClick={onDiscard}>{t('放弃','Discard')}</GameButton></div></details>}
    </PlanningMessages>
    {conversationFeedback&&<div className="route-editor-conversation-feedback"><p role={conversationError?'alert':'status'}>{conversationFeedback}</p>{lastMessage?.role==='user'&&<GameButton variant="secondary" disabled={busy||working||Boolean(state.pending)} onClick={()=>void sendMessage(lastMessage.text,lastMessage.mentions,lastMessage.target)}>{t('重试','Retry')}</GameButton>}</div>}
    <PlanningComposer inputRef={composerRef} route={route} referenceRequest={referenceRequest} language={language} busy={working} disabled={busy&&!working} onSend={(text,mentions)=>sendMessage(text,mentions)} onCancel={onCancel} answeredText={answeredText} placeholder={t('提问或描述想调整的内容…','Ask about or adjust your route…')}/>
   </aside>}
  </div>
  <footer className="route-editor-footer"><span className="route-editor-save-state" role="status">{notice||(dirty?t('未保存','Unsaved'):state.confirmedRevision?t('已确认','Confirmed'):t('已保存','Saved'))}</span>{issues.length>0&&<button type="button" className="text-button route-editor-review" disabled={busy} onClick={()=>setIssuesOpen(true)}>{t('待补全 ','Review ')}{issues.length}{t(' 项',' items')}</button>}<EditorIcon label={t('撤销','Undo')} onClick={onUndo} disabled={busy||!dirty&&!state.undoRoute&&!state.history?.past.length}><Undo2/></EditorIcon><EditorIcon label={t('前进','Redo')} onClick={()=>onRedo?.()} disabled={busy||dirty||!state.history?.future.length}><Redo2/></EditorIcon><GameButton variant="secondary" disabled={busy} onClick={onSave}>{t('保存草稿','Save draft')}</GameButton><GameButton disabled={busy} onClick={()=>issues.length?setIssuesOpen(true):onConfirm()}>{t('确认路线','Confirm route')}</GameButton></footer>
  {error&&<div className="route-editor-feedback"><p className="form-message is-error" role="alert">{error}</p></div>}
  {issuesOpen&&<Modal title={t('待补全内容','Complete these items')} closeLabel={t('关闭','Close')} onClose={()=>setIssuesOpen(false)}><ul className="route-editor-issues">{issues.map(issue=><li key={issue.path}><button className="text-button" onClick={()=>locateIssue(issue.path)}><span title={issueLabel(issue.path)}>{issueLabel(issue.path)}</span><small>{issue.code==='required'?t('必填','Required'):issue.code==='dependencies'?t('检查依赖','Check dependencies'):issue.code==='duplicate'?t('重复','Duplicate'):issue.code==='count'?t('调整数量','Adjust count'):t('检查内容','Review content')}</small><ChevronRight/></button></li>)}</ul></Modal>}
  {moving&&<RouteMoveDialog route={route} source={moving} language={language} busy={busy} onMove={target=>moveTo(moving,target)} onClose={()=>setMoving(null)}/>}
  {remove&&<Modal title={remove.nodeId?t('删除小章节','Delete lesson'):t('删除大章节','Delete chapter')} closeLabel={t('关闭','Close')} onClose={()=>setRemove(null)} busy={busy}><p className="confirmation-copy">{t('删除章节及其下属内容，并移除其他章节对它的前置引用。','Delete this chapter and its content, and remove references to it from other lessons.')}</p><div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={()=>setRemove(null)}>{t('取消','Cancel')}</GameButton><GameButton variant="danger" disabled={busy} onClick={removeSelected}>{t('确认删除','Delete')}</GameButton></div></Modal>}
 </div></section>;
}
