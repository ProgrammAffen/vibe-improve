export const DEFAULT_QUESTION_IDS=Object.freeze(['goal','purpose','baseline','time']);
export const LEGACY_QUESTION_IDS=Object.freeze([...DEFAULT_QUESTION_IDS,'constraints']);
export const QUESTION_IDS=Object.freeze([...DEFAULT_QUESTION_IDS,'deadline','scope','constraints']);
export const QUESTION_FIELDS=Object.freeze({
 goal:['topic','outcome'],purpose:['context','criteria','aids'],baseline:['experience','support','strategy'],
 time:['weekly','session','schedule','deadline','deadlineType'],deadline:['deadline','deadlineType','strategy'],
 scope:['scope','strategy'],constraints:['scope','conditions','strategy']
});
const questions={
 goal:{
  label:['学习方向','Learning topic'],
  text:['你想学什么，或想解决什么问题？','What do you want to learn or solve?'],
  help:['可以只说一个主题，也可以说说你打算用在哪里。','Name a topic or tell us where you plan to use it.'],
  example:['我想学 SQL，用来做业务周报。','I want to learn SQL for a weekly business report.']
 },
 purpose:{
  label:['学成表现','Learning outcome'],
  text:['学完后，你希望能独立完成哪件事？','What do you want to do on your own by the end?'],
  help:['说出想完成的事，AI 可以帮你拟定达标标准。','Tell us what you want to do. AI can suggest how to check it.'],
  example:['能用订单表做出周报，并核对汇总结果。','Make a weekly report from order data and check the totals.']
 },
 baseline:{
  label:['已有基础','Starting point'],
  text:['你现在能自己做到哪一步？','What can you already do on your own?'],
  help:['选一项，或写下你做过的事。','Pick an option or describe something you have tried.']
 },
 time:{
  label:['每周时间','Weekly study time'],
  text:['你一周大概能学多久？','About how much time can you study each week?'],
  help:['可以填大概时长，或先生成未排期的路线。','Give a rough estimate or start with an unscheduled route.'],
  example:['每周5天，每次1小时。','Five days a week, one hour each time.']
 },
 deadline:{
  label:['完成期限','Target date'],
  text:['有必须赶上的日期吗？','Is there a date you must be ready by?']
 },
 scope:{
  label:['内容取舍','Topics to focus on'],
  text:['有必须学或可以暂缓的内容吗？','Is there anything you must cover or can leave for later?']
 },
 constraints:{
  label:['补充条件','Additional requirements'],
  text:['有会影响这条路线的必要条件吗？','Is there anything this plan needs to account for?']
 }
};
const index=locale=>locale==='en'?1:0;
export function questionLabel(id,locale){return questions[id]?.label[index(locale)]??''}
export function questionText(id,locale){return questions[id]?.text[index(locale)]??''}
export function questionHelp(id,locale){return questions[id]?.help?.[index(locale)]??''}
export function questionExample(id,locale){return questions[id]?.example?.[index(locale)]??''}
