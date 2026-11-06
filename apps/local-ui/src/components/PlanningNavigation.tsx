import {ArrowLeft} from 'lucide-react';
import type {Language} from '../i18n';
import BackHomeButton from './BackHomeButton';
import GameButton from './GameButton';

export default function PlanningNavigation({language,busy,onHome,onPrevious}:{language:Language;busy:boolean;onHome:()=>void;onPrevious:()=>void}){
 return <div className="planning-navigation-layer"><nav className="planning-navigation"><BackHomeButton language={language} onClick={onHome} disabled={busy}/><GameButton variant="secondary" leadingIcon={<ArrowLeft/>} onClick={onPrevious} disabled={busy}>{language==='en'?'Previous':'上一步'}</GameButton></nav></div>;
}
