import {useState,useRef,type KeyboardEvent} from 'react';
import {Check,FileText,FolderOpen} from 'lucide-react';
import {routeOutline,routeMoveProblem,routeTargetPosition} from '../../../../packages/domain/route-order.mjs';
import type {PlanningTarget} from '../../../../packages/domain/planning.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import {translate,type Language} from '../i18n';
import {planningTargetLabel} from '../planning/references';
import GameButton from './GameButton';
import Modal from './Modal';

export default function RouteMoveDialog({route,source,language,busy,onMove,onClose}:{route:RouteDocument;source:PlanningTarget;language:Language;busy:boolean;onMove:(target:PlanningTarget)=>void;onClose:()=>void}){
 const [target,setTarget]=useState<PlanningTarget|null>(null),tree=useRef<HTMLUListElement>(null),t=(zh:string,en:string)=>translate(language,zh,en);
 const sourcePosition=routeTargetPosition(route,source),targetPosition=target&&routeTargetPosition(route,target),valid=Boolean(target&&!routeMoveProblem(route,source,target));
 function reason(value:PlanningTarget){const problem=routeMoveProblem(route,source,value);return problem==='chapter-only'?t('仅可选择大章节','Choose a chapter'):problem==='full'?t('该大章节已满','Chapter is full'):problem==='self'?t('当前章节','Current item'):problem==='same-position'?t('当前位置','Current position'):problem?t('章节已不可用','Item unavailable'):''}
 function keydown(event:KeyboardEvent<HTMLUListElement>){
  const buttons=Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.focus()}
 }
 function row(value:PlanningTarget,number:string,title:string,chapter=false){
  const problem=routeMoveProblem(route,source,value),selected=target?.chapterId===value.chapterId&&(target?.nodeId??null)===(value.nodeId??null);
  return <button type="button" role="treeitem" aria-level={chapter?1:2} aria-expanded={chapter?true:undefined} aria-selected={selected} className={`route-move-row ${chapter?'is-chapter':''} ${selected?'is-selected':''}`} disabled={busy||Boolean(problem)} title={reason(value)||`${number} ${title}`} data-move-chapter={value.chapterId} data-move-node={value.nodeId} onClick={()=>setTarget(value)}>
   {chapter?<FolderOpen aria-hidden="true"/>:<FileText aria-hidden="true"/>}<span className="route-move-number">{number}</span><strong>{title}</strong>{selected&&<Check aria-hidden="true"/>}{problem&&['self','same-position'].includes(problem)&&<small>{reason(value)}</small>}
  </button>;
 }
 return <Modal className="route-move-dialog" title={t('移动到','Move to')} closeLabel={t('关闭','Close')} onClose={onClose} busy={busy}>
  <p className="route-move-source" title={planningTargetLabel(route,source,language)}>{sourcePosition?.number} · {source.nodeId?t('小章节','Lesson'):t('大章节','Chapter')}</p>
  <ul ref={tree} className="route-move-tree" role="tree" aria-label={t('选择移动位置','Choose destination')} onKeyDown={keydown}>
   {routeOutline(route).map(({chapter,number,lessons})=><li key={chapter.id} role="none">{row({chapterId:chapter.id},number,chapter.title||t('新大章节','New chapter'),true)}
    {lessons.length>0&&<ul role="group">{lessons.map(({node,number})=><li key={node.id} role="none">{row({chapterId:chapter.id,nodeId:node.id},number,node.title||t('新小章节','New lesson'))}</li>)}</ul>}
   </li>)}
  </ul>
  <p className="route-move-destination" role="status">{targetPosition&&valid?(source.nodeId&&!target?.nodeId?t(`作为第 ${targetPosition.chapterIndex+1} 章的首个小章节`,`First lesson in chapter ${targetPosition.chapterIndex+1}`):t(`移到 ${targetPosition.number} 之后`,`After ${targetPosition.number}`)):t('选择目标章节','Select a destination')}</p>
  <div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={onClose}>{t('取消','Cancel')}</GameButton><GameButton disabled={busy||!valid} onClick={()=>{if(valid&&target)onMove(target)}}>{t('确认移动','Move here')}</GameButton></div>
 </Modal>;
}
