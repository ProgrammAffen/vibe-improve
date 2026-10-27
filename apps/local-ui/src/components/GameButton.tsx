import {type ButtonHTMLAttributes, type ReactNode} from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  icon?: 'play' | 'folder' | 'gear' | 'exit' | 'person';
  leadingIcon?: ReactNode;
  children: ReactNode;
  previewHover?: boolean;
};

const textures = {
  primary: {file: 'home-menu-primary-blank-v1.png', width: 2172, height: 724, crop: [50, 88, 2075, 530]},
  secondary: {file: 'home-menu-secondary-blank-v1.png', width: 2073, height: 758, crop: [40, 108, 1994, 529]},
  danger: {file: 'home-menu-exit-blank-v1.png', width: 2172, height: 724, crop: [33, 57, 2107, 593]},
};
export default function GameButton({variant = 'primary', icon, leadingIcon, className = '', children, previewHover = false, type = 'button', ...props}: Props) {
  const texture = textures[variant];
  const [x, y, width, height] = texture.crop;
  return <button {...props} type={type} className={`game-button game-button--${variant} ${icon || leadingIcon ? 'has-icon' : ''} ${previewHover ? 'is-hover-preview' : ''} ${className}`} data-layout-control="game-button">
    <span className="game-button-art" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/images/${texture.file}`} alt="" style={{width: `${100 * texture.width / width}%`, height: `${100 * texture.height / height}%`, left: `${-100 * x / width}%`, top: `${-100 * y / height}%`}} /></span>
    {leadingIcon ? <span className="game-button-leading-icon" aria-hidden="true">{leadingIcon}</span> : icon && <img className="game-button-icon" src={`${import.meta.env.BASE_URL}assets/images/home-icon-${icon === 'person' ? 'person-dark' : icon}-v1.svg`} alt="" />}
    <span className="game-button-label" data-layout-text="button">{children}</span>
  </button>;
}
