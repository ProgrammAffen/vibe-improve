import {useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronDown} from 'lucide-react';
import {GameButtonArt} from './GameButton';
import './game-select.css';

export type GameSelectOption = {value: string; label: string; disabled?: boolean; icon?: string};
type Props = {
  value: string;
  options: GameSelectOption[];
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  valueLabel?: string;
  preferredPlacement?: 'above' | 'below';
};

const palette = ['paper', 'ink', 'edge', 'hover', 'selected', 'accent'] as const;

export default function GameSelect({value, options, onChange, id, className = '', triggerClassName = '', menuClassName = '',
  'aria-label': label, 'aria-labelledby': labelledBy, disabled = false, title, placeholder = '', valueLabel, preferredPlacement = 'below'}: Props) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listId = triggerId + '-choices';
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef({text: '', time: 0});
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<CSSProperties>();
  const selected = options.find(option => option.value === value);
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const expanded = open && !disabled;
  const surface = expanded ? trigger.current?.closest('dialog[open]') ?? document.body : null;
  const optionId = (index: number) => listId + '-' + index;

  useLayoutEffect(() => {if (disabled) setOpen(false);}, [disabled]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const button = trigger.current, menu = list.current;
    if (!button || !menu || !surface) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 10, gap = 5;
      const width = Math.min(Math.max(rect.width, Math.min(menu.scrollWidth + 2, 320)), viewportWidth - margin * 2);
      const below = viewportHeight - rect.bottom - margin - gap;
      const above = rect.top - margin - gap;
      const naturalHeight = Math.min(menu.scrollHeight, 280);
      const opensAbove = preferredPlacement === 'above' ? above >= naturalHeight || above > below : below < naturalHeight && above > below;
      const maxHeight = Math.max(44, Math.min(280, opensAbove ? above : below));
      const height = Math.min(naturalHeight, maxHeight);
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
      const top = Math.max(margin, opensAbove ? rect.top - gap - height : rect.bottom + gap);
      const containerStyle = getComputedStyle(surface);
      const local = surface !== document.body && (containerStyle.filter !== 'none' || containerStyle.transform !== 'none' || containerStyle.perspective !== 'none');
      const offset = local ? surface.getBoundingClientRect() : {left: 0, top: 0};
      const style = getComputedStyle(button);
      const colors = Object.fromEntries(palette.map(name => ['--game-select-' + name, style.getPropertyValue('--game-select-' + name)]));
      setPlacement({left: left - offset.left, top: top - offset.top, width, maxHeight, fontFamily: style.fontFamily,
        fontSize: style.fontSize, fontWeight: style.fontWeight, ...colors});
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.contains(event.target) && !menu.contains(event.target)) setOpen(false);
    };
    const onScroll = (event: Event) => {if (!(event.target instanceof Node) || !menu.contains(event.target)) position();};
    position();
    const observer = new ResizeObserver(position);
    observer.observe(button);
    observer.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [expanded, surface, preferredPlacement, options]);

  useLayoutEffect(() => {
    const row = list.current?.children.item(active);
    if (expanded && row instanceof HTMLElement) row.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [expanded, active, placement]);

  function show(last = false) {
    if (disabled || !enabled.length) return;
    const current = options.findIndex(option => option.value === value && !option.disabled);
    setActive(current >= 0 ? current : (last ? enabled.at(-1) : enabled[0]) ?? -1);
    setPlacement(undefined);
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (disabled || !option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || event.nativeEvent.isComposing) return;
    const {key} = event;
    if (key === 'Tab') {setOpen(false); return;}
    if (key === 'Escape' && expanded) {event.preventDefault(); event.stopPropagation(); setOpen(false); return;}
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (expanded) choose(active); else show();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault();
      if (!expanded) {show(key === 'ArrowUp' || key === 'End'); return;}
      const position = enabled.indexOf(active);
      if (key === 'Home') setActive(enabled[0] ?? -1);
      else if (key === 'End') setActive(enabled.at(-1) ?? -1);
      else setActive(enabled[Math.max(0, Math.min(enabled.length - 1, position + (key === 'ArrowDown' ? 1 : -1)))] ?? -1);
      return;
    }
    if (key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      search.current = {text: (now - search.current.time < 700 ? search.current.text : '') + key.toLocaleLowerCase(), time: now};
      const next = enabled.find(index => options[index].label.toLocaleLowerCase().startsWith(search.current.text));
      if (next !== undefined) {event.preventDefault(); if (!expanded) show(); setActive(next);}
    }
  }

  return <span className={`game-select ${className}`}>
    <button ref={trigger} id={triggerId} type="button" className={`game-select-trigger ${triggerClassName}`} role="combobox"
      aria-label={label} aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
      aria-disabled={disabled || undefined} disabled={disabled} title={title ?? valueLabel ?? selected?.label ?? placeholder}
      onKeyDown={onKeyDown} onBlur={() => setOpen(false)} onClick={event => {event.currentTarget.focus(); if (expanded) setOpen(false); else show();}}>
      <GameButtonArt variant="secondary"/>
      {selected?.icon && <img className="game-select-icon" src={selected.icon} alt=""/>}
      <span className="game-select-value">{valueLabel ?? selected?.label ?? placeholder}</span><ChevronDown aria-hidden="true"/>
    </button>
    {expanded && surface && createPortal(<ul ref={list} id={listId} className={`game-select-options ${menuClassName}`} role="listbox"
      aria-label={label} aria-labelledby={labelledBy} style={placement ?? {visibility: 'hidden'}}>
      {options.map((option, index) => <li key={option.value} id={optionId(index)} role="option" aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined} data-active={index === active || undefined}
        onMouseDown={event => event.preventDefault()} onPointerMove={() => {if (!option.disabled) setActive(index);}} onClick={() => choose(index)}>
        {option.icon && <img className="game-select-icon" src={option.icon} alt=""/>}
        <span>{option.label}</span>{option.value === value && <Check aria-hidden="true"/>}
      </li>)}
    </ul>, surface)}
  </span>;
}
