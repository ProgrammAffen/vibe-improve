import type {QuestionId} from '../../../../packages/domain/planning.mjs';
import {translate,type Language} from '../i18n';

type QuickAnswer={label:string;reply:string};

export function quickAnswers(questionId:QuestionId,topic:string,language:Language,generatedOptions?:string[]):QuickAnswer[]{
 const t=(zh:string,en:string)=>translate(language,zh,en);
 if(questionId==='time')return [{
  label:t('暂不排期','No schedule yet'),
  reply:t('我还不确定每周能学多久，先生成未排期的路线。','I am not sure how much time I have each week. Start with an unscheduled route.'),
 }];
 if(questionId!=='baseline')return [];

 const fallback=/\b(?:sql|mysql|postgresql|sqlite)\b/i.test(topic)?[
  t('没写过查询','Never written a query'),
  t('跟着教程写过查询','Followed a SQL tutorial'),
  t('能独立查询单张表','Can query one table on my own'),
 ]:[
  t('完全没接触过','Never tried it'),
  t('跟着示例做过','Followed an example'),
  t('能独立完成基础任务','Can do a basic task on my own'),
 ];
 const choices=generatedOptions?.length?generatedOptions:fallback;
 const unknown=t('不确定','Not sure');
 return [
  ...choices.filter(label=>label!==unknown).map(label=>({label,reply:label})),
  {label:unknown,reply:t('我不确定自己现在能做到哪一步。','I am not sure what I can do on my own yet.')},
 ];
}
