import {LoaderCircle,ChevronDown,Activity} from 'lucide-react';
import type {PlanningActivity} from '../planning/service';
import {translate,type Language} from '../i18n';

const labels:Record<string,[string,string]>={preparing:['准备请求','Preparing'],connecting:['连接智能体','Connecting'],waiting:['等待模型输出','Waiting for output'],thinking:['模型正在思考','Model is thinking'],generating:['接收生成内容','Receiving content'],receiving:['接收完整结果','Receiving result'],finishing:['等待提交完成','Finishing submission'],parsing:['解析结果','Parsing result'],validating:['校验路线','Validating route'],total_timeout:['达到总时限','Time limit reached'],idle_timeout:['长时间无输出','No recent output'],handshake_timeout:['连接超时','Connection timed out']};
const clock=(ms:number)=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`};
export default function PlanningActivityPanel({activity,busy,language,label}:{activity:PlanningActivity;busy:boolean;language:Language;label?:string}){
 const t=(zh:string,en:string)=>translate(language,zh,en),latest=activity.events.at(-1),stage=latest&&labels[latest.stage],idle=Math.max(0,Math.floor((activity.durationMs-activity.lastActivityMs)/1000));
 return <section className="planning-activity" aria-label={t('CLI 实时活动','Live CLI activity')} data-stale={busy&&idle>=30||undefined}>
  <header><span>{busy?<LoaderCircle className="planning-activity-spinner" aria-hidden="true"/>:<Activity aria-hidden="true"/>}{!busy?t('本次活动记录','Request activity'):stage?stage[language==='en'?1:0]:label??t('等待输出','Waiting for output')}</span><time aria-live="off">{clock(activity.durationMs)}</time></header>
  <div className="planning-activity-counts" aria-live="off"><span>{t('思考字符','Thinking chars')} <strong>{activity.thinkingCharacters.toLocaleString()}</strong></span><span>{t('输出字符','Output chars')} <strong>{activity.outputCharacters.toLocaleString()}</strong></span></div>
  <p aria-live="off">{busy?(idle<3?t('刚刚收到活动','Activity just received'):t(`${idle} 秒前收到活动`,`${idle}s since last activity`)):t('本次请求已结束','Request ended')}{busy&&idle>=30&&t(' · 等待新的输出',' · Waiting for new output')}</p>
  <details aria-live="off"><summary>{t('CLI 实时活动','Live CLI activity')}<ChevronDown aria-hidden="true"/></summary><ol>{activity.events.map(event=><li key={event.sequence}><time>{clock(event.atMs)}</time><span>{(labels[event.stage]??labels.waiting)[language==='en'?1:0]}</span><small>{t('思考','Thought')} {event.thinkingCharacters.toLocaleString()} · {t('输出','Output')} {event.outputCharacters.toLocaleString()}</small></li>)}</ol></details>
 </section>;
}
