import {useEffect,useRef} from 'react';
import {CheckCircle2,LoaderCircle,Square,TriangleAlert} from 'lucide-react';
import {planningQualityMessage,type GenerationOutput,type PlanningActivity,type PlanningJob} from '../planning/service';
import type {GenerationEntry} from '../planning/output';
import {translate,type Language} from '../i18n';
import Modal from './Modal';
import GameButton from './GameButton';
import PlanningActivityPanel from './PlanningActivityPanel';

const entryLabels:Record<GenerationOutput['kind'],[string,string]>={
 consistency:['检查回答','Checking answers'],
 outline:['路线总纲','Route outline'],
 lessons:['章节内容','Lesson content'],
 review:['内容复核','Content review'],
 revision:['章节修正','Lesson revision'],
};

export function PlanningGenerationLog({entries,language,running}:{entries:GenerationEntry[];language:Language;running:boolean}){
 const end=useRef<HTMLDivElement>(null),follow=useRef(true),last=entries.at(-1);
 const t=(zh:string,en:string)=>translate(language,zh,en);
 useEffect(()=>{if(follow.current)end.current?.scrollIntoView({block:'nearest'})},[entries.length,last?.text,last?.state]);
 return <div className="planning-generation-log" role="log" aria-live="off" aria-label={t('路线生成记录','Route generation output')} onScroll={event=>{const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<72}}>
  {!entries.length&&<p className="planning-generation-waiting">{t('正在准备生成…','Preparing generation…')}</p>}
  {entries.map(entry=>{
   const incomplete=entry.state==='incomplete',streaming=entry.state==='streaming'&&running;
   const finished=entry.state==='complete'&&entry.form==='content',quality=entry.kind==='review'||entry.kind==='revision';
   const status=incomplete?t('未完成','Incomplete'):streaming?t('接收中','Receiving'):finished?(quality?t('已完成','Completed'):t('已整理','Ready')):t('已接收','Received');
   return <article key={entry.id} className="planning-generation-entry" data-state={entry.state}>
    <header><strong>{t(...entryLabels[entry.kind])}</strong><span>{incomplete?<TriangleAlert aria-hidden="true"/>:streaming?<LoaderCircle aria-hidden="true"/>:finished?<CheckCircle2 aria-hidden="true"/>:null}{status}</span></header>
    {entry.text&&<p>{entry.text}</p>}
   </article>;
  })}<div ref={end}/>
 </div>;
}
export default function PlanningGenerationDialog({language,entries,running,activity,label,error,qualityReason,qualitySummary,restartGeneration,reviewNeeded,savedProgress,onResume,onRestart,onStop,onClose}:{language:Language;entries:GenerationEntry[];running:boolean;activity?:PlanningActivity;label?:string;error:string;qualityReason?:PlanningJob['qualityReason'];qualitySummary?:PlanningJob['qualitySummary'];restartGeneration?:true;reviewNeeded:boolean;savedProgress?:{completed:number;total:number;resumable:boolean};onResume?:()=>void;onRestart?:()=>void;onStop:()=>void;onClose:()=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const failure=reviewNeeded?t('部分回答需要核对，确认后才能生成路线。','Review the flagged answers before generating your route.'):
  qualityReason?planningQualityMessage(qualityReason,qualitySummary,language):error;
 const title=running?t('生成路线','Generate route'):failure?t('未生成新路线','No new route generated'):t('已停止生成','Generation stopped');
 return <Modal className={`planning-generation-dialog${running?'':' planning-generation-dialog--result'}`} title={title} closeLabel={t('关闭','Close')} busy={running} onClose={onClose}>
  {running?<>
   <div className="planning-generation-status" role="status"><LoaderCircle aria-hidden="true"/>{label??t('正在生成…','Generating…')}</div>
   <PlanningGenerationLog entries={entries} language={language} running/>
   {activity&&<PlanningActivityPanel activity={activity} busy={running} language={language} label={label}/>}
   {error&&<p className="form-message is-error" role="alert">{error}</p>}
  </>:<>
   {failure&&<p className="form-message is-error" role="alert">{failure}</p>}
   {savedProgress?.resumable&&!restartGeneration&&<p className="planning-generation-resume-note">{t('已保存生成进度','Generation progress saved')} · {savedProgress.completed} / {savedProgress.total}</p>}
  </>}
  <div className="planning-generation-actions">{running?<GameButton variant="secondary" leadingIcon={<Square focusable="false"/>} onClick={onStop}>{t('停止生成','Stop generation')}</GameButton>:<>
   <GameButton variant="secondary" onClick={onClose}>{t('返回规划','Back to planning')}</GameButton>
   {!reviewNeeded&&(onRestart&&(restartGeneration||!savedProgress?.resumable)?<GameButton onClick={onRestart}>{t('重新生成','Regenerate route')}</GameButton>:savedProgress?.resumable&&onResume&&<GameButton onClick={onResume}>{t('继续生成','Resume generation')}</GameButton>)}
  </>}</div>
 </Modal>;
}
