import './toggle.css';

export default function GameToggle({id,label,checked,disabled=false,onChange}:{id?:string;label:string;checked:boolean;disabled?:boolean;onChange:(checked:boolean)=>void}){
  return <button id={id} type="button" className={`game-toggle ${checked?'is-on':''}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={()=>onChange(!checked)}>
    <span className="game-toggle-track" aria-hidden="true"><span className="game-toggle-knob"/></span>
  </button>;
}
