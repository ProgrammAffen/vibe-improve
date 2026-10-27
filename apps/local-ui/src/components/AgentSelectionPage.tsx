import {useEffect,useRef,useState} from 'react';
import {CircleCheck,RefreshCw,UserRoundPen} from 'lucide-react';
import {translate,type Language} from '../i18n';
import {PROVIDERS,canContinue,type AgentChoice,type AgentProbe,type LoginState,type ProviderId} from '../agents/domain';
import {agentService} from '../agents/service';
import type {ProjectRecord} from '../projects/domain';
import GameButton from './GameButton';
import BackHomeButton from './BackHomeButton';
import Modal from './Modal';
import Field from './Field';
import './agents.css';

const ASSET=import.meta.env.BASE_URL+'assets/images/';
export function probeLabel(state:AgentProbe['state'],language:Language){
  const labels:Record<AgentProbe['state'],[string,string]>={checking:['检测中','Checking'],ready:['已登录','Signed in'],'login-required':['需登录','Sign in required'],'not-installed':['未安装','Not installed'],unverified:['待验证','Not verified'],unknown:['未能确认','Unknown'],'desktop-required':['需桌面端','Desktop required'],'runtime-required':['需 Node.js','Node.js required']};
  return labels[state][language==='en'?1:0];
}
type Props={language:Language;probes:AgentProbe[];choice:AgentChoice|null;onChoice:(id:AgentChoice)=>void;onScan:()=>void;onLogin:(id:ProviderId)=>void;onInstall?:(id:'codebuddy')=>void;onNext:()=>void;onPrevious:()=>void;onHome:()=>void;project?:ProjectRecord|null;settings?:boolean;busy?:boolean;error?:string};
export function AgentSelectionSurface({language,probes,choice,onChoice,onScan,onLogin,onInstall,onNext,onPrevious,onHome,project,settings=false,busy=false,error=''}:Props){
  const t=(zh:string,en:string)=>translate(language,zh,en),selected=PROVIDERS.find(item=>item.id===choice);
  const completed=probes.filter(item=>item.state!=='checking').length;
  return <section className="agent-page" data-layout-region="agents"><div className="agent-stage">
    <img className="agent-scene" src={ASSET+'agent-selection-camp-blank-v1.png'} alt="" draggable={false}/>
    <BackHomeButton language={language} className="agent-home" onClick={onHome}/>
    <section className="agent-board" aria-labelledby="agent-title">
      <header className="agent-header"><h1 id="agent-title">{t('选择智能体','Choose an agent')}</h1><div><span role="status">{t('已检测','Checked')} {completed} / {PROVIDERS.length}</span><GameButton variant="secondary" leadingIcon={<RefreshCw/>} onClick={onScan} disabled={busy||completed<PROVIDERS.length}>{t('重新检测','Scan again')}</GameButton></div></header>
      <div className="agent-body"><div className="agent-roster" role="radiogroup" aria-label={t('智能体选项','Agent options')}>
        <div className={`agent-row agent-row--manual ${choice==='manual'?'is-selected':''}`}>
          <label className="agent-row-main"><input type="radio" name="agent-choice" value="manual" checked={choice==='manual'} disabled={busy} onChange={()=>onChoice('manual')}/><span className="agent-brand agent-manual-icon"><UserRoundPen aria-hidden="true"/></span><span>{t('无智能体，手动创建','No agent, create manually')}</span></label>
        </div>
        {PROVIDERS.map(provider=>{const probe=probes.find(item=>item.id===provider.id)??{id:provider.id,state:'checking' as const};return <div className={`agent-row ${choice===provider.id?'is-selected':''} state-${probe.state}`} key={provider.id}>
          <label className="agent-row-main"><input type="radio" name="agent-choice" value={provider.id} checked={choice===provider.id} disabled={busy||probe.state!=='ready'} onChange={()=>onChoice(provider.id)}/><span className="agent-brand"><img src={ASSET+provider.icon} alt=""/></span><span>{provider.name}</span></label>
          <span className="agent-state">{probe.state==='ready'&&<CircleCheck aria-hidden="true"/>}{probeLabel(probe.state,language)}</span>
          <div className="agent-row-action">{probe.state==='login-required'&&<GameButton variant="secondary" disabled={busy} onClick={()=>onLogin(provider.id)} aria-label={t('登录 ','Sign in to ')+provider.name}>{t('登录','Sign in')}</GameButton>}{provider.id==='codebuddy'&&['not-installed','unverified','runtime-required'].includes(probe.state)&&<GameButton variant="secondary" disabled={busy} onClick={()=>onInstall?.('codebuddy')} aria-label={t('安装 CodeBuddy CLI','Install CodeBuddy CLI')}>{t('安装','Install')}</GameButton>}</div>
        </div>})}
      </div><section className="agent-details" aria-label={t('当前选择','Current choice')}>
        <div className="agent-selected">{choice==='manual'?<><span className="agent-detail-brand agent-manual-icon"><UserRoundPen aria-hidden="true"/></span><h2>{t('无智能体','No agent')}</h2><span>{t('手动创建','Create manually')}</span></>:selected?<><span className="agent-detail-brand"><img src={ASSET+selected.icon} alt=""/></span><h2>{selected.name}</h2><span>{probeLabel(probes.find(item=>item.id===selected.id)?.state??'checking',language)}</span></>:<h2>{t('请选择','Select an option')}</h2>}</div>
        {project&&<dl className="agent-project"><dt>{t('项目名称','Project name')}</dt><dd>{project.name}</dd><dt>{t('项目目录','Project location')}</dt><dd className="agent-path" title={project.path}>{project.path}</dd></dl>}
        {settings&&<div className="agent-settings-label">{t('默认智能体','Default agent')}</div>}
      </section></div>
      <p className="agent-feedback" role="alert">{error}</p>
      <footer className="agent-footer"><GameButton variant="secondary" onClick={onPrevious} disabled={busy}>{settings?t('返回设置','Back to settings'):t('上一步','Previous')}</GameButton><GameButton onClick={onNext} disabled={busy||!canContinue(choice,probes)}>{busy?t('保存中…','Saving…'):settings?t('保存','Save'):t('下一步','Next')}</GameButton></footer>
    </section>
  </div></section>;
}
function errorLabel(error:unknown,language:Language){
  const key=error instanceof Error?error.message:String(error);
  const messages:Record<string,[string,string]>={AGENT_AUTH_REQUIRED:['请先登录该智能体。','Sign in to this agent first.'],AGENT_DESKTOP_REQUIRED:['请在桌面应用中管理智能体。','Manage agents in the desktop app.'],AGENT_TIMEOUT:['操作超时，请重试。','The operation timed out. Try again.'],AGENT_BUSY:['该智能体正在登录。','This agent is already signing in.'],AGENT_LOGIN_FAILED:['登录未完成，请重试。','Sign-in did not complete. Try again.'],AGENT_INSTALL_FAILED:['安装未完成，请重试。','Installation did not complete. Try again.'],AGENT_NETWORK_FAILED:['网络连接失败，请重试安装。','Network connection failed. Try installing again.'],AGENT_INTEGRITY_FAILED:['安装包校验失败，请重试。','Package verification failed. Try again.'],AGENT_DISK_FULL:['磁盘空间不足。','Not enough disk space.'],AGENT_RUNTIME_REQUIRED:['需要 Node.js 18.20.8 或更高版本和 npm。','Node.js 18.20.8 or later and npm are required.']};
  return(messages[key]??['智能体操作未完成，请重新检测。','The operation did not complete. Scan again.'])[language==='en'?1:0];
}
export default function AgentSelectionPage({language,project,onPrevious,onHome,onDone,settings=false}:{language:Language;project?:ProjectRecord|null;onPrevious:()=>void;onHome:()=>void;onDone:()=>void;settings?:boolean}){
  const [probes,setProbes]=useState<AgentProbe[]>(()=>PROVIDERS.map(item=>({id:item.id,state:'checking'}))),[choice,setChoice]=useState<AgentChoice|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[login,setLogin]=useState<LoginState|null>(null),[code,setCode]=useState(''),[loginProvider,setLoginProvider]=useState<ProviderId>('claude-code'),[operation,setOperation]=useState<'login'|'install'>('login');
  const generation=useRef(0),mounted=useRef(false),loginRef=useRef<LoginState|null>(null),acting=useRef(false),choiceTouched=useRef(false);
  const t=(zh:string,en:string)=>translate(language,zh,en);
  async function scan(){const batch=++generation.current;setProbes(PROVIDERS.map(item=>({id:item.id,state:'checking'})));setError('');await Promise.all(PROVIDERS.map(async item=>{let value:AgentProbe;try{value=await agentService.probe(item.id)}catch{value={id:item.id,state:'unknown'}}if(mounted.current&&batch===generation.current)setProbes(previous=>previous.map(old=>old.id===item.id?value:old))}));}
  useEffect(()=>{mounted.current=true;void scan();void agentService.choice(settings?undefined:project?.id).then(value=>{if(mounted.current&&!choiceTouched.current)setChoice(value)}).catch(()=>{});return()=>{mounted.current=false;generation.current++;if(loginRef.current?.state==='pending')void agentService.cancelLogin(loginRef.current.id).catch(()=>{})}},[project?.id,settings]);
  useEffect(()=>{loginRef.current=login},[login]);
  useEffect(()=>{if(!login||login.state!=='pending')return;let pending=false;const check=async()=>{if(pending)return;pending=true;try{const state=await agentService.loginState(login.id);if(mounted.current){setLogin(state);if(state.state!=='pending'){setCode('');if(state.state==='finished'){setLogin(null);void scan()}else setError(errorLabel(new Error(state.errorCode??(state.state==='timeout'?'AGENT_TIMEOUT':operation==='install'?'AGENT_INSTALL_FAILED':'AGENT_LOGIN_FAILED')),language))}}}catch(cause){if(mounted.current)setError(errorLabel(cause,language))}finally{pending=false}};const timer=setInterval(()=>void check(),1200);window.addEventListener('focus',check);return()=>{clearInterval(timer);window.removeEventListener('focus',check)}},[login?.id,login?.state,language,operation]);
  async function begin(id:ProviderId,kind:'login'|'install'='login'){if(acting.current||login?.state==='pending')return;acting.current=true;setLoginProvider(id);setOperation(kind);setError('');try{const value=kind==='install'&&id==='codebuddy'?await agentService.beginInstall(id):await agentService.beginLogin(id);if(mounted.current){loginRef.current=value;setLogin(value)}else{void agentService.cancelLogin(value.id).catch(()=>{})}}catch(cause){if(mounted.current)setError(errorLabel(cause,language))}finally{acting.current=false}}
  async function cancel(){if(!login)return;try{await agentService.cancelLogin(login.id);setLogin(null);loginRef.current=null;setCode('');void scan()}catch(cause){setError(errorLabel(cause,language))}}
  async function next(){if(acting.current||!canContinue(choice,probes)||!choice)return;acting.current=true;setBusy(true);setError('');try{await agentService.save(choice,settings?undefined:project?.id);onDone()}catch(cause){if(mounted.current)setError(errorLabel(cause,language))}finally{acting.current=false;if(mounted.current)setBusy(false)}}
  return <><AgentSelectionSurface language={language} probes={probes} choice={choice} onChoice={value=>{choiceTouched.current=true;setChoice(value)}} onScan={()=>void scan()} onLogin={id=>void begin(id)} onInstall={id=>void begin(id,'install')} onNext={()=>void next()} onPrevious={onPrevious} onHome={onHome} project={project} settings={settings} busy={busy||login?.state==='pending'} error={error}/>
    {login&&login.state==='pending'&&<Modal title={(operation==='install'?t('安装 ','Install '):t('登录 ','Sign in to '))+(PROVIDERS.find(item=>item.id===loginProvider)?.name??'')} closeLabel={t('取消','Cancel')} onClose={()=>void cancel()}><div className="modal-fields">{operation==='install'?<progress className="agent-install-progress" aria-label={t('正在安装 CodeBuddy CLI','Installing CodeBuddy CLI')}/>:<p>{t('请在浏览器中完成登录。','Complete sign-in in your browser.')}</p>}{login.url&&<a href={login.url} target="_blank" rel="noreferrer" className="text-button">{t('打开登录页','Open sign-in page')}</a>}{login.awaitingCode&&<><Field label={t('授权码','Authorization code')} value={code} type="password" autoComplete="off" onChange={event=>setCode(event.target.value)}/><GameButton disabled={!code.trim()} onClick={()=>void agentService.sendCode(login.id,code.trim()).then(()=>setCode('')).catch(cause=>setError(errorLabel(cause,language)))}>{t('提交','Submit')}</GameButton></>}</div><div className="confirmation-actions"><GameButton variant="secondary" onClick={()=>void cancel()}>{t('取消','Cancel')}</GameButton></div></Modal>}
  </>;
}
