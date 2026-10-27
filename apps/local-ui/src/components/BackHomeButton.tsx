import {ArrowLeft} from 'lucide-react';
import {translate, type Language} from '../i18n';
import GameButton from './GameButton';

type Props = Omit<Parameters<typeof GameButton>[0], 'children' | 'variant' | 'icon' | 'leadingIcon'> & {language: Language};

export default function BackHomeButton({language, className = '', ...props}: Props) {
  return <GameButton {...props} variant="secondary" leadingIcon={<ArrowLeft focusable="false" />} className={`back-home-button ${className}`}>{translate(language, '返回主页', 'Back home')}</GameButton>;
}
