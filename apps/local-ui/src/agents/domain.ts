export const PROVIDERS = [
  {id:'codex',name:'Codex',icon:'agent-codex.png'}, {id:'claude-code',name:'Claude Code',icon:'agent-claude-code.png'},
  {id:'codebuddy',name:'CodeBuddy',icon:'agent-codebuddy.svg'}, {id:'qoder',name:'Qoder',icon:'agent-qoder.png'},
  {id:'openclaw',name:'OpenClaw',icon:'agent-openclaw.svg'},
  {id:'hermes',name:'Hermes',icon:'agent-hermes.png'},
] as const;
export type ProviderId = typeof PROVIDERS[number]['id'];
export type AgentChoice = ProviderId | 'manual';
export type ProbeState = 'checking' | 'ready' | 'login-required' | 'not-installed' | 'unverified' | 'unknown' | 'desktop-required' | 'runtime-required';
export type AgentProbe = {id:ProviderId;state:ProbeState;version?:string};
export type LoginState = {id:string;state:'pending'|'finished'|'cancelled'|'failed'|'timeout';url?:string;awaitingCode?:boolean;errorCode?:string};
export function isChoice(value:unknown):value is AgentChoice {return value==='manual'||PROVIDERS.some(item=>item.id===value)}
export function canContinue(choice:AgentChoice|null,probes:AgentProbe[]):boolean {
  return choice==='manual'||Boolean(choice&&probes.some(item=>item.id===choice&&item.state==='ready'));
}
export function parseProbe(value:unknown,id:ProviderId):AgentProbe {
  const item=value as Partial<AgentProbe>|null;
  const allowed:ProbeState[]=['checking','ready','login-required','not-installed','unverified','unknown','desktop-required','runtime-required'];
  if(!item||item.id!==id||!allowed.includes(item.state!))return{id,state:'unknown'};
  return {id,state:item.state!,...(typeof item.version==='string'&&item.version.length<100?{version:item.version}:{})};
}
