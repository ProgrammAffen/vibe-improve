import {useId, useLayoutEffect, useRef, type CSSProperties, type Dispatch, type SetStateAction} from 'react';
import {Bot, ChevronDown, Film, Globe2, Settings, SlidersHorizontal, UserRound, Volume2, type LucideIcon} from 'lucide-react';
import {translate, type Language} from '../i18n';
import BackHomeButton from './BackHomeButton';
import GameButton from './GameButton';
import './settings.css';

const ASSET = import.meta.env.BASE_URL + 'assets/images/';
type Copy = {zh: string; en: string};
type Icon = 'general' | 'sound' | 'account' | 'language' | 'motion' | 'volume' | 'agent';
const icons: Record<Icon, LucideIcon> = {general: Settings, sound: Volume2, account: UserRound, language: Globe2, motion: Film, volume: SlidersHorizontal,agent:Bot};
const copy = (zh: string, en: string): Copy => ({zh, en});
export type SoundPreferences = {enabled: boolean; volume: number; effects: boolean; motion: boolean};
type ItemBase = {id: string; label: Copy; icon: Icon; disabled?: boolean};
export type SettingsItem = ItemBase & (
  {kind: 'select'; value: string; options: {value: string; label: string}[]; onChange: (value: string) => void} |
  {kind: 'switch'; value: boolean; onChange: (value: boolean) => void} |
  {kind: 'range'; value: number; onChange: (value: number) => void} |
  {kind: 'action'; onAction: () => void} |
  {kind: 'text'; value: string}
);
export type SettingsCategory = {id: string; label: Copy; icon: Icon; groups: {id: string; label?: Copy; items: SettingsItem[]}[]};

type ArtKind = 'selected' | 'neutral' | 'row' | 'thumb';
const art: Record<ArtKind, {file: string; width: number; height: number; box: [number, number, number, number]}> = {
  selected: {file: 'settings-nav-selected-blank-v1.png', width: 1983, height: 793, box: [7, 67, 1968, 644]},
  neutral: {file: 'settings-nav-neutral-blank-v1.png', width: 1983, height: 793, box: [6, 65, 1971, 647]},
  row: {file: 'settings-row-blank-v1.png', width: 2172, height: 724, box: [53, 234, 2068, 252]},
  thumb: {file: 'settings-control-thumb-v1.png', width: 1254, height: 1254, box: [82, 98, 1089, 1054]},
};

function Plate({kind}: {kind: ArtKind}) {
  const {file, width, height, box: [x, y, w, h]} = art[kind];
  return <span className="camp-plate" aria-hidden="true"><img alt="" draggable="false" src={ASSET + file} style={{width: `${width / w * 100}%`, height: `${height / h * 100}%`, left: `${-x / w * 100}%`, top: `${-y / h * 100}%`}} /></span>;
}

export function SettingsSurface({language, categories, activeId, onSelect, onBack}: {
  language: Language; categories: SettingsCategory[]; activeId: string; onSelect: (id: string) => void; onBack: () => void;
}) {
  const t = (value: Copy) => translate(language, value.zh, value.en);
  const category = categories.find(item => item.id === activeId) ?? categories[0];
  const content = useRef<HTMLDivElement>(null);
  const positions = useRef<Record<string, number>>({});
  const scope = useId();
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = positions.current[category?.id] ?? 0;
  }, [category?.id]);
  if (!category) return null;
  return <section className="camp-settings-page" data-layout-region="settings" aria-labelledby={`${scope}-title`}>
    <div className="camp-stage" style={{'--camp-thumb-image': `url("${ASSET}settings-control-thumb-v1.png")`, '--camp-row-image': `url("${ASSET}settings-row-blank-v1.png")`} as CSSProperties}>
      <img className="camp-scene" src={ASSET + 'settings-camp-blank-v1.png'} alt="" draggable="false" />
      <BackHomeButton language={language} className="camp-back" onClick={onBack}/>
      <h1 className="camp-title" id={`${scope}-title`}>{t(copy('设置', 'Settings'))}</h1>
      <nav className="camp-nav camp-scroll" aria-label={t(copy('设置分类', 'Settings categories'))} data-layout-region="settings-navigation">
        {categories.map(item => {
          const Icon = icons[item.icon];
          return <GameButton key={item.id} variant={category.id === item.id ? 'primary' : 'secondary'} className={`camp-category ${category.id === item.id ? 'is-selected' : ''}`} leadingIcon={<Icon focusable="false"/>} aria-current={category.id === item.id ? 'page' : undefined} aria-controls={`${scope}-content`} onClick={() => onSelect(item.id)}>{t(item.label)}</GameButton>;
        })}
      </nav>
      <section className="camp-workspace" aria-labelledby={`${scope}-section-title`}>
        <h2 id={`${scope}-section-title`}>{t(category.label)}</h2>
        <div ref={content} id={`${scope}-content`} className="camp-content camp-scroll" data-layout-region="settings-content" onScroll={event => {positions.current[category.id] = event.currentTarget.scrollTop;}}>
          {category.groups.map(group => <section className="camp-group" key={group.id} aria-labelledby={group.label ? `${scope}-${category.id}-${group.id}` : undefined}>
            {group.label && <h3 id={`${scope}-${category.id}-${group.id}`}>{t(group.label)}</h3>}
            {group.items.map(item => <SettingRow key={item.id} item={item} language={language} id={`${scope}-${category.id}-${group.id}-${item.id}`} />)}
          </section>)}
        </div>
      </section>
    </div>
  </section>;
}

function SettingRow({item, language, id}: {item: SettingsItem; language: Language; id: string}) {
  const label = translate(language, item.label.zh, item.label.en);
  const Icon = icons[item.icon];
  if (item.kind === 'action') return <GameButton variant="secondary" className="camp-action" leadingIcon={<Icon focusable="false"/>} onClick={item.onAction} disabled={item.disabled} data-setting-id={item.id}>{label}</GameButton>;
  return <div className={`camp-row camp-row-${item.kind}`} data-setting-id={item.id}>
    <Plate kind="row" />
    <div className="camp-row-label"><Icon aria-hidden="true" /><label id={`${id}-label`} htmlFor={item.kind === 'select' || item.kind === 'range' ? id : undefined}>{label}</label></div>
    <div className="camp-row-control">
      {item.kind === 'select' && <div className="camp-select"><Plate kind="neutral" /><span className="camp-select-value" aria-hidden="true">{item.options.find(option => option.value === item.value)?.label}</span><select id={id} value={item.value} disabled={item.disabled} onChange={event => item.onChange(event.target.value)}>{item.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown aria-hidden="true" /></div>}
      {item.kind === 'switch' && <button type="button" className="camp-switch" role="switch" aria-labelledby={`${id}-label`} aria-checked={item.value} disabled={item.disabled} onClick={() => item.onChange(!item.value)}><span className={`camp-switch-track ${item.value ? 'is-on' : ''}`} aria-hidden="true"><Plate kind={item.value ? 'selected' : 'neutral'} /><span className="camp-switch-thumb"><Plate kind="thumb" /></span></span><span className="camp-switch-value">{translate(language, item.value ? '开启' : '关闭', item.value ? 'On' : 'Off')}</span></button>}
      {item.kind === 'range' && <div className="camp-volume"><input id={id} type="range" min="0" max="100" value={item.value} disabled={item.disabled} onChange={event => item.onChange(Number(event.target.value))} /><output htmlFor={id}>{item.value}%</output></div>}
      {item.kind === 'text' && <span className="camp-account-name">{item.value}</span>}
    </div>
  </div>;
}

export default function SettingsPage({language, onLanguage, sound, onSound, reducedMotion, activeId, onSelect, accountName, busy, onAccount, onBack, onAgents}: {
  language: Language; onLanguage: (language: Language) => void; sound: SoundPreferences; onSound: Dispatch<SetStateAction<SoundPreferences>>; reducedMotion: boolean;
  activeId: string; onSelect: (id: string) => void; accountName?: string; busy: boolean; onAccount: () => void; onBack: () => void; onAgents?: () => void;
}) {
  const categories: SettingsCategory[] = [
    {id: 'general', label: copy('通用', 'General'), icon: 'general', groups: [{id: 'preferences', items: [
      {id: 'language', label: copy('语言', 'Language'), icon: 'language', kind: 'select', value: language, options: [{value: 'zh-CN', label: '简体中文'}, {value: 'en', label: 'English'}], onChange: value => onLanguage(value as Language)},
      {id: 'motion', label: copy('主页动画', 'Home animation'), icon: 'motion', kind: 'switch', value: sound.motion && !reducedMotion, disabled: reducedMotion, onChange: value => onSound(previous => ({...previous, motion: value}))},
    ]}]},
    {id: 'sound', label: copy('声音', 'Sound'), icon: 'sound', groups: [{id: 'audio', items: [
      {id: 'enabled', label: copy('声音', 'Sound'), icon: 'sound', kind: 'switch', value: sound.enabled, onChange: value => onSound(previous => ({...previous, enabled: value}))},
      {id: 'volume', label: copy('音量', 'Volume'), icon: 'volume', kind: 'range', value: sound.volume, onChange: value => onSound(previous => ({...previous, volume: value}))},
      {id: 'effects', label: copy('交互音效', 'Interface sounds'), icon: 'sound', kind: 'switch', value: sound.effects, onChange: value => onSound(previous => ({...previous, effects: value}))},
    ]}]},
    {id:'agents',label:copy('智能体','Agents'),icon:'agent',groups:[{id:'connections',items:[{id:'manage',label:copy('检测与选择','Detect and choose'),icon:'agent',kind:'action',onAction:()=>onAgents?.(),disabled:!onAgents}]}]},
    {id: 'account', label: copy('账户', 'Account'), icon: 'account', groups: [{id: 'identity', items: [
      {id: 'identity', label: copy('账户', 'Account'), icon: 'account', kind: 'text', value: accountName || translate(language, '未登录', 'Not signed in')},
      {id: 'open', label: copy('我的账户', 'My account'), icon: 'account', kind: 'action', onAction: onAccount, disabled: busy},
    ]}]},
  ];
  return <SettingsSurface language={language} categories={categories} activeId={activeId} onSelect={onSelect} onBack={onBack} />;
}
