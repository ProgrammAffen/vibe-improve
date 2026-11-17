import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {Check,ChevronDown,RefreshCw} from 'lucide-react';
import type {AgentOptions,PlanningState} from '../../../../packages/domain/planning.mjs';
import {PROVIDERS,type ProviderId} from '../agents/domain';
import {planningService,planningMessage,type ModelCatalog} from '../planning/service';
import {translate,type Language} from '../i18n';
import './planning-model-controls.css';

type Option={id:string;label:string;icon?:string;disabled?:boolean};
type DropdownProps={label:string;options:Option[];value:string;onSelect:(id:string)=>void;placeholder?:string;disabled?:boolean;hint?:string;showLabel?:boolean;above?:boolean};

function PlanningDropdown({label,options,value,onSelect,placeholder='',disabled=false,hint,showLabel=true,above=false}:DropdownProps){
 const id=useId(),listId=id+'-choices',root=useRef<HTMLDivElement>(null),list=useRef<HTMLUListElement>(null);
 const [open,setOpen]=useState(false),[active,setActive]=useState(-1);
 const expanded=open&&!disabled,selected=options.find(option=>option.id===value);
 const enabled=options.flatMap((option,index)=>option.disabled?[]:[index]);
 const optionId=(index:number)=>`${listId}-${index}`;
 useEffect(()=>{if(disabled)setOpen(false)},[disabled]);
 useEffect(()=>{
  if(!expanded)return;
  const dismiss=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false)};
  document.addEventListener('pointerdown',dismiss,true);
  return()=>document.removeEventListener('pointerdown',dismiss,true);
 },[expanded]);
 useEffect(()=>{
  const menu=list.current,row=menu?.children.item(active);
  if(row instanceof HTMLElement)row.scrollIntoView({block:'nearest',inline:'nearest'});
 },[expanded,active]);
 function show(last=false){
  const current=options.findIndex(option=>option.id===value&&!option.disabled);
  setActive(current>=0?current:(last?enabled.at(-1):enabled[0])??-1);
  setOpen(true);
 }
 function choose(index:number){
  const option=options[index];
  if(!option||option.disabled)return;
  setOpen(false);
  if(option.id!==value)onSelect(option.id);
 }
 function onKeyDown(event:KeyboardEvent<HTMLButtonElement>){
  const {key}=event;
  if(disabled)return;
  if(key==='Tab'){setOpen(false);return}
  if(key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setOpen(false);return}
  if(key==='Enter'||key===' '){
   event.preventDefault();
   if(expanded)choose(active);else show();
  }else if(key==='ArrowDown'||key==='ArrowUp'||key==='Home'||key==='End'){
   event.preventDefault();
   if(!expanded){show(key==='ArrowUp'||key==='End');return}
   const position=enabled.indexOf(active);
   if(key==='Home')setActive(enabled[0]??-1);
   else if(key==='End')setActive(enabled.at(-1)??-1);
   else setActive(enabled[Math.max(0,Math.min(enabled.length-1,position+(key==='ArrowDown'?1:-1)))]??-1);
  }
 }
 return <div className={`planning-dropdown${above?' planning-dropdown--above':''}`} ref={root}>
  {showLabel&&<span className="planning-dropdown-label" aria-hidden="true">{label}</span>}
  <button type="button" className="planning-dropdown-trigger" role="combobox" aria-label={label} aria-expanded={expanded}
   aria-controls={expanded?listId:undefined} aria-activedescendant={expanded&&active>=0?optionId(active):undefined}
   aria-disabled={disabled||undefined} tabIndex={disabled?-1:0} title={hint??selected?.label??placeholder}
   onBlur={()=>setOpen(false)} onKeyDown={onKeyDown}
   onClick={event=>{if(!disabled){event.currentTarget.focus();if(expanded)setOpen(false);else show()}}}>
   {selected?.icon&&<img src={selected.icon} alt=""/>}<span>{selected?.label??placeholder}</span><ChevronDown aria-hidden="true"/>
  </button>
  {expanded&&<ul className="planning-dropdown-choices" id={listId} ref={list} role="listbox" aria-label={label}>
   {options.map((option,index)=><li key={option.id} id={optionId(index)} role="option" aria-selected={option.id===value}
    aria-disabled={option.disabled||undefined} data-active={index===active||undefined} title={option.label}
    onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}>
    {option.icon&&<img src={option.icon} alt=""/>}<span>{option.label}</span>{option.id===value&&<Check aria-hidden="true"/>}
   </li>)}
  </ul>}
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
