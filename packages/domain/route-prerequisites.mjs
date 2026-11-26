import schema from '../../contracts/route.schema.json' with {type:'json'};
import {routeOutline} from './route-order.mjs';

export const MAX_ROUTE_PREREQUISITES = schema.$defs.nodeV2.properties.prerequisites.maxItems;

function prerequisiteContext(route,nodeId){
 const lessons=routeOutline(route).flatMap(chapter=>chapter.lessons);
 const nodes=new Map(lessons.map(({node})=>[node.id,node]));
 const node=nodes.get(nodeId);
 if(!node)return null;
 const selected=new Set(node.prerequisites),dependents=new Map();
 for(const {node:lesson} of lessons)for(const prerequisite of lesson.prerequisites){
  if(!dependents.has(prerequisite))dependents.set(prerequisite,[]);
  dependents.get(prerequisite).push(lesson.id);
 }
 // A prerequisite cannot itself depend on this lesson, even indirectly.
 const descendants=new Set(),queue=[nodeId];
 for(let i=0;i<queue.length;i++)for(const dependent of dependents.get(queue[i])??[]){
  if(!descendants.has(dependent)){descendants.add(dependent);queue.push(dependent)}
 }
 return {lessons,nodes,node,selected,descendants};
}

export function routePrerequisiteOptions(route,nodeId){
 const context=prerequisiteContext(route,nodeId);
 if(!context)return [];
 const {lessons,nodes,selected,descendants}=context;
 const options=lessons.flatMap(({node,number})=>{
  const checked=selected.has(node.id);
  if(node.id===nodeId&&!checked)return [];
  const problem=node.id===nodeId?'self':descendants.has(node.id)?'cycle':!checked&&selected.size>=MAX_ROUTE_PREREQUISITES?'limit':null;
  return [{value:node.id,number,title:node.title,selected:checked,disabled:!checked&&Boolean(problem),problem}];
 });
 // Keep broken legacy references visible and removable rather than silently
 // dropping them or disabling the very option needed to repair the draft.
 for(const id of selected)if(!nodes.has(id))options.push({value:id,number:'',title:'',selected:true,disabled:false,problem:'missing'});
 return options;
}

export function setRoutePrerequisites(route,nodeId,values){
 const context=prerequisiteContext(route,nodeId);
 if(!context)throw new Error('ROUTE_PREREQUISITE_UNAVAILABLE');
 if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))throw new Error('ROUTE_PREREQUISITE_INVALID');
 const prerequisites=[...new Set(values)];
 const {node,nodes,selected,descendants}=context;
 const repairsOverLimit=prerequisites.length<selected.size&&prerequisites.every(id=>selected.has(id));
 if(prerequisites.length>MAX_ROUTE_PREREQUISITES&&!repairsOverLimit)throw new Error('ROUTE_PREREQUISITE_LIMIT');
 for(const id of prerequisites){
  // Existing broken references may be retained while other ones are removed;
  // only newly introduced references must pass these dependency guards.
  if(selected.has(id))continue;
  if(id===nodeId)throw new Error('ROUTE_PREREQUISITE_SELF');
  if(!nodes.has(id))throw new Error('ROUTE_PREREQUISITE_UNAVAILABLE');
  if(descendants.has(id))throw new Error('ROUTE_PREREQUISITE_CYCLE');
 }
 if(prerequisites.length===node.prerequisites.length&&prerequisites.every((id,index)=>node.prerequisites[index]===id))return route;
 return {...route,chapters:route.chapters.map(chapter=>chapter.nodes.some(lesson=>lesson.id===nodeId)?{
  ...chapter,nodes:chapter.nodes.map(lesson=>lesson.id===nodeId?{...lesson,prerequisites}:lesson),
 }:chapter)};
}
