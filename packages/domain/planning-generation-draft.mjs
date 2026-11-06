import {validateRoute} from './route-validation.mjs';
import {sha256} from './sha256.mjs';
import manifest from '../planning-prompts/manifest.json' with {type:'json'};

export const GENERATION_POLICY=manifest.version;
const fail=()=>{throw new Error('PLANNING_GENERATION_INVALID')};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,n)=>object(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const text=(v,n)=>typeof v==='string'&&v.trim()&&!v.includes('\0')&&Array.from(v).length<=n;
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const generationEqual=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export const generationRouteHash=route=>sha256(JSON.stringify(canonical(route??null)));

export function validateGenerationDraft(d){
 if(!keys(d,['schemaVersion','id','revision','createdAt','updatedAt','backgroundEpoch','factsHash','policyVersion','locale','baseRouteHash','routeId','outline','chapters'])||d.schemaVersion!==1||!/^generation_[A-Za-z0-9._-]{1,64}$/.test(d.id)||!integer(d.revision,1,1000)||!integer(d.backgroundEpoch,0,999999)||!hash(d.factsHash)||!hash(d.baseRouteHash)||!text(d.policyVersion,80)||!['zh-CN','en'].includes(d.locale)||!/^route_[a-f0-9-]{36}$/.test(d.routeId))fail();
 for(const field of ['createdAt','updatedAt'])if(typeof d[field]!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d[field])||!Number.isFinite(Date.parse(d[field])))fail();
 if(Date.parse(d.updatedAt)<Date.parse(d.createdAt))fail();
 const envelope=d.outline,result=envelope?.result;
 if(!keys(envelope,['status','reply','result','missing'])||envelope.status!=='ok'||!text(envelope.reply,8000)||!Array.isArray(envelope.missing)||envelope.missing.length||!keys(result,['title','chapters'])||!text(result.title,160)||!Array.isArray(result.chapters)||result.chapters.length<1||result.chapters.length>24)fail();
 const positions=new Map();let total=0;
 result.chapters.forEach((c,i)=>{
  if(!keys(c,['title','stageGoal','lessons'])||!text(c.title,160)||!text(c.stageGoal,600)||!Array.isArray(c.lessons)||!c.lessons.length||c.lessons.length>64)fail();
  c.lessons.forEach((n,j)=>{if(!keys(n,['title','focus'])||!text(n.title,160)||!text(n.focus,300)||++total>512)fail();positions.set(`node_${i+1}_${j+1}`,positions.size)});
 });
 if(!Array.isArray(d.chapters)||d.chapters.length!==result.chapters.length)fail();
 let completed=0;
 d.chapters.forEach((c,i)=>{
  if(c===null)return;
  const outline=result.chapters[i];
  if(!keys(c,['id','title','stageGoal','nodes'])||c.id!==`ch_${i+1}`||c.title!==outline.title||c.stageGoal!==outline.stageGoal||!Array.isArray(c.nodes)||!c.nodes.length||c.nodes.length>outline.lessons.length||c.nodes.length<outline.lessons.length&&c.nodes.length%3!==0)fail();
  const copy=JSON.parse(JSON.stringify(c));
  c.nodes.forEach((n,j)=>{
   const id=`node_${i+1}_${j+1}`,order=positions.get(id);
   if(!object(n)||n.id!==id||n.title!==outline.lessons[j].title||!Array.isArray(n.activities)||!n.activities.length||!Array.isArray(n.objectives)||n.objectives.some((o,k)=>!object(o)||o.id!==id+`_o${k+1}`)||!Array.isArray(n.prerequisites)||n.prerequisites.some(p=>!positions.has(p)||positions.get(p)>=order))fail();
   copy.nodes[j].prerequisites=[];
  });
  try{validateRoute({format:'vibe-improve.route',schemaVersion:2,id:d.routeId,revision:1,title:result.title,locale:d.locale,sourceLanguage:d.locale,chapters:[copy]})}catch{fail()}
  completed+=c.nodes.length;
 });
 if(JSON.stringify(d).length>2_097_152)fail();
 return {completed,total};
}

export function generationDraftMatches(state,factsHash){
 const d=state.generationDraft;
 return Boolean(d&&d.backgroundEpoch===(state.backgroundEpoch??0)&&d.factsHash===factsHash&&d.policyVersion===GENERATION_POLICY&&d.locale===state.locale&&d.baseRouteHash===generationRouteHash(state.routeDraft));
}
