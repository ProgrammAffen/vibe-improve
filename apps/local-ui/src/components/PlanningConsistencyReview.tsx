import {TriangleAlert} from 'lucide-react';
import {acceptedAnswer,questionLabel,type PlanningState,type QuestionId} from '../../../../packages/domain/planning.mjs';
import {translate,type Language} from '../i18n';
import GameButton from './GameButton';

const fieldLabels:Record<string,[string,string]>={topic:['主题','Topic'],outcome:['预期成果','Outcome'],context:['用途','Use'],criteria:['成功标准','Success criteria'],aids:['辅助资料','Learning aids'],experience:['已有基础','Experience'],support:['可用帮助','Support'],strategy:['学习方式','Approach'],weekly:['每周时间','Weekly time'],session:['单次时间','Session length'],schedule:['时间安排','Schedule'],deadline:['期限','Deadline'],deadlineType:['期限要求','Deadline requirement'],scope:['范围','Scope'],conditions:['条件','Conditions']};
export default function PlanningConsistencyReview({state,questionId,language,busy=false,onAccept,onLater}:{state:PlanningState;questionId:QuestionId;language:Language;busy?:boolean;onAccept:(issueId:string)=>void;onLater:()=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en),question=state.questions.find(item=>item.id===questionId),issues=state.consistency?.issues.filter(item=>item.questionId===questionId)??[];
 if(!question||question.status!=='needs-review'||!issues.length)return null;
 const original=acceptedAnswer(question);
 return <>{issues.map(issue=><section className="planning-consistency-review" key={issue.id} data-review-issue={issue.id} aria-label={t('待复核：','Review needed: ')+questionLabel(questionId,language)}>
  <h3><TriangleAlert aria-hidden="true"/>{t('待复核','Review needed')}</h3>
  <div className="planning-review-values"><h4>{t('原回答','Adopted answer')}</h4>{issue.fields.some(field=>original?.fields[field])?<dl>{issue.fields.map(field=>original?.fields[field]&&<div key={field}><dt>{fieldLabels[field]?.[language==='en'?1:0]??field}</dt><dd>{original.fields[field]}</dd></div>)}</dl>:<p>{original?.summary??question.summary}</p>}</div>
  <p className="planning-review-reason">{issue.reason}</p>
  {issue.suggestion&&<div className="planning-review-suggestion"><h4>{t('建议','Suggestion')}</h4><p>{issue.suggestion.summary}</p><dl>{Object.entries(issue.suggestion.fields).filter(([,value])=>value!==issue.suggestion!.summary).map(([field,value])=><div key={field}><dt>{fieldLabels[field]?.[language==='en'?1:0]??field}</dt><dd>{value}</dd></div>)}</dl></div>}
  <div className="planning-review-actions">{issue.suggestion&&<GameButton disabled={busy} onClick={()=>onAccept(issue.id)}>{t('采用建议','Use suggestion')}</GameButton>}<button className="text-button" type="button" disabled={busy} onClick={onLater}>{t('稍后处理','Later')}</button></div>
 </section>)}</>;
}
