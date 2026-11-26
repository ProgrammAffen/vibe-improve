import {useEffect, useMemo, useRef, useState} from 'react';
import {ExternalLink, LoaderCircle, RotateCw, StickyNote} from 'lucide-react';
import {translate, type Language} from '../i18n';
import {safeLink} from '../lesson-editor/import-content';
import {readWebNoteRequest, webNotes, type WebAnnotations} from './web-notes';

type Rect = {x: number; y: number; width: number; height: number};
type Edges = {left: number; top: number; right: number; bottom: number};
type Geometry = {frame: Rect; clip: Rect; viewport: {width: number; height: number}};
type WebPageState = 'loading' | 'ready' | 'failed';
const stateEvent = 'vibe-inline-browser-state';
const noteEvent = 'vibe-inline-note';
const emptyClip: Rect = {x: 0, y: 0, width: 0, height: 0};
const clippingOverflow = /^(auto|scroll|hidden|clip|overlay)$/;
const coveringUI = '.game-select-options, .notebook-insert-menu, .notebook-toast';

function intersect(a: Edges, b: Edges): Edges {
  return {left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)};
}

function hasArea(rect: Edges) {
  return rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1;
}

function readGeometry(slot: HTMLElement): Geometry {
  const box = slot.getBoundingClientRect();
  const viewport = {width: window.innerWidth, height: window.innerHeight};
  const frame = {x: box.left, y: box.top, width: box.width, height: box.height};
  let clip = intersect(box, {left: 0, top: 0, right: viewport.width, bottom: viewport.height});
  const hidden = {frame, clip: emptyClip, viewport};
  if (document.hidden || !hasArea(clip) || slot.closest('[inert], [aria-hidden="true"], [data-inline-web-paused]') || document.querySelector('dialog[open]')) return hidden;

  // Native content must not cover the notebook toolbar, its scrollbar, or the chat column.
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = clippingOverflow.test(style.overflowX), clipsY = clippingOverflow.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const outer = parent.getBoundingClientRect();
    const left = outer.left + parent.clientLeft, top = outer.top + parent.clientTop;
    clip = intersect(clip, {
      left: clipsX ? left : clip.left, right: clipsX ? left + parent.clientWidth : clip.right,
      top: clipsY ? top : clip.top, bottom: clipsY ? top + parent.clientHeight : clip.bottom,
    });
    if (!hasArea(clip)) return hidden;
  }
  if (Array.from(document.querySelectorAll(coveringUI)).some(element => hasArea(intersect(clip, element.getBoundingClientRect())))) return hidden;
  return {frame, viewport, clip: {x: clip.left, y: clip.top, width: clip.right - clip.left, height: clip.bottom - clip.top}};
}

// Share listeners across all web cards, including notebooks with many links.
type Watch = (slot: HTMLElement, sync: () => void) => () => void;
let watchSlots: Watch | null = null;

function watchSlot(slot: HTMLElement, sync: () => void): () => void {
  watchSlots ??= createWatcher();
  return watchSlots(slot, sync);
}

function createWatcher(): Watch {
  const slots = new Map<HTMLElement, () => void>();
  let animation: number | null = null;
  function schedule() {
    if (animation !== null) return;
    animation = requestAnimationFrame(() => {
      animation = null;
      for (const sync of slots.values()) sync();
    });
  }
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  function start() {
    resize.observe(document.documentElement);
    mutations.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['open', 'class', 'style', 'inert', 'hidden', 'aria-hidden', 'data-inline-web-paused'],
    });
    window.addEventListener('scroll', schedule, {capture: true, passive: true});
    window.addEventListener('resize', schedule);
    document.addEventListener('load', schedule, true);
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('visibilitychange', schedule);
  }
  return (slot, sync) => {
    if (!slots.size) start();
    slots.set(slot, sync);
    resize.observe(slot);
    schedule();
    return () => {
      slots.delete(slot);
      resize.unobserve(slot);
      if (slots.size) return;
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('load', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      if (animation !== null) cancelAnimationFrame(animation);
      watchSlots = null;
    };
  };
}

function nativeBrowser() {
  if (typeof window === 'undefined' || window.vibeNative?.inlineWeb !== true) return undefined;
  return window.vibeNative.projects;
}

export default function LessonWebPage({url, title, language, showOpenOriginal = true, annotations}: {
  url: string;
  title?: string;
  language: Language;
  showOpenOriginal?: boolean;
  annotations?: WebAnnotations;
}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const address = safeLink(url);
  const native = nativeBrowser();
  const desktop = typeof window === 'undefined' ? undefined : window.vibeNative?.projects;
  const canAnnotate = !!(native && annotations && window.vibeNative?.inlineWebNotes === true);
  const slot = useRef<HTMLDivElement>(null);
  const session = useRef<{beginNote: () => void; syncNotes: () => void} | null>(null);
  const [state, setState] = useState<WebPageState>('loading');
  const [attempt, setAttempt] = useState(0);
  const [noteHint, setNoteHint] = useState(false);
  const [noteVersion, setNoteVersion] = useState(0);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const records = annotations?.records;
  const notes = useMemo(() => canAnnotate && records ? webNotes(records) : [], [canAnnotate, records]);
  const noteProps = useRef({annotations, language, notes});
  noteProps.current = {annotations, language, notes};

  useEffect(() => {
    const element = slot.current;
    if (!element || !native || !address) return;
    const bridge = native;
    const id = crypto.randomUUID();
    let active = true;
    let lastVisible: Geometry | undefined;
    let lastUpdate = '';
    let rejected = false;
    let registered = false;
    let savingNote = false;
    let lastNotes = '';
    setState('loading');
    setNoteHint(false);

    function onState(event: Event) {
      const value = (event as CustomEvent).detail;
      if (value?.id === id && ['loading', 'ready', 'failed'].includes(value.state)) setState(value.state);
    }
    function syncNotes() {
      if (!active || !registered || rejected || !canAnnotate || savingNote) return;
      const {language, notes} = noteProps.current;
      const key = JSON.stringify({language, notes});
      if (key === lastNotes) return;
      lastNotes = key;
      void bridge.request('browser.inline.notes', {id, language, notes}).catch(() => {
        if (lastNotes === key) lastNotes = '';
      });
    }
    async function onNote(event: Event) {
      const request = readWebNoteRequest((event as CustomEvent).detail, id);
      const commit = noteProps.current.annotations?.commit;
      if (!request || !commit || !active || rejected || savingNote) return;
      savingNote = true;
      setNoteHint(false);
      try {
        const ok = await commit(request.action, request.note).catch(() => false);
        if (active) await bridge.request('browser.inline.note.resolve', {id, requestId: request.requestId, ok});
      } catch {
        // An unmounted native card no longer has a pending editor to acknowledge.
      } finally {
        savingNote = false;
        if (active) setNoteVersion(value => value + 1);
      }
    }
    const page = {
      syncNotes,
      beginNote() {
        if (!registered || rejected || savingNote) return;
        void bridge.request('browser.inline.note.begin', {id})
          .then(result => {if (active) setNoteHint(result === false);})
          .catch(() => {if (active) setNoteHint(true);});
      },
    };
    session.current = page;
    window.addEventListener(stateEvent, onState);
    if (canAnnotate) window.addEventListener(noteEvent, onNote);
    const unwatch = watchSlot(element, () => {
      if (!active || rejected || !element.isConnected) return;
      const geometry = readGeometry(element);
      if (geometry.clip.width > 0) lastVisible = geometry;
      else if (!lastVisible) return; // Defer creating the native view until it can be read.
      else geometry.frame = lastVisible.frame;
      const key = JSON.stringify(geometry);
      if (lastUpdate === key) return;
      lastUpdate = key;
      void native.request('browser.inline.update', {id, url: address, ...geometry}).then(result => {
        if (result === false) throw new Error('BROWSER_INLINE_UNAVAILABLE');
        registered = true;
        syncNotes();
      }).catch(() => {
        if (!active) return;
        rejected = true;
        setState('failed');
        void native.request('browser.inline.remove', {id}).catch(() => {});
      });
    });
    return () => {
      active = false;
      if (session.current === page) session.current = null;
      window.removeEventListener(stateEvent, onState);
      if (canAnnotate) window.removeEventListener(noteEvent, onNote);
      unwatch();
      if (lastVisible) void native.request('browser.inline.remove', {id}).catch(() => {});
    };
  }, [address, attempt, canAnnotate, native]);

  useEffect(() => {session.current?.syncNotes();}, [language, notes, noteVersion]);

  if (!address) return <p className="notebook-muted">{t('网页地址不可用。', 'This web address is unavailable.')}</p>;
  const original = (
    <>
      <a className="notebook-inline-action notebook-web-original" href={address} target="_blank" rel="noreferrer" title={address}
        onClick={desktop ? event => {
          event.preventDefault();
          setOriginalError(null);
          void desktop.request('browser.openExternal', {url: address}).then(result => {
            if (result === false) setOriginalError(address);
          }).catch(() => setOriginalError(address));
        } : undefined}>
        <ExternalLink aria-hidden="true" />
        {showOpenOriginal ? t('打开原件', 'Open original') : address}
      </a>
      {originalError === address && <p className="notebook-muted" role="status">{t('暂时无法打开外部浏览器。', 'Could not open the external browser.')}</p>}
    </>
  );
  if (!native) return original;
  return <section className="notebook-web-page" aria-label={title || t('网页资料', 'Web resource')}>
    <div className="notebook-web-slot" ref={slot} data-state={state} aria-busy={state === 'loading'}>
      {state === 'loading' && <p className="notebook-loading" role="status"><LoaderCircle aria-hidden="true" />{t('正在加载网页…', 'Loading page…')}</p>}
      {state === 'failed' && <div className="notebook-web-failure">
        <p className="notebook-muted" role="status">{t('暂时无法在此显示网页。', 'This page cannot be displayed here.')}</p>
        <button type="button" className="notebook-inline-action" onClick={() => {setState('loading'); setAttempt(value => value + 1);}}>
          <RotateCw aria-hidden="true" />{t('重试', 'Try again')}
        </button>
      </div>}
    </div>
    {canAnnotate && state === 'ready' && <div className="notebook-web-note-tools">
      <button type="button" className="notebook-inline-action" onClick={() => session.current?.beginNote()}>
        <StickyNote aria-hidden="true" />{t('网页笔记', 'Page note')}
      </button>
      {noteHint && <small role="status">{t('先选中网页里的文字。', 'Select text on the page first.')}</small>}
    </div>}
    {showOpenOriginal && original}
  </section>;
}
