import {PROVIDERS,isChoice,parseProbe,type AgentChoice,type AgentProbe,type LoginState,type ProviderId} from './domain';

const native=()=>window.vibeNative?.agents;
async function request<T>(action:string,value:Record<string,unknown>={}):Promise<T> {
  const bridge=native();
  if(!bridge)throw new Error('AGENT_DESKTOP_REQUIRED');
  try{return await bridge.request(action,value) as T}catch(cause){
    const message=cause instanceof Error?cause.message:String(cause);
    throw new Error(['AGENT_AUTH_REQUIRED','AGENT_UNAVAILABLE','AGENT_LOGIN_FAILED','AGENT_BUSY','AGENT_TIMEOUT','AGENT_INVALID','AGENT_RUNTIME_REQUIRED','AGENT_INSTALL_FAILED','AGENT_PROJECT_UNAVAILABLE'].find(code=>message.includes(code))??'AGENT_UNAVAILABLE');
  }
}
function scope(projectId?:string){return projectId??'default'}
let discovering:Promise<AgentProbe[]>|null=null;
let latest:AgentProbe[]=[];
const observers=new Set<(values:AgentProbe[])=>void>();
const probing=new Map<ProviderId,Promise<AgentProbe>>();
function publish(values:AgentProbe[]){latest=values;for(const observer of observers)observer(values)}
async function probeOnce(id:ProviderId):Promise<AgentProbe>{
 if(!native())return{id,state:'desktop-required'};
 if(probing.has(id))return probing.get(id)!;
 const job=request('probe',{id}).then(value=>parseProbe(value,id)).finally(()=>probing.delete(id));probing.set(id,job);return job;
}
async function discovery(refresh:boolean,onProgress:(values:AgentProbe[])=>void){
 observers.add(onProgress);
 try{
  if(!discovering){
   latest=[];
   discovering=(async()=>{
    const cached:AgentProbe[]=native()&&!refresh?((await request<unknown>('detection.read',{})) as unknown[]).flatMap(value=>{const id=(value as AgentProbe)?.id;if(!PROVIDERS.some(p=>p.id===id))return[];const parsed=parseProbe(value,id);return parsed.state==='checking'?[]:[parsed]}):[];
    let values:AgentProbe[]=PROVIDERS.map(p=>cached.find(c=>c.id===p.id)??{id:p.id,state:'checking'});publish(values);
    await Promise.all(values.filter(p=>p.state==='checking').map(async p=>{const result=await probeOnce(p.id);values=values.map(old=>old.id===p.id?result:old);publish(values)}));return values;
   })().finally(()=>{discovering=null});
  }else if(latest.length)onProgress(latest);
  return await discovering;
 }finally{observers.delete(onProgress)}
}
export const agentService={
 discovery,

  probe:probeOnce,
  choice:async(projectId?:string):Promise<AgentChoice|null>=>{
    let value:unknown;
    if(native())value=await request('choice.read',{scope:scope(projectId)});
    else{try{value=JSON.parse(localStorage.getItem('vibe-improve.agents')??'{}')[scope(projectId)]??null}catch{value=null}}
    return isChoice(value)?value:null;
  },
  save:async(choice:AgentChoice,projectId?:string)=>{
    if(!isChoice(choice))throw new Error('AGENT_INVALID');
    if(native())await request('choice.save',{scope:scope(projectId),choice});
    else{
      if(choice!=='manual')throw new Error('AGENT_DESKTOP_REQUIRED');
      let previous:Record<string,unknown>={};try{previous=JSON.parse(localStorage.getItem('vibe-improve.agents')??'{}')}catch{}
      localStorage.setItem('vibe-improve.agents',JSON.stringify({...previous,[scope(projectId)]:choice}));
    }
  },
  prepare:async(projectId:string):Promise<{projectId:string;provider:AgentChoice}>=>{
    if(!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId))throw new Error('AGENT_INVALID');
    const value=await request<{projectId?:unknown;provider?:unknown}>('session.prepare',{projectId});
    if(value?.projectId!==projectId||!isChoice(value.provider))throw new Error('AGENT_INVALID');
    return {projectId,provider:value.provider};
  },
  beginInstall:(id:'codebuddy')=>request<LoginState>('install.begin',{id}),
  beginLogin:(id:ProviderId)=>request<LoginState>('login.begin',{id}),
  loginState:(id:string)=>request<LoginState>('login.state',{loginId:id}),
  cancelLogin:(id:string)=>request<void>('login.cancel',{loginId:id}),
  sendCode:(id:string,code:string)=>request<void>('login.code',{loginId:id,code}),
};
