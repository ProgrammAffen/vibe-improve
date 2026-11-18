import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import GameSelect from './GameSelect';
import type {AgentOptions,PlanningState} from '../../../../packages/domain/planning.mjs';
import {PROVIDERS,type ProviderId} from '../agents/domain';
import {planningService,planningMessage,type ModelCatalog} from '../planning/service';
import {translate,type Language} from '../i18n';
import './planning-model-controls.css';

type Option={id:string;label:string;icon?:string;disabled?:boolean};
type DropdownProps={label:string;options:Option[];value:string;onSelect:(id:string)=>void;placeholder?:string;disabled?:boolean;hint?:string;showLabel?:boolean;above?:boolean};

function PlanningDropdown({label,options,value,onSelect,placeholder='',disabled=false,hint,showLabel=true,above=false}:DropdownProps){
 return <div className="planning-dropdown">
  {showLabel&&<span className="planning-dropdown-label" aria-hidden="true">{label}</span>}
  <GameSelect value={value} options={options.map(option=>({value:option.id,label:option.label,disabled:option.disabled,icon:option.icon}))}
   onChange={onSelect} aria-label={label} placeholder={placeholder} disabled={disabled} title={hint}
   triggerClassName="planning-dropdown-trigger" menuClassName="planning-dropdown-choices" preferredPlacement={above?'above':'below'}/>
 </div>;
}

const planningAgents=PROVIDERS.filter(provider=>['codex','claude-code','codebuddy'].includes(provider.id));
const agentChoices=planningAgents.map(provider=>({id:provider.id,label:provider.name,icon:import.meta.env.BASE_URL+'assets/images/'+provider.icon}));

export function PlanningAgentControl({state,language,busy,onProvider,showLabel,above}:{
 state:PlanningState;language:Language;busy:boolean;onProvider:(provider:ProviderId)=>void;showLabel?:boolean;above?:boolean;
}){
 return <PlanningDropdown label={translate(language,'智能体','Agent')} value={state.provider??''} options={agentChoices}
  placeholder={translate(language,'选择智能体','Choose an agent')} disabled={busy||Boolean(state.pending)}
  showLabel={showLabel} above={above} onSelect={id=>{const provider=planningAgents.find(item=>item.id===id);if(provider)onProvider(provider.id)}}/>;
}

export default function PlanningModelControls({state,language,busy,onOptions}:{state:PlanningState;language:Language;busy:boolean;onOptions:(options:AgentOptions)=>void}){
 const [catalog,setCatalog]=useState<ModelCatalog|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<Error|null>(null),[attempt,setAttempt]=useState(0);
 const t=(zh:string,en:string)=>translate(language,zh,en),options=state.agentOptions??{model:null,effort:null};
 useEffect(()=>{
  let active=true;
  setLoading(true);setError(null);setCatalog(null);
  void planningService.models(state.projectId,attempt>0).then(data=>{
   if(active&&data.provider===state.provider)setCatalog(data);
  }).catch(cause=>{if(active)setError(cause)}).finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[state.projectId,state.provider,attempt]);
 const models=catalog?.provider===state.provider?catalog.models:[];
 const selected=options.model?models.find(model=>model.id===options.model):models.find(model=>model.isDefault);
 const efforts=selected?.efforts??[];
 const modelChoices=[{id:'',label:loading?t('读取中…','Loading…'):t('智能体默认','Agent default')},...models.map(model=>({id:model.id,label:model.name}))];
 const levels:Record<string,string>={none:t('无','None'),minimal:t('最低','Minimal'),low:t('低','Low'),medium:t('中','Medium'),high:t('高','High'),xhigh:t('极高','Extra high'),max:t('最高','Max')};
 const effortChoices=[{id:'',label:t('默认','Default')},...efforts.map(level=>({id:level,label:levels[level]??level}))];
 const withSavedOption=(choices:Option[],value:string|null)=>value&&!choices.some(choice=>choice.id===value)?[...choices,{id:value,label:value,disabled:true}]:choices;
 const disabled=busy||loading||Boolean(state.pending);
 return <div className="planning-model-controls" aria-busy={loading}>
  <PlanningDropdown label={t('模型','Model')} value={options.model??''} options={withSavedOption(modelChoices,options.model)}
   disabled={disabled||(!models.length&&!options.model&&!options.effort)} onSelect={id=>onOptions({model:id||null,effort:null})}/>
  <PlanningDropdown label={t('推理强度','Reasoning effort')} value={options.effort??''} options={withSavedOption(effortChoices,options.effort)}
   disabled={disabled||!efforts.length} hint={!loading&&!efforts.length?t('当前模型未提供可选推理档位','This model exposes no reasoning levels'):undefined}
   onSelect={id=>onOptions({...options,effort:id||null})}/>
  {!loading&&(!models.length||error)&&<div className="planning-model-feedback">
   <span role={error?'alert':'status'}>{error?planningMessage(error,language):t('当前工具未提供可选模型','This tool has no model list')}</span>
   <button className="icon-button" type="button" disabled={disabled} aria-label={t('重载模型','Reload models')} title={t('重载模型','Reload models')} onClick={()=>setAttempt(count=>count+1)}><RefreshCw/></button>
  </div>}
 </div>;
}
