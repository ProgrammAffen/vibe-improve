import {answerConfirmation,intakeQuestions,questionLabel,type PlanningState,type QuestionId} from '../../../../packages/domain/planning.mjs';
import {translate,type Language} from '../i18n';
import GameButton from './GameButton';

export default function PlanningAnswerReview({state,questionId,language,busy=false,onAccept,onClarify}:{state:PlanningState;questionId:QuestionId;language:Language;busy?:boolean;onAccept:()=>void;onClarify:()=>void}){
 const t=(zh:string,en:string)=>translate(language,zh,en);
 const question=state.questions.find(question=>question.id===questionId);
 const proposal=question?.answerProposal;
 const confirmation=answerConfirmation(state,questionId);
 if(!question||!proposal||!confirmation)return null;
 const questions=intakeQuestions(state);
 return <section className="planning-answer-review" aria-label={t('回答总结','Answer summary')} data-confirmation={confirmation.kind}>
  <h3>{t('回答总结','Answer summary')}{question.evidence.some(item=>'reusedFrom' in item)&&<small>{t('参考了之前的回答','Based on earlier answers')}</small>}</h3><p>{proposal.summary}</p>
  {confirmation.changes.map(change=>{
   const number=questions.findIndex(question=>question.id===change.questionId)+1;
   const fields=Object.keys(change.after.fields).filter(field=>change.after.fields[field]!==change.before.fields[field]);
   return <div className="planning-answer-change" key={change.questionId}>
    <h4>{t(`本次回答将调整第 ${number} 题`,`This answer updates Question ${number}`)} · {questionLabel(change.questionId,language)}</h4>
    <dl><div><dt>{t('之前','Before')}</dt><dd>{fields.map(field=>change.before.fields[field]).filter(Boolean).join('\n')||change.before.summary}</dd></div><div><dt>{t('调整后','After')}</dt><dd>{fields.map(field=>change.after.fields[field]).join('\n')}</dd></div></dl>
    <p>{change.reason}</p>
   </div>;
  })}
  {confirmation.kind==='clarify'&&<div className="planning-answer-clarify"><h4>{t('先确认一下你的意思','Let’s clarify your intent')}</h4>{confirmation.issues.map((issue,index)=><p key={index}>{issue.reason}</p>)}<p>{t('在下方继续补充，整理清楚后再确认。','Add details below, then confirm the revised summary.')}</p></div>}
  {confirmation.kind==='stale'&&<p>{t('前文已更新，请继续补充，让智能体重新整理该回答。','Earlier answers changed. Add details so the agent can update this summary.')}</p>}
  <div className="planning-answer-actions"><button type="button" className="text-button planning-answer-continue" disabled={busy} onClick={onClarify}>{t('继续补充','Add details')}</button>{confirmation.canAccept&&<GameButton disabled={busy} onClick={onAccept}>{confirmation.kind==='update'?t('确认调整并继续','Confirm & continue'):t('确认回答','Confirm answer')}</GameButton>}</div>
 </section>;
}
