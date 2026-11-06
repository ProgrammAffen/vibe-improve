import {useEffect,useRef,useState,type ReactNode,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {ChevronRight,MoreHorizontal} from 'lucide-react';

export type EditorMenuItem={label:string;icon:ReactNode;onClick?:()=>void;children?:EditorMenuItem[];disabled?:boolean;danger?:boolean};
type Position={left:number;top?:number;bottom?:number};
type Submenu={item:EditorMenuItem;position:Position;focus:boolean};

export default function EditorMenu({label,items,disabled=false}:{label:string;items:EditorMenuItem[];disabled?:boolean}){
 const [position,setPosition]=useState<Position|null>(null),[submenu,setSubmenu]=useState<Submenu|null>(null);
 const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null),subpopup=useRef<HTMLDivElement>(null),parent=useRef<HTMLButtonElement|null>(null);
 function close(){setPosition(null);setSubmenu(null)}
 function open(){const r=trigger.current!.getBoundingClientRect(),height=items.length*44+14;setPosition({left:Math.max(8,Math.min(window.innerWidth-248,r.right-240)),top:Math.max(8,Math.min(r.bottom+4,window.innerHeight-height-8))})}
 function openSubmenu(item:EditorMenuItem,button:HTMLButtonElement,focus=false){
  const r=popup.current!.getBoundingClientRect(),anchor=button.getBoundingClientRect(),width=Math.min(240,window.innerWidth-16),height=(item.children?.length??0)*44+14;
  parent.current=button;setSubmenu({item,focus,position:{left:Math.max(8,r.right+width+4<=window.innerWidth-8?r.right+4:r.left-width-4),top:Math.max(8,Math.min(anchor.top,window.innerHeight-height-8))}});
 }
 useEffect(()=>{
  if(!position)return;
  popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  function outside(event:PointerEvent){const target=event.target as Node;if(!trigger.current?.contains(target)&&!popup.current?.contains(target)&&!subpopup.current?.contains(target))close()}
  function scroll(event:Event){const target=event.target as Node;if(!popup.current?.contains(target)&&!subpopup.current?.contains(target))close()}
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true)};
 },[position]);
 useEffect(()=>{if(submenu?.focus)subpopup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()},[submenu]);
 useEffect(()=>{if(disabled)close()},[disabled]);
 function keys(event:KeyboardEvent<HTMLDivElement>,nested=false){
  if(event.key==='Tab'){close();return}
  if(event.key==='Escape'||nested&&event.key==='ArrowLeft'){
   event.preventDefault();event.stopPropagation();if(nested){setSubmenu(null);parent.current?.focus()}else{close();trigger.current?.focus()}return;
  }
  const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus()}
 }
 function entries(values:EditorMenuItem[],nested=false){return values.map(item=><button key={item.label} type="button" role="menuitem" className={`${item.danger?'is-danger':''} ${!nested&&submenu?.item.label===item.label?'is-open':''}`} disabled={item.disabled} aria-haspopup={item.children?'menu':undefined} aria-expanded={item.children?!nested&&submenu?.item.label===item.label:undefined}
  onPointerEnter={event=>{if(nested)return;if(item.children)openSubmenu(item,event.currentTarget);else setSubmenu(null)}}
  onFocus={()=>{if(!nested&&!item.children)setSubmenu(null)}}
  onKeyDown={event=>{if(item.children&&event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();openSubmenu(item,event.currentTarget,true)}}}
  onClick={event=>{if(item.children){openSubmenu(item,event.currentTarget,true);return}close();trigger.current?.focus();item.onClick?.()}}>{item.icon}<span>{item.label}</span>{item.children&&<ChevronRight className="route-editor-submenu-arrow"/>}</button>)}
 return <><button ref={trigger} type="button" className="icon-button route-editor-icon" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={Boolean(position)} disabled={disabled} onClick={()=>position?close():open()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();open()}}}><MoreHorizontal/></button>{position&&createPortal(<>
  <div ref={popup} className="route-editor-menu" role="menu" aria-label={label} style={position} onKeyDown={keys}>{entries(items)}</div>
  {submenu&&<div ref={subpopup} className="route-editor-menu route-editor-submenu" role="menu" aria-label={submenu.item.label} style={submenu.position} onKeyDown={event=>keys(event,true)}>{entries(submenu.item.children??[],true)}</div>}
 </>,document.body)}</>;
}
