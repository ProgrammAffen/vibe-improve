import PlanningActivityPanel from './PlanningActivityPanel';
import type {PlanningActivity} from '../planning/service';
import {useEffect,useLayoutEffect,useRef,useState,type FormEvent,type ReactNode,type RefObject} from 'react';
import {ClipboardList,FileText,LoaderCircle,Send,Square} from 'lucide-react';
import type {PlanningMessage,PlanningMention} from '../../../../packages/domain/planning.mjs';
import {planningMentionTokens,planningMentionDeletion,resolvePlanningMentions,refreshPlanningMentions} from '../../../../packages/domain/planning-references.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import {planningTargetLabel} from '../planning/references';
import {PROVIDERS} from '../agents/domain';
import {translate,type Language} from '../i18n';
import GameButton from './GameButton';
import {createImeGuard} from '../planning/input';

const ASSET=import.meta.env.BASE_URL+'assets/images/';
const provider=(id:string|null)=>PROVIDERS.find(item=>item.id===id);
function Avatar({role,providerId}:{role:'user'|'assistant';providerId:string|null}){
 const selected=provider(providerId);
 return <span className={`planning-avatar ${role==='user'?'planning-avatar--hamster':''}`} aria-hidden="true">{role==='user'?<img src={ASSET+'hamster-traveler-v1.png'} alt=""/>:selected?<img src={ASSET+selected.icon} alt=""/>:<ClipboardList/>}</span>;
}
function MentionText({text,mentions,route,language='zh-CN'}:{text:string;mentions?:PlanningMention[];route?:RouteDocument;language?:Language}){
 if(route&&mentions?.length){const display=refreshPlanningMentions(route,text,mentions,language);text=display.text;mentions=display.mentions}
 const known=new Set(mentions?.map(mention=>mention.token)),parts:ReactNode[]=[];let offset=0;
 for(const token of planningMentionTokens(text)){
  const index=text.indexOf(token,offset);parts.push(text.slice(offset,index));
  parts.push(known.has(token)?<span className="planning-mention" key={index}>{token}</span>:token);offset=index+token.length;
 }
 parts.push(text.slice(offset));return <>{parts}</>;
}
export function PlanningMessages({messages,providerId,language,busy=false,workingLabel,partialReply,activity,route,children,autoFollow=true}:{messages:PlanningMessage[];providerId:string|null;language:Language;busy?:boolean;workingLabel?:string;partialReply?:string;activity?:PlanningActivity;route?:RouteDocument;children?:ReactNode;autoFollow?:boolean}){
 const list=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
 const bottom=()=>{if(autoFollow&&list.current)list.current.scrollTop=list.current.scrollHeight};
 useLayoutEffect(bottom);
 useEffect(()=>{
  if(!autoFollow||!list.current||!content.current)return;
  let frame=0;
  const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(bottom)});
  observer.observe(list.current);observer.observe(content.current);bottom();
  return()=>{observer.disconnect();cancelAnimationFrame(frame)};
 },[autoFollow]);
 return <div ref={list} className="planning-message-list" role="log" aria-label={translate(language,'规划对话','Planning conversation')} aria-live="polite"><div ref={content} className="planning-message-stack">{messages.map(message=><article key={message.id} className={`planning-message planning-message--${message.role}`}><Avatar role={message.role} providerId={providerId}/><div className="planning-message-content">{message.role==='assistant'&&<small>{provider(providerId)?.name??translate(language,'智能体','Agent')}</small>}<p>{message.target&&<span className="planning-message-reference" title={planningTargetLabel(route,message.target,language)}><FileText aria-hidden="true"/>{planningTargetLabel(route,message.target,language)}</span>}<MentionText text={message.text} mentions={message.mentions} route={route} language={language}/></p></div></article>)}{children}{partialReply&&<article className="planning-message planning-message--assistant" aria-busy={busy} aria-live="off" data-incomplete={!busy||undefined}><Avatar role="assistant" providerId={providerId}/><div className="planning-message-content"><small>{provider(providerId)?.name??translate(language,'智能体','Agent')}</small><p>{partialReply}</p>{!busy&&<span className="planning-incomplete" role="status">{translate(language,'回复未完成 · 未应用','Incomplete · Not applied')}</span>}</div></article>}{activity?<PlanningActivityPanel activity={activity} busy={busy} language={language} label={workingLabel}/>:busy&&<div className="planning-working" role="status"><LoaderCircle aria-hidden="true"/>{workingLabel??translate(language,'处理中…','Working…')}</div>}</div></div>;
}
export function PlanningComposer({language,busy,disabled,onSend,onCancel,placeholder,answeredText,inputRef,route,referenceRequest}:{language:Language;busy:boolean;disabled?:boolean;onSend:(text:string,mentions?:PlanningMention[])=>void|boolean|Promise<boolean>;onCancel:()=>void;placeholder?:string;answeredText?:string;inputRef?:RefObject<HTMLTextAreaElement|null>;route?:RouteDocument;referenceRequest?:{sequence:number;mention:PlanningMention}}){
 const [text,setText]=useState(''),[sending,setSending]=useState(false),[bindings,setBindings]=useState<PlanningMention[]>([]),[referenceError,setReferenceError]=useState('');
 const ownRef=useRef<HTMLTextAreaElement>(null),field=inputRef??ownRef,inserted=useRef(0),mirror=useRef<HTMLDivElement>(null),ime=useRef(createImeGuard()),submitting=useRef(false);
 function syncMirror(){const input=field.current,layer=mirror.current;if(!input||!layer)return;layer.style.width=input.clientWidth+'px';layer.style.transform=`translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`}
 useLayoutEffect(syncMirror,[text]);
 useEffect(()=>{const input=field.current;if(!input)return;const observer=new ResizeObserver(syncMirror);observer.observe(input);return ()=>observer.disconnect()},[]);
 const t=(zh:string,en:string)=>translate(language,zh,en);
 function prepareMentionDeletion(input:HTMLTextAreaElement,direction:'backward'|'forward'){
  const range=planningMentionDeletion(input.value,input.selectionStart,input.selectionEnd,direction,bindings);
  if(range)input.setSelectionRange(range.start,range.end);
 }
 useEffect(()=>{if(answeredText){setText(current=>current.trim()===answeredText?'':current);if(text.trim()===answeredText)setBindings([])}},[answeredText]);
 useEffect(()=>{
  if(!route||!bindings.length)return;
  const refreshed=refreshPlanningMentions(route,text,bindings,language);
  if(refreshed.text!==text)setText(refreshed.text);
  if(JSON.stringify(refreshed.mentions)!==JSON.stringify(bindings))setBindings(refreshed.mentions);
 },[route,language]);
 useEffect(()=>{
  if(!referenceRequest||inserted.current===referenceRequest.sequence)return;inserted.current=referenceRequest.sequence;
  const mention=referenceRequest.mention,existing=bindings.find(m=>m.target.chapterId===mention.target.chapterId&&m.target.nodeId===mention.target.nodeId&&planningMentionTokens(text).includes(m.token));
  if(existing){field.current?.focus();return}
  if(new Set(planningMentionTokens(text)).size>=32){setReferenceError(t('一次最多引用32个章节。','Reference up to 32 chapters or lessons at a time.'));return}
  const start=Math.min(field.current?.selectionStart??text.length,text.length),end=Math.min(field.current?.selectionEnd??start,text.length),prefix=text.slice(0,start),suffix=text.slice(end);
  const addition=(prefix&&!/\s$/.test(prefix)?' ':'')+mention.token+(!suffix||!/^\s/.test(suffix)?' ':'');
  const next=prefix+addition+suffix;if(next.length>8000){setReferenceError(t('输入已达到长度上限。','The message has reached its length limit.'));return}
  const tokens=planningMentionTokens(next);setBindings(old=>[...old.filter(m=>m.token!==mention.token&&tokens.includes(m.token)),mention]);setText(next);setReferenceError('');
  requestAnimationFrame(()=>{field.current?.focus();field.current?.setSelectionRange(prefix.length+addition.length,prefix.length+addition.length)});
 },[referenceRequest?.sequence]);
 async function transmit(){
  if(busy||disabled||sending||submitting.current||ime.current.active()||!text.trim())return;
  let mentions:PlanningMention[]=[];
  try{if(route)mentions=resolvePlanningMentions(route,text,bindings)}catch{setReferenceError(t('章节引用已失效，请删除或重新添加。','A chapter reference is unavailable. Remove it or add it again.'));return}
  submitting.current=true;setSending(true);setReferenceError('');try{const accepted=await onSend(text.trim(),mentions);if(accepted!==false){setText('');setBindings([])}}finally{submitting.current=false;setSending(false)}
 }
 function submit(event:FormEvent){event.preventDefault();void transmit()}
 return <div className="planning-compose-area"><form className="planning-composer" onSubmit={submit}><div className="planning-input-shell" aria-disabled={busy||disabled||undefined}><div className="planning-input-highlights" aria-hidden="true"><div className="planning-input-mirror" ref={mirror}><MentionText text={text+'\n'} mentions={bindings}/></div></div><textarea ref={field} onScroll={syncMirror} aria-label={placeholder??t('输入回答','Enter your reply')} placeholder={placeholder??t('输入回答…','Type your reply…')} value={text} maxLength={8000} disabled={busy||disabled} onCompositionStart={()=>ime.current.start()} onCompositionEnd={()=>ime.current.end()} onKeyUp={event=>ime.current.keyUp(event.nativeEvent)} onBlur={()=>ime.current.reset()} onChange={event=>{const value=event.target.value,tokens=planningMentionTokens(value);setText(value);setBindings(old=>{const next=old.filter(m=>tokens.includes(m.token));if(route)for(const token of tokens)if(!next.some(m=>m.token===token)){try{next.push(...resolvePlanningMentions(route,token))}catch{}}return next});setReferenceError('')}} onBeforeInput={event=>{const input=event.nativeEvent as InputEvent;if(!ime.current.active(input)&&['deleteContentBackward','deleteContentForward'].includes(input.inputType))prepareMentionDeletion(event.currentTarget,input.inputType==='deleteContentBackward'?'backward':'forward')}} onKeyDown={event=>{
  const input=event.nativeEvent,composing=ime.current.active(input),blocked=ime.current.keyDown(input);
  if(!composing&&(event.key==='Backspace'||event.key==='Delete'))prepareMentionDeletion(event.currentTarget,event.key==='Backspace'?'backward':'forward');
  if(event.key==='Enter'&&blocked){if(!composing)event.preventDefault();return}
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!event.repeat)void transmit()}
 }}/></div>{busy?<GameButton className="planning-send" onClick={onCancel} aria-label={t('停止','Stop')} title={t('停止','Stop')}><Square aria-hidden="true"/></GameButton>:<GameButton className="planning-send" type="submit" disabled={disabled||sending||!text.trim()} aria-label={t('发送','Send')} title={t('发送','Send')}><Send aria-hidden="true"/></GameButton>}</form>{referenceError&&<p className="planning-reference-error" role="alert">{referenceError}</p>}</div>;
}
