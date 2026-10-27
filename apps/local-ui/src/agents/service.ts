import {isChoice,parseProbe,type AgentChoice,type LoginState,type ProviderId} from './domain';

const native=()=>window.vibeNative?.agents;
async function request<T>(action:string,value:Record<string,unknown>={}):Promise<T> {
  const bridge=native();
  if(!bridge)throw new Error('AGENT_DESKTOP_REQUIRED');
  try{return await bridge.request(action,value) as T}catch(cause){
    const message=cause instanceof Error?cause.message:String(cause);
    throw new Error(['AGENT_AUTH_REQUIRED','AGENT_UNAVAILABLE','AGENT_LOGIN_FAILED','AGENT_BUSY','AGENT_TIMEOUT','AGENT_INVALID','AGENT_RUNTIME_REQUIRED','AGENT_INSTALL_FAILED'].find(code=>message.includes(code))??'AGENT_UNAVAILABLE');
  }
}
function scope(projectId?:string){return projectId??'default'}
export const agentService={
  probe:async(id:ProviderId)=>native()?parseProbe(await request('probe',{id}),id):{id,state:'desktop-required' as const},
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
  beginInstall:(id:'codebuddy')=>request<LoginState>('install.begin',{id}),
  beginLogin:(id:ProviderId)=>request<LoginState>('login.begin',{id}),
  loginState:(id:string)=>request<LoginState>('login.state',{loginId:id}),
  cancelLogin:(id:string)=>request<void>('login.cancel',{loginId:id}),
  sendCode:(id:string,code:string)=>request<void>('login.code',{loginId:id,code}),
};
