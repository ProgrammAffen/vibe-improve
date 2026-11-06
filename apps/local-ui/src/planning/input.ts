export type ImeKey={key:string;isComposing?:boolean;keyCode?:number;which?:number};
export function createImeGuard(now:()=>number=()=>performance.now()){
 let composing=false,confirmingEnter=false,endedAt=Number.NEGATIVE_INFINITY;
 const active=(event?:Partial<ImeKey>)=>composing||event?.isComposing===true||event?.keyCode===229||event?.which===229;
 return {
  start(){composing=true;endedAt=Number.NEGATIVE_INFINITY},
  end(){composing=false;endedAt=now()},
  active,
  keyDown(event:ImeKey){
   if(event.key!=='Enter'){if(!active(event))endedAt=Number.NEGATIVE_INFINITY;return active(event)}
   // WebKit can finish composition before delivering its confirmation keydown.
   const blocked=active(event)||confirmingEnter||now()-endedAt<120;
   if(blocked)confirmingEnter=true;
   return blocked;
  },
  keyUp(event:ImeKey){if(event.key==='Enter'||event.keyCode===229||event.which===229){confirmingEnter=false;endedAt=Number.NEGATIVE_INFINITY}},
  reset(){composing=false;confirmingEnter=false;endedAt=Number.NEGATIVE_INFINITY}
 };
}
