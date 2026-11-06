import {routeTargetPosition} from './route-order.mjs';
const fail=()=>{throw new Error('PLANNING_TARGET_UNAVAILABLE')};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
export const targetShape=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['chapterId','nodeId'].includes(k))&&id(value.chapterId)&&(!Object.hasOwn(value,'nodeId')||id(value.nodeId));
export function validatePlanningTarget(route,target){if(!targetShape(target))fail();const chapter=route?.chapters.find(ch=>ch.id===target.chapterId);if(!chapter||target.nodeId&&!chapter.nodes.some(n=>n.id===target.nodeId))fail();return target}
const pattern=()=>/@第([1-9]\d*)章|@([1-9]\d*)\.([1-9]\d*)节|@Chapter([1-9]\d*)(?!\d|\.\d)|@Lesson([1-9]\d*)\.([1-9]\d*)(?!\d|\.\d)/g;
export const planningMentionTokens=text=>[...text.matchAll(pattern())].map(m=>m[0]);
export function planningMentionDeletion(text,start,end,direction,bindings=[]){
 const known=new Set(bindings.map(mention=>mention.token));
 const spans=[...text.matchAll(pattern())].filter(match=>known.has(match[0])).map(match=>({start:match.index,end:match.index+match[0].length}));
 if(start!==end){
  const touched=spans.filter(span=>span.start<end&&span.end>start);
  return touched.length?{start:Math.min(start,...touched.map(span=>span.start)),end:Math.max(end,...touched.map(span=>span.end))}:null;
 }
 const span=spans.find(span=>direction==='backward'?(span.start<start&&start<=span.end)||(span.end===start-1&&text[span.end]===' '):span.start<=start&&start<span.end);
 return span?{start:span.start,end:Math.max(span.end,start)}:null;
}
export function planningMentionToken(route,target,locale){
 if(!targetShape(target))fail();const position=routeTargetPosition(route,target);if(!position)fail();
 return target.nodeId?(locale==='en'?`@Lesson${position.number}`:`@${position.number}节`):(locale==='en'?`@Chapter${position.chapterIndex+1}`:`@第${position.chapterIndex+1}章`);
}
export function mentionShape(value){return value&&typeof value==='object'&&Object.keys(value).length===2&&targetShape(value.target)&&typeof value.token==='string'&&value.token.length<=40&&[...value.token.matchAll(pattern())].some(m=>m[0]===value.token)}
export function validatePlanningMentions(route,text,mentions,resolve=true){
 if(!Array.isArray(mentions)||mentions.length>32)fail();const seen=new Set(),tokens=new Set([...text.matchAll(pattern())].map(m=>m[0]));
 for(const mention of mentions){if(!mentionShape(mention)||!tokens.has(mention.token)||seen.has(mention.token))fail();seen.add(mention.token);if(resolve)validatePlanningTarget(route,mention.target)}
 return mentions;
}
export function resolvePlanningMentions(route,text,bindings=[]){
 const mentions=[],seen=new Set();
 for(const match of text.matchAll(pattern())){
  const token=match[0];if(seen.has(token))continue;seen.add(token);
  const bound=bindings.find(x=>x.token===token);let target=bound?.target;
  if(target?.nodeId){const position=routeTargetPosition(route,target);if(!position)fail();target=position.target}
  if(!target){const ci=Number(match[1]??match[2]??match[4]??match[5])-1,ni=match[3]??match[6],chapter=route?.chapters[ci];if(!chapter)fail();target={chapterId:chapter.id};if(ni){const node=chapter.nodes[Number(ni)-1];if(!node)fail();target.nodeId=node.id}}
  mentions.push({token,target:{...target}});
 }
 return validatePlanningMentions(route,text,mentions);
}
export function refreshPlanningMentions(route,text,bindings,locale){
 const next=bindings.map(mention=>{try{const position=routeTargetPosition(route,mention.target);if(!position)fail();return {target:position.target,token:planningMentionToken(route,position.target,locale)}}catch{return mention}});
 const mapping=new Map(bindings.map((m,i)=>[m.token,next[i].token]));
 return {text:text.replace(pattern(),token=>mapping.get(token)??token),mentions:next};
}
