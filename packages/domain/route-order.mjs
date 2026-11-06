const sameTarget=(a,b)=>a.chapterId===b.chapterId&&(a.nodeId??null)===(b.nodeId??null);

export function routeOutline(route){
 return route.chapters.map((chapter,ci)=>({chapter,number:String(ci+1).padStart(2,'0'),lessons:chapter.nodes.map((node,ni)=>({node,number:`${ci+1}.${ni+1}`}))}));
}

export function routeTargetPosition(route,target){
 if(!route||!target)return null;
 for(let ci=0;ci<route.chapters.length;ci++){
  const chapter=route.chapters[ci];
  if(target.nodeId){
   const ni=chapter.nodes.findIndex(node=>node.id===target.nodeId);
   if(ni>=0)return{target:{chapterId:chapter.id,nodeId:target.nodeId},chapterIndex:ci,nodeIndex:ni,number:`${ci+1}.${ni+1}`};
  }else if(chapter.id===target.chapterId)return{target:{chapterId:chapter.id},chapterIndex:ci,nodeIndex:null,number:String(ci+1).padStart(2,'0')};
 }
 return null;
}

export function routeMoveProblem(route,source,destination,placement='after'){
 const from=routeTargetPosition(route,source),to=routeTargetPosition(route,destination);
 if(!from||!to||!['before','after'].includes(placement))return 'unavailable';
 if(!source.nodeId&&destination.nodeId)return 'chapter-only';
 if(sameTarget(from.target,to.target))return 'self';
 if(source.nodeId){
  if(from.chapterIndex!==to.chapterIndex&&route.chapters[to.chapterIndex].nodes.length>=64)return 'full';
  const insertion=to.nodeIndex===null?0:to.nodeIndex+(placement==='after'?1:0);
  if(from.chapterIndex===to.chapterIndex&&(insertion===from.nodeIndex||insertion===from.nodeIndex+1))return 'same-position';
 }else{
  const insertion=to.chapterIndex+(placement==='after'?1:0);
  if(insertion===from.chapterIndex||insertion===from.chapterIndex+1)return 'same-position';
 }
 return null;
}

export function moveRouteItem(route,source,destination,placement='after'){
 const problem=routeMoveProblem(route,source,destination,placement);
 if(problem==='self'||problem==='same-position')return route;
 if(problem)throw new Error('ROUTE_MOVE_'+problem.toUpperCase().replaceAll('-','_'));
 const next=JSON.parse(JSON.stringify(route)),from=routeTargetPosition(next,source);
 if(source.nodeId){
  const [node]=next.chapters[from.chapterIndex].nodes.splice(from.nodeIndex,1),to=routeTargetPosition(next,destination);
  next.chapters[to.chapterIndex].nodes.splice(to.nodeIndex===null?0:to.nodeIndex+(placement==='after'?1:0),0,node);
 }else{
  const [chapter]=next.chapters.splice(from.chapterIndex,1),to=routeTargetPosition(next,destination);
  next.chapters.splice(to.chapterIndex+(placement==='after'?1:0),0,chapter);
 }
 return next;
}

export function moveRouteItemBy(route,source,offset){
 if(![-1,1].includes(offset))throw new Error('ROUTE_MOVE_UNAVAILABLE');
 const from=routeTargetPosition(route,source);if(!from)throw new Error('ROUTE_MOVE_UNAVAILABLE');
 const index=(from.nodeIndex??from.chapterIndex)+offset;
 const neighbor=source.nodeId?route.chapters[from.chapterIndex].nodes[index]:route.chapters[index];
 if(!neighbor)return route;
 return moveRouteItem(route,from.target,source.nodeId?{chapterId:from.target.chapterId,nodeId:neighbor.id}:{chapterId:neighbor.id},offset<0?'before':'after');
}
