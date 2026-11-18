import {useEffect,useId,useRef,useState} from 'react';
import {CheckCircle2,ChevronRight,LoaderCircle,Square,TriangleAlert} from 'lucide-react';
import type {GenerationProgress} from '../../../../packages/domain/planning.mjs';
import {planningQualityMessage,type GenerationOutput,type PlanningActivity,type PlanningJob} from '../planning/service';
import {generationMeter,type GenerationStage} from '../planning/generation';
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
const steps:[string,string][]=[['准备','Prepare'],['总纲','Outline'],['小节','Lessons'],['审核','Review'],['保存','Save']];
const phaseDescriptions:Record<GenerationStage['phase'],[string,string]>={
 prepare:['核对已确认的答案，整理已解析的学习资料。','Check confirmed answers and prepare the parsed resources.'],
 outline:['安排大章、小节顺序和前置知识。','Organize chapters, lessons, and prerequisites.'],
 lessons:['为每节编写学习目标、学习活动和预计时长。','Write learning goals, activities, and estimated time for each lesson.'],
 review:['检查目标覆盖、先修顺序、学习活动和时间安排。','Check goal coverage, prerequisites, learning activities, and timing.'],
 revision:['修正审核发现的问题，再检查更新后的路线。','Fix the issues found in review, then check the updated route.'],
 finalize:['校验完整路线、章节依赖和资料引用。','Validate the complete route, its prerequisites, and resource links.'],
 saving:['保存完整草稿并准备打开路线编辑器。','Save the complete draft and open the route editor.'],
 complete:['路线草稿已保存。','The route draft was saved.'],
};

function GenerationMeter({stage,language,running}:{stage:GenerationStage;language:Language;running:boolean}){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const {step,value}=generationMeter(stage);
 const count=stage.phase==='lessons'&&stage.total!==undefined?t(`已保存 ${stage.completed} / ${stage.total} 节`,`${stage.completed} / ${stage.total} lessons saved`):undefined;
 return <section className="route-generation-meter" aria-label={t('生成路线进度','Route generation progress')}>
  <progress max={100} value={value} aria-label={t('生成路线进度','Route generation progress')} aria-valuetext={count??t(...steps[step])}/>
  <ol>{steps.map((label,index)=><li key={label[1]} data-state={stage.phase==='complete'||index<step?'done':index===step?'current':undefined}
    aria-current={index===step&&stage.phase!=='complete'?'step':undefined}>{t(...label)}</li>)}</ol>
  {running&&<p className="route-generation-phase" role="status"><span>{t(...phaseDescriptions[stage.phase])}</span>{count&&<strong>{count}</strong>}</p>}
 </section>;
}

export function PlanningGenerationLog({entries,language,running=true,id}:{entries:GenerationEntry[];language:Language;running?:boolean;id?:string}){
 const end=useRef<HTMLDivElement>(null),follow=useRef(true),last=entries.at(-1);
 const t=(zh:string,en:string)=>translate(language,zh,en);
 useEffect(()=>{if(follow.current)end.current?.scrollIntoView({block:'nearest'})},[entries.length,last?.text,last?.state]);
 return <div id={id} className="planning-generation-log" role="log" aria-live="off" aria-label={t('路线生成记录','Route generation output')} onScroll={event=>{const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<72}}>
  {!entries.length&&<p className="planning-generation-waiting">{t('正在准备生成…','Preparing generation…')}</p>}
  {entries.map(entry=>{
   const incomplete=entry.state==='incomplete'||!running&&entry.state==='streaming',streaming=running&&entry.state==='streaming';
   const finished=entry.state==='complete'&&entry.form==='content',quality=entry.kind==='review'||entry.kind==='revision';
   const status=incomplete?t('未完成','Incomplete'):streaming?t('接收中','Receiving'):finished?(quality?t('已完成','Completed'):t('已整理','Ready')):t('已接收','Received');
   return <article key={entry.id} className="planning-generation-entry" data-state={incomplete?'incomplete':entry.state}>
    <header>
     <strong>{t(...entryLabels[entry.kind])}</strong>
     <span>
      {streaming?<LoaderCircle className="planning-activity-spinner" aria-hidden="true"/>:
       incomplete?<TriangleAlert aria-hidden="true"/>:finished?<CheckCircle2 aria-hidden="true"/>:null}
      {status}
     </span>
    </header>
    {entry.text&&<p>{entry.text}</p>}
   </article>;
  })}<div ref={end}/>
 </div>;
}
export default function PlanningGenerationDialog({language,entries,running,stage={phase:'prepare'},activity,label,error,qualityReason,qualitySummary,reviewNeeded,savedProgress,onResume,onRestart,onStop,onClose}:{language:Language;entries:GenerationEntry[];running:boolean;stage?:GenerationStage;activity?:PlanningActivity;label?:string;error:string;qualityReason?:PlanningJob['qualityReason'];qualitySummary?:PlanningJob['qualitySummary'];reviewNeeded:boolean;savedProgress?:GenerationProgress;onResume?:()=>void;onRestart?:()=>void;onStop:()=>void;onClose:()=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const [showOutput,setShowOutput]=useState(false);
 const outputId=useId();
 useEffect(()=>{if(running)setShowOutput(false)},[running]);
 const failure=reviewNeeded?t('部分回答需要核对，确认后才能生成路线。','Review the flagged answers before generating your route.'):
  qualityReason?planningQualityMessage(qualityReason,qualitySummary,language):error;
 const paused=!reviewNeeded&&savedProgress?.resumable&&(savedProgress.revised!==undefined||Boolean(qualityReason));
 const title=running?t('生成路线','Generate route'):paused?t('路线修订已暂停','Route revision paused'):failure?t('未生成新路线','No new route generated'):t('已停止生成','Generation stopped');
 return <Modal className={`planning-generation-dialog${running?'':' planning-generation-dialog--result'}${!running&&showOutput?' planning-generation-dialog--history':''}`} title={title} closeLabel={t('关闭','Close')} busy={running} onClose={onClose}>
  <GenerationMeter stage={stage} language={language} running={running}/>
  {running?<>
   <PlanningGenerationLog entries={entries} language={language}/>
   {activity&&<PlanningActivityPanel activity={activity} busy={running} language={language} label={label}/>}
   {error&&<p className="form-message is-error" role="alert">{error}</p>}
  </>:<>
   {failure&&<p className={paused?'planning-generation-resume-note':'form-message is-error'} role={paused?'status':'alert'}>{failure}</p>}
   {savedProgress?.resumable&&<p className="planning-generation-resume-note">{savedProgress.revised
     ?t(`已保存 ${savedProgress.revised} 节修订`,`${savedProgress.revised} revised ${savedProgress.revised===1?'lesson':'lessons'} saved`)
     :<>{t('已保存生成进度','Generation progress saved')} · {savedProgress.completed} / {savedProgress.total}</>}</p>}
   {entries.length>0&&<section className="planning-generation-result-output" data-open={showOutput||undefined}>
    <button type="button" className="text-button planning-generation-output-toggle" aria-expanded={showOutput} aria-controls={showOutput?outputId:undefined} onClick={()=>setShowOutput(value=>!value)}><ChevronRight aria-hidden="true"/>{t('查看生成记录','View generation record')}</button>
    {showOutput&&<PlanningGenerationLog id={outputId} entries={entries} language={language} running={false}/>}
   </section>}
  </>}
  <div className="planning-generation-actions">{running?<GameButton variant="secondary" leadingIcon={<Square focusable="false"/>} onClick={onStop}>{t('停止生成','Stop generation')}</GameButton>:<>
   <GameButton variant="secondary" onClick={onClose}>{t('返回规划','Back to planning')}</GameButton>
   {!reviewNeeded&&(savedProgress?.resumable?onResume&&<GameButton onClick={onResume}>{t('继续生成路线','Resume generation')}</GameButton>:onRestart&&<GameButton onClick={onRestart}>{t('生成路线','Generate route')}</GameButton>)}
  </>}</div>
 </Modal>;
}
