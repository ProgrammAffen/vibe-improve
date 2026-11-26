import {WIDTH,type MapPage,type Point,type TrailSegment} from '../../../../packages/map-layout/index.mjs';

// Smoothly inset the upper/lower ends of the guide while retaining its broad
// middle. Sparse pages use a constant inset so their x direction cannot reverse.
export function roundMapCorners(page:MapPage,height:number,amount:number):MapPage{
  const strength=(y:number)=>{
    if(page.compact||page.nodes.length<=5)return {value:1-amount,derivative:0};
    const distance=Math.abs(y/height-.5)*2;
    const t=Math.max(0,Math.min(1,(distance-.05)/.35));
    return {value:1-amount*t*t*(3-2*t),
      derivative:t>0&&t<1?-amount*6*t*(1-t)*Math.sign(y/height-.5)*2/(height*.35):0};
  };
  const point=(p:Point):Point=>({x:WIDTH/2+(p.x-WIDTH/2)*strength(p.y).value,y:p.y});
  const paths=(source:readonly TrailSegment[])=>source.flatMap(path=>{
    const length=Math.hypot(path.control1.x-path.start.x,path.control1.y-path.start.y)+
      Math.hypot(path.control2.x-path.control1.x,path.control2.y-path.control1.y)+Math.hypot(path.end.x-path.control2.x,path.end.y-path.control2.y);
    const count=Math.max(2,Math.ceil(length/80));
    const at=(t:number)=>{
      const u=1-t;
      const p={x:u**3*path.start.x+3*u*u*t*path.control1.x+3*u*t*t*path.control2.x+t**3*path.end.x,
        y:u**3*path.start.y+3*u*u*t*path.control1.y+3*u*t*t*path.control2.y+t**3*path.end.y};
      const dx=3*(u*u*(path.control1.x-path.start.x)+2*u*t*(path.control2.x-path.control1.x)+t*t*(path.end.x-path.control2.x));
      const dy=3*(u*u*(path.control1.y-path.start.y)+2*u*t*(path.control2.y-path.control1.y)+t*t*(path.end.y-path.control2.y));
      const profile=strength(p.y);
      return {point:point(p),tangent:{x:dx*profile.value+(p.x-WIDTH/2)*profile.derivative*dy,y:dy}};
    };
    return Array.from({length:count},(_,index)=>{
      const a=at(index/count),b=at((index+1)/count),third=1/(count*3);
      const start=a.point,end=b.point,control1={x:start.x+a.tangent.x*third,y:start.y+a.tangent.y*third},
        control2={x:end.x-b.tangent.x*third,y:end.y-b.tangent.y*third};
      return {...path,from:index===0?path.from:null,to:index===count-1?path.to:null,start,control1,control2,end,
        d:`M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
    });
  });
  return {...page,nodes:page.nodes.map(node=>({...node,...point(node)})),paths:paths(page.paths),
    finish:page.finish?{...page.finish,...point(page.finish)}:null,finishPaths:paths(page.finishPaths)};
}
