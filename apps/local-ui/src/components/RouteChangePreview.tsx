import {ChevronRight,FileText} from 'lucide-react';
import type {ReactNode} from 'react';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import {useMemo} from 'react';
import {routeChanges} from '../../../../packages/domain/route-changes.mjs';
import {translate,type Language} from '../i18n';

type Props={before:RouteDocument;after:RouteDocument;language:Language;status:'pending'|'applied'|'saved';children?:ReactNode;warning?:string};
export default function RouteChangePreview({before,after,language,status,children,warning}:Props){
 const t=(zh:string,en:string)=>translate(language,zh,en),changes=useMemo(()=>routeChanges(before,after,language),[before,after,language]);
 const labels:Record<string,string>={title:t('名称','Name'),stageGoal:t('大章目标','Chapter goal'),position:t('位置','Position'),objectives:t('学习目标','Learning goals'),estimatedMinutes:t('预计时长（分钟）','Estimated time (minutes)'),requirement:t('小节性质','Lesson requirement'),prerequisites:t('前置小节','Prerequisites'),activities:t('学习活动','Learning activities'),quiz:t('验收测验','Assessment quiz'),answer:t('测验答案／评判标准','Quiz answers / grading criteria'),reviewEnabled:t('复习设置','Review settings'),reviewContent:t('复习内容','Review content'),reviewCriteria:t('回答正确的指标','Criteria for a correct answer')};
 const value=(key:string,values:string[])=>values.map(value=>key==='requirement'?(value==='optional'?t('选学','Elective'):t('必学','Required')):key==='reviewEnabled'?(value==='on'?t('开启','On'):t('关闭','Off')):value);
 const renderValue=(key:string,values:string[])=>!values.length?<p className="route-change-empty">{t('未设置','Not set')}</p>:values.length===1?<p>{value(key,values)[0]}</p>:<ul>{value(key,values).map((item,index)=><li key={index}>{item}</li>)}</ul>;
 return <details open className="route-editor-proposal route-change-preview" data-change-status={status}>
  <summary><FileText aria-hidden="true"/><span>{status==='pending'?t('查看修改','Review changes'):status==='applied'?t('已采用的修改','Applied changes'):t('最近保存的修改','Latest saved changes')}</span><ChevronRight aria-hidden="true"/></summary>
  <section className="route-change-list" aria-label={t('实际修改内容','Actual changes')}>
   {changes.map(change=><section key={change.kind+':'+(change.id??'route')} className="route-change-item">
    <h3>{change.number&&<span>{change.number} </span>}{change.title}{change.status==='added'&&<small>{t('新增','Added')}</small>}{change.status==='removed'&&<small>{t('删除','Removed')}</small>}</h3>
    {change.fields.map(field=><section key={field.key} className="route-change-field" data-change-field={field.key}>
     <h4>{labels[field.key]??t('内容','Content')}</h4>
     <div className="route-change-before"><small>{t('修改前','Before')}</small>{renderValue(field.key,field.before)}</div>
     <div className="route-change-after"><small>{t('修改后','After')}</small>{renderValue(field.key,field.after)}</div>
    </section>)}
   </section>)}
   {!changes.length&&<p>{t('章节内容相同，路线格式或关联已更新。','Lesson content is unchanged; route formatting or references were updated.')}</p>}
  </section>
  {warning&&<p className="route-editor-proposal-warning">{warning}</p>}
  {children&&<div className="route-change-actions">{children}</div>}
 </details>;
}
