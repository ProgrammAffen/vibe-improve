import {TriangleAlert} from 'lucide-react';
import {acceptedAnswer,intakeQuestions,questionLabel,type PlanningState,type QuestionId} from '../../../../packages/domain/planning.mjs';
import {translate,type Language} from '../i18n';
import GameButton from './GameButton';

export default function PlanningConsistencyReview({state,language,busy=false,onAccept,onReanswer}:{state:PlanningState;language:Language;busy?:boolean;onAccept:(issueId:string)=>void;onReanswer:(questionId:QuestionId)=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en),questions=intakeQuestions(state);
 const issues=state.consistency?.issues.filter(issue=>state.questions.find(question=>question.id===issue.questionId)?.status==='needs-review')??[];
 return <>{issues.map(issue=>{
  const question=state.questions.find(item=>item.id===issue.questionId)!,original=acceptedAnswer(question);
  const number=questions.findIndex(item=>item.id===issue.questionId)+1;
  return <section className="planning-consistency-review" key={issue.id} data-review-issue={issue.id} aria-label={t('回答需要确认：','Answer review: ')+questionLabel(issue.questionId,language)}>
   <h3><TriangleAlert aria-hidden="true"/>{t('回答需要确认','Answer review')}</h3>
   <h4>{t(`第 ${number} 题`,`Question ${number}`)} · {questionLabel(issue.questionId,language)}</h4>
   <p className="planning-review-reason">{issue.reason}</p>
   <div className="planning-review-values"><h4>{t('之前','Before')}</h4><p>{issue.fields.map(field=>original?.fields[field]).filter(Boolean).join('\n')||original?.summary||question.summary}</p></div>
   {issue.suggestion&&<div className="planning-review-suggestion"><h4>{t('调整后','After')}</h4><p>{Object.values(issue.suggestion.fields).join('\n')}</p></div>}
   <div className="planning-review-actions"><button className="text-button planning-answer-continue" type="button" disabled={busy} onClick={()=>onReanswer(issue.questionId)}>{t('重新回答','Answer again')}</button>{issue.suggestion&&<GameButton disabled={busy} onClick={()=>onAccept(issue.id)}>{t('确认调整','Confirm update')}</GameButton>}</div>
  </section>;
 })}</>;
}
