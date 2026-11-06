import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {AgentOptions,PlanningState} from '../../../../packages/domain/planning.mjs';
import {planningService,planningMessage,type ModelCatalog} from '../planning/service';
import {translate,type Language} from '../i18n';

export default function PlanningModelControls({state,language,busy,onOptions}:{state:PlanningState;language:Language;busy:boolean;onOptions:(options:AgentOptions)=>void}){
 const [catalog,setCatalog]=useState<ModelCatalog|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 const t=(zh:string,en:string)=>translate(language,zh,en),options=state.agentOptions??{model:null,effort:null};
 useEffect(()=>{let active=true;setLoading(true);setError('');setCatalog(null);void planningService.models(state.projectId,attempt>0).then(data=>{if(active&&data.provider===state.provider)setCatalog(data)}).catch(cause=>{if(active)setError(planningMessage(cause,language))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[state.projectId,state.provider,attempt]);
 const models=catalog?.models??[],selected=models.find(m=>m.id===options.model)??(!options.model?models.find(m=>m.isDefault):undefined),efforts=selected?.efforts??[];
 const effortName=(id:string)=>({none:t('无','None'),minimal:t('最低','Minimal'),low:t('低','Low'),medium:t('中','Medium'),high:t('高','High'),xhigh:t('极高','Extra high'),max:t('最高','Max')}[id]??id);
 return <div className="planning-model-controls" aria-busy={loading}>
  <label><span>{t('模型','Model')}</span><select aria-label={t('AI模型','AI model')} title={options.model??t('智能体默认','Agent default')} disabled={busy||loading||(!models.length&&!options.model&&!options.effort)} value={options.model??''} onChange={event=>onOptions({model:event.target.value||null,effort:null})}><option value="">{loading?t('读取中…','Loading…'):t('智能体默认','Agent default')}</option>{options.model&&!models.some(m=>m.id===options.model)&&<option value={options.model} disabled>{options.model}</option>}{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
  <label><span>{t('推理强度','Reasoning')}</span><select aria-label={t('推理强度','Reasoning effort')} title={efforts.length?t('推理强度','Reasoning effort'):t('当前模型未提供可选推理档位','This model exposes no reasoning levels')} disabled={busy||loading||!efforts.length} value={options.effort??''} onChange={event=>onOptions({...options,effort:event.target.value||null})}><option value="">{efforts.length?t('默认','Default'):loading?t('读取中…','Loading…'):t('默认','Default')}</option>{efforts.map(level=><option key={level} value={level}>{effortName(level)}</option>)}</select></label>
  {(!loading&&!models.length||error)&&<div className="planning-model-feedback"><span role={error?'alert':'status'}>{error||t('当前工具未提供可选模型','This tool has no model list')}</span><button className="icon-button" type="button" disabled={busy||loading} aria-label={t('重载模型','Reload models')} title={t('重载模型','Reload models')} onClick={()=>setAttempt(x=>x+1)}><RefreshCw/></button></div>}
 </div>;
}
