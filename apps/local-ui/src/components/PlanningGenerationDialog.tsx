import {useEffect,useRef} from 'react';
import {CheckCircle2,LoaderCircle,Square,TriangleAlert} from 'lucide-react';
import type {PlanningActivity} from '../planning/service';
import type {GenerationEntry} from '../planning/output';
import {translate,type Language} from '../i18n';
import Modal from './Modal';
import GameButton from './GameButton';
import PlanningActivityPanel from './PlanningActivityPanel';

export function PlanningGenerationLog({entries,language,running}:{entries:GenerationEntry[];language:Language;running:boolean}){
 const end=useRef<HTMLDivElement>(null),follow=useRef(true),last=entries.at(-1);
 const t=(zh:string,en:string)=>translate(language,zh,en);
 useEffect(()=>{if(follow.current)end.current?.scrollIntoView({block:'nearest'})},[entries.length,last?.text,last?.state]);
 return <div className="planning-generation-log" role="log" aria-live="off" aria-label={t('路线生成记录','Route generation output')} onScroll={event=>{const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<72}}>
  {!entries.length&&<p className="planning-generation-waiting">{t('正在准备生成…','Preparing generation…')}</p>}
  {entries.map(entry=><article key={entry.id} className="planning-generation-entry" data-state={entry.state}>
   <header><strong>{entry.kind==='consistency'?t('检查回答','Checking answers'):entry.kind==='outline'?t('路线总纲','Route outline'):t('章节内容','Lesson content')}</strong><span>{entry.form==='content'?<CheckCircle2 aria-hidden="true"/>:entry.state==='incomplete'?<TriangleAlert aria-hidden="true"/>:entry.state==='streaming'&&running?<LoaderCircle aria-hidden="true"/>:null}{entry.form==='content'?t('已整理','Ready'):entry.state==='incomplete'?t('未完成','Incomplete'):entry.state==='streaming'&&running?t('接收中','Receiving'):t('已接收','Received')}</span></header>
   {entry.text&&<p>{entry.text}</p>}
  </article>)}<div ref={end}/>
 </div>;
}
export default function PlanningGenerationDialog({language,entries,running,activity,label,error,reviewNeeded,savedProgress,onResume,onStop,onClose}:{language:Language;entries:GenerationEntry[];running:boolean;activity?:PlanningActivity;label?:string;error:string;reviewNeeded:boolean;savedProgress?:{completed:number;total:number;resumable:boolean};onResume?:()=>void;onStop:()=>void;onClose:()=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 return <Modal className="planning-generation-dialog" title={t('生成路线','Generate route')} closeLabel={t('关闭','Close')} busy={running} onClose={onClose}>
  <div className="planning-generation-status" role="status">{running?<LoaderCircle aria-hidden="true"/>:<TriangleAlert aria-hidden="true"/>}{running?label??t('正在生成…','Generating…'):reviewNeeded?t('请先复核回答','Review your answers first'):error?t('生成未完成','Generation incomplete'):t('已停止','Stopped')}</div>
  <PlanningGenerationLog entries={entries} language={language} running={running}/>
  {activity&&<PlanningActivityPanel activity={activity} busy={running} language={language} label={label}/>}
  {error&&<p className="form-message is-error" role="alert">{error}</p>}
  {!running&&savedProgress&&<p className="planning-generation-resume-note" role="status">{t('已保存生成进度','Generation progress saved')} · {savedProgress.completed} / {savedProgress.total} · {t('原路线未改变','Your route is unchanged')}</p>}
  <div className="planning-generation-actions">{running?<GameButton variant="secondary" leadingIcon={<Square focusable="false"/>} onClick={onStop}>{t('停止生成','Stop generation')}</GameButton>:<><GameButton variant="secondary" onClick={onClose}>{t('返回规划','Back to planning')}</GameButton>{savedProgress?.resumable&&!reviewNeeded&&onResume&&<GameButton onClick={onResume}>{t('继续生成','Resume generation')}</GameButton>}</>}</div>
 </Modal>;
}
