import type {QuestionId} from '../../../../packages/domain/planning.mjs';
import {translate,type Language} from '../i18n';

const labels:Record<string,[string,string]>={
 topic:['学习方向','Learning topic'],outcome:['希望学会的事','Intended outcome'],context:['学习用途','Purpose'],criteria:['达标表现','Success criteria'],aids:['可用帮助','Available help'],
 experience:['已有基础','Prior knowledge'],support:['学习支持','Learning support'],strategy:['学习安排','Learning approach'],weekly:['每周学习时间','Weekly study time'],session:['每次学习时长','Session length'],schedule:['时间安排','Schedule'],
 deadline:['目标日期','Target date'],deadlineType:['期限要求','Deadline requirement'],scope:['学习范围','Learning scope'],conditions:['练习条件','Practice conditions'],
};

export default function PlanningAnswerFields({fields,language,questionId}:{fields:Record<string,string>;language:Language;questionId:QuestionId}){
 const t=(zh:string,en:string)=>translate(language,zh,en),items=Object.keys(labels).filter(key=>fields[key]?.trim());
 if(!items.length)return null;
 return <details className="planning-answer-fields" data-answer-question={questionId}>
  <summary>{t('查看采集内容','View captured details')}</summary>
  <dl>{items.map(key=><div key={key} data-answer-field={key}><dt>{t(...labels[key])}</dt><dd>{fields[key]}</dd></div>)}</dl>
 </details>;
}
