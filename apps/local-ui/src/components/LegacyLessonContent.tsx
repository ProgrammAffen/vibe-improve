import type {RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {assessmentAnswer} from '../../../../packages/domain/assessment.mjs';
import {translate, type Language} from '../i18n';

/** Kept readable for older routes; new quizzes and review are created after study. */
export default function LegacyLessonContent({node, language, collapsible = false}: {node: RouteNode; language: Language; collapsible?: boolean}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const assessment = node.assessment && <>
    <p className="lesson-assessment-text">{node.assessment.task}</p>
    <details className="lesson-assessment-answer"><summary>{t('查看测验答案／评判标准', 'Show quiz answers / grading criteria')}</summary><p className="lesson-assessment-text">{assessmentAnswer(node.assessment, language)}</p></details>
  </>;
  const review = node.review && <><p>{node.review.content}</p><h3>{t('回答正确的指标', 'Criteria for a correct answer')}</h3><ul>{node.review.passCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></>;
  return <>
    {assessment && (collapsible ? <details className="lesson-assessment notebook-legacy-followup"><summary>{t('验收测验', 'Assessment quiz')}</summary>{assessment}</details> : <section className="lesson-assessment"><h2>{t('验收测验', 'Assessment quiz')}</h2>{assessment}</section>)}
    {review && (collapsible ? <details className="lesson-review notebook-legacy-followup"><summary>{t('复习内容', 'Review content')}</summary>{review}</details> : <section className="lesson-review"><h2>{t('复习内容', 'Review content')}</h2>{review}</section>)}
  </>;
}
