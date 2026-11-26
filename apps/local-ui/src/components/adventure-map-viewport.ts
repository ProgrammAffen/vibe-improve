import {WIDTH, createMapPageVariant, placeRouteMarkers, routeMarkerGap, type MapNode, type MapFinish, type MapPage, type Point, type TrailSegment} from '../../../../packages/map-layout/index.mjs';
import {mapArtworkBoxes as artworkBoxes,mapCornerExclusions} from './map-scene-frame';
import {roundMapCorners} from './adventure-map-corners';

export type MapViewport = {width: number; height: number; top: number; bottom: number};
type Extent = {at: number; before: number; after: number};
type Transform = {x: number; y: number; scaleX: number; scaleY: number};

function artworkOverlaps(page: MapPage) {
  const boxes=[...page.nodes,...(page.finish?[page.finish]:[])].map(node=>artworkBoxes(node,page.themeId));
  return boxes.some((group,index)=>group.some(box=>boxes.slice(0,index).some(previous=>previous.some(other=>
    Math.min(box.right,other.right)-Math.max(box.left,other.left)>0&&
    Math.min(box.bottom,other.bottom)-Math.max(box.top,other.top)>0))));
}

function cornersBlocked(page:MapPage,height:number){
  const corners=mapCornerExclusions(height);
  return [...page.nodes,...(page.finish?[page.finish]:[])].some(node=>
    artworkBoxes(node,page.themeId).some(box=>corners.some(corner=>
      box.left<corner.right&&box.right>corner.left&&box.top<corner.bottom&&box.bottom>corner.top)));
}

function placeFinish(page:MapPage,viewport:MapViewport,height:number):MapPage|null{
  if(!page.finish)return page;
  const last=page.nodes.at(-1)!;
  if(page.finish.x>last.x&&!cornersBlocked(page,height)&&!artworkOverlaps(page))return page;
  const scale=viewport.width/WIDTH,top=Math.max(height*.1,viewport.top/scale),bottom=Math.min(height*.9,height-viewport.bottom/scale);
  const incoming=page.paths.at(-1)!,dx=incoming.end.x-incoming.control2.x,dy=incoming.end.y-incoming.control2.y,length=Math.hypot(dx,dy)||1;
  const radius=(last.width+page.finish.width)/2+24;
  const point=(path:TrailSegment,t:number):Point=>({x:cubic(path.start.x,path.control1.x,path.control2.x,path.end.x,t),
    y:cubic(path.start.y,path.control1.y,path.control2.y,path.end.y,t)});
  const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const main=page.paths.flatMap(path=>Array.from({length:8},(_,index)=>[point(path,index/8),point(path,(index+1)/8)]));
  for(const advance of [radius,radius+36,radius+72])for(const offset of [0,48,-48,96,-96,144,-144]){
    const finish={...page.finish,x:last.x+advance,y:Math.max(top+page.finish.height,Math.min(bottom-6,last.y+offset))};
    if(finish.x+finish.width/2>WIDTH*.9)continue;
    const lead=Math.min(44,advance/3),start={x:last.x,y:last.y},end={x:finish.x,y:finish.y};
    const control1={x:start.x+dx/length*lead,y:start.y+dy/length*lead},control2={x:end.x-lead,y:end.y};
    const tail={from:last.key,to:finish.key,leg:page.nodes.length-1,start,control1,control2,end,
      d:`M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
    const candidate={...page,finish,finishPaths:[tail]};
    if(cornersBlocked(candidate,height)||artworkOverlaps(candidate))continue;
    const segments=Array.from({length:24},(_,index)=>[point(tail,index/24),point(tail,(index+1)/24)]);
    if(segments.some(([a,b])=>main.some(([c,d])=>cross(a,b,c)*cross(a,b,d)<-1e-6&&cross(c,d,a)*cross(c,d,b)<-1e-6)))continue;
    return candidate;
  }
  return null;
}

const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  a * (1-t) ** 3 + 3*b*(1-t) ** 2*t + 3*c*(1-t)*t*t + d*t ** 3;

function curveRange(path: TrailSegment, axis: 'x' | 'y') {
  const a=path.start[axis], b=path.control1[axis], c=path.control2[axis], d=path.end[axis];
  const A=-a+3*b-3*c+d, B=2*(a-2*b+c), C=b-a;
  const discriminant=B*B-4*A*C;
  const roots=Math.abs(A)<1e-9 ? (Math.abs(B)<1e-9 ? [] : [-C/B]) :
    discriminant<0 ? [] : [(-B+Math.sqrt(discriminant))/(2*A),(-B-Math.sqrt(discriminant))/(2*A)];
  const values=[a,d,...roots.filter(t=>t>0&&t<1).map(t=>cubic(a,b,c,d,t))];
  return [Math.min(...values),Math.max(...values)];
}

// Fixed-size artwork must stay inside the frame while its anchors spread out.
// A lesson at the top therefore reserves only its own height, not a chapter's.
function contentExtents(nodes: readonly MapNode[], finish: MapFinish | null, paths: readonly TrailSegment[], theme: MapPage['themeId']) {
  const x: Extent[]=[], y: Extent[]=[];
  const box=(point: Point,left: number,top: number,right: number,bottom: number)=>{
    x.push({at:point.x,before:left,after:right});
    y.push({at:point.y,before:top,after:bottom});
  };
  for(const node of nodes){
    for(const bounds of artworkBoxes(node,theme))
      box(node,node.x-bounds.left,node.y-bounds.top,bounds.right-node.x,bounds.bottom-node.y+4);
  }
  if(finish)box(finish,finish.width/2,finish.height,finish.width/2,6);
  // Include actual Bézier extrema and the trail's rim, not distant handles.
  for(const path of paths)for(const axis of ['x','y'] as const){
    const [low,high]=curveRange(path,axis);
    (axis==='x'?x:y).push({at:low,before:24,after:24},{at:high,before:24,after:24});
  }
  return {x,y};
}

function fitAxis(extents: Extent[], low: number, high: number,expand=true) {
  const first=Math.min(...extents.map(item=>item.at)), last=Math.max(...extents.map(item=>item.at));
  const origin=(first+last)/2;
  const interval=(scale: number)=>[
    Math.max(...extents.map(item=>low-(item.at-origin)*scale+item.before)),
    Math.min(...extents.map(item=>high-(item.at-origin)*scale-item.after)),
  ];
  let lower=0,upper=last-first>1e-6?(high-low)/(last-first):1;
  if(!expand)upper=Math.min(upper,1);
  for(let iteration=0;iteration<36;iteration++){
    const scale=(lower+upper)/2, [start,end]=interval(scale);
    if(start<=end)lower=scale;else upper=scale;
  }
  const [start,end]=interval(lower);
  return {scale:lower,offset:expand?(start+end)/2-origin*lower:Math.max(start-origin*lower,Math.min(end-origin*lower,0))};
}

function fitMapPage(page: MapPage, viewport: MapViewport, artworkScale: number,expand=true): {page: MapPage; height: number} {
  const pixelScale=viewport.width/WIDTH, height=viewport.height/pixelScale;
  if(!page.nodes.length)return {page,height};
  const frame={left:WIDTH*.1,right:WIDTH*.9,top:Math.max(height*.1,viewport.top/pixelScale),
    bottom:Math.min(height*.9,height-viewport.bottom/pixelScale)};
  let transform: Transform={x:0,y:0,scaleX:1,scaleY:1};
  const project=(point: Point): Point=>({x:point.x*transform.scaleX+transform.x,y:point.y*transform.scaleY+transform.y});
  const projectPaths=(paths: readonly TrailSegment[])=>paths.map(path=>{
    const start=project(path.start),control1=project(path.control1),control2=project(path.control2),end=project(path.end);
    return {...path,start,control1,control2,end,d:`M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
  });
  let nodes: MapNode[]=[],paths: TrailSegment[]=[],finish: MapFinish|null=null,finishPaths: TrailSegment[]=[];
  // Fitting changes arc lengths, which can move a chapter to a different bend.
  // Recheck its actual artwork after each equal-spacing pass. Always transform
  // the original guide so repeated passes cannot accumulate tiny curve splits.
  for(let iteration=0;iteration<16;iteration++){
    nodes=page.nodes.map(node=>({...node,width:node.width*artworkScale,height:node.height*artworkScale,
      artworkScale:(node.artworkScale??1)*artworkScale,...project(node)}));
    paths=projectPaths(page.paths);
    finish=page.finish?{...page.finish,width:page.finish.width*artworkScale,height:page.finish.height*artworkScale,...project(page.finish)}:null;
    finishPaths=projectPaths(page.finishPaths);
    if(nodes.length>1&&paths.length){
      const positioned=placeRouteMarkers(nodes,paths,page.themeId);
      if(positioned){nodes=positioned.nodes;paths=positioned.paths;}
    }
    const extents=contentExtents(nodes,finish,[...paths,...finishPaths],page.themeId);
    const horizontal=fitAxis(extents.x,frame.left,frame.right,expand),vertical=fitAxis(extents.y,frame.top,frame.bottom,expand);
    if(iteration===15||Math.abs(horizontal.scale-1)<.00001&&Math.abs(vertical.scale-1)<.00001&&
      Math.abs(horizontal.offset)<.01&&Math.abs(vertical.offset)<.01)break;
    transform={x:transform.x*horizontal.scale+horizontal.offset,y:transform.y*vertical.scale+vertical.offset,
      scaleX:transform.scaleX*horizontal.scale,scaleY:transform.scaleY*vertical.scale};
  }
  return {page:{...page,nodes,paths,finish,finishPaths,spacing:routeMarkerGap(nodes,paths,page.themeId)},height};
}

function fitCornerPage(page:MapPage,viewport:MapViewport):{page:MapPage;height:number}|null{
  let fitted=fitMapPage(page,viewport,1);
  for(const scale of [1,.94,.88,.82,.76,.7,.64,.58]){
    const base=scale===1?fitted:fitMapPage(page,viewport,scale);
    for(const amount of [.35,.4,.45,.5,.55,.6,.65,.7,.75]){
      const rounded=roundMapCorners(base.page,base.height,amount);
      const candidate=fitMapPage(rounded,viewport,1,false);
      fitted=candidate;
      const learning={...candidate.page,finish:null,finishPaths:[]};
      if(cornersBlocked(learning,candidate.height)||artworkOverlaps(learning))continue;
      const placed=placeFinish(candidate.page,viewport,candidate.height);
      if(placed)return {...candidate,page:placed};
    }
  }
  return null;
}

export function projectMapPage(page:MapPage,viewport:MapViewport,_reference?:MapPage):{page:MapPage;height:number}{
  let best:ReturnType<typeof fitCornerPage>=null,bestWidth=0;
  for(const variant of [0,1,2]){
    const source=variant?createMapPageVariant(page,variant):page;
    if(!source)continue;
    const projected=fitCornerPage(source,viewport);
    if(!projected)continue;
    const boxes=projected.page.nodes.flatMap(node=>artworkBoxes(node,page.themeId));
    const width=(Math.max(...boxes.map(box=>box.right))-Math.min(...boxes.map(box=>box.left)))/(WIDTH*.8);
    if(!best||width>bestWidth){best=projected;bestWidth=width;}
    // Sparse pages favor a short forward walk. Full pages should still use the
    // broad middle after the corners are removed; try another seeded guide only
    // when the first valid projection has collapsed into a narrow strip.
    if(page.compact||page.nodes.length<8||bestWidth>=.7)return best;
  }
  if(best)return best;
  throw new Error('Could not place route markers outside the decorated corners');
}
