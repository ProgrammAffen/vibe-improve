import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft, ArrowRight, Check, ChevronDown, Clock3, LockKeyhole, MapPin, Pencil, SkipForward, X} from 'lucide-react';
import type {RouteChapter, RouteDocument, RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {createRouteMapPages, HEIGHT, pawPlacement, WIDTH, type MapNode} from '../../../../packages/map-layout/index.mjs';
import {translate, type Language} from '../i18n';
import {MAX_SKIP_REASON_LENGTH} from '../routes/learning';
import BackHomeButton from './BackHomeButton';
import GameButton from './GameButton';
import {LandmarkArt, mapAsset, PawArt, terrainName, TerrainTrail, type MapTerrain} from './adventure-map-art';
import './adventure-map.css';

type Props = {
  route: RouteDocument;
  language: Language;
  onStartLesson: (nodeId: string) => void;
  startPending?: boolean;
  startError?: string;
  onEdit: () => void;
  onResetLearning?: () => void;
  onBack: () => void;
  initialNodeId?: string;
  currentNodeId?: string;
  completedNodeIds?: ReadonlySet<string>;
  skippedReasons?: ReadonlyMap<string, string>;
  onSkipLesson?: (nodeId: string, reason: string) => Promise<boolean>;
};

type Lesson = {chapter: RouteChapter; node: RouteNode};
type Status = 'complete' | 'locked' | 'current' | 'ready' | 'skipped';
type Selection = {anchor: HTMLButtonElement; node: MapNode};
type Placement = {x: number; y: number; point: number; side: 'left' | 'right' | 'above' | 'below'};
const EMPTY = new Set<string>();
const NO_SKIPS = new Map<string, string>();

function locateCard(anchor: DOMRect, card: DOMRect): Placement {
  const margin = 10;
  const gap = 12;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const boundedX = (x: number) => Math.max(margin, Math.min(x, viewportWidth - card.width - margin));
  const boundedY = (y: number) => Math.max(margin, Math.min(y, viewportHeight - card.height - margin));
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  const below = viewportHeight - anchor.bottom;
  const right = viewportWidth - anchor.right;
  const sideSpace = card.width + gap + margin;
  const y = boundedY(centerY - card.height / 2);

  if (right >= sideSpace) return {x: anchor.right + gap, y, point: centerY - y, side: 'right'};
  if (anchor.left >= sideSpace) return {x: anchor.left - card.width - gap, y, point: centerY - y, side: 'left'};

  const x = boundedX(centerX - card.width / 2);
  const opensBelow = below >= anchor.top;
  return {x, y: boundedY(opensBelow ? anchor.bottom + gap : anchor.top - card.height - gap), point: centerX - x, side: opensBelow ? 'below' : 'above'};
}

function LandmarkCard({selection, chapter, lesson, unmet, status, completed, skippedReason, terrain, language, startPending, startError, onStart, onSkip, onClose}: {
  selection: Selection;
  chapter: RouteChapter;
  lesson?: RouteNode;
  unmet: Lesson[];
  status?: Status;
  completed: ReadonlySet<string>;
  skippedReason?: string;
  terrain: MapTerrain;
  language: Language;
  startPending?: boolean;
  startError?: string;
  onStart: (nodeId: string) => void;
  onSkip?: Props['onSkipLesson'];
  onClose: (restoreFocus?: boolean) => void;
}) {
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const skipSaving = useRef(false);
  const close = useRef(onClose);
  const formId = useId();
  const [placement, setPlacement] = useState<Placement>();
  const [skipMode, setSkipMode] = useState<'view' | 'confirm' | 'saving'>('view');
  const [reason, setReason] = useState('');
  const [skipFailed, setSkipFailed] = useState(false);
  const canSkip = !!onSkip && (status === 'current' || status === 'ready');
  const canStart = status === 'complete' || unmet.length === 0;
  close.current = onClose;
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const position = () => {
      if (!selection.anchor.isConnected) return;
      const anchor = selection.anchor.getBoundingClientRect();
      setPlacement(locateCard(anchor, element.getBoundingClientRect()));
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    observer.observe(selection.anchor);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [selection]);

  const positioned = Boolean(placement);
  useEffect(() => { if (positioned) heading.current?.focus({preventScroll: true}); }, [positioned]);
  useEffect(() => { if (skipMode === 'confirm') reasonInput.current?.focus(); }, [skipMode]);

  function dismissSkip() {
    setSkipMode('view');
    setReason('');
    setSkipFailed(false);
    heading.current?.focus({preventScroll: true});
  }

  async function confirmSkip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!lesson || !onSkip || !canSkip || !trimmed || skipSaving.current) return;
    skipSaving.current = true;
    setSkipMode('saving');
    setSkipFailed(false);
    let saved = false;
    try { saved = await onSkip(lesson.id, trimmed); }
    catch { saved = false; }
    finally { skipSaving.current = false; }
    if (saved) dismissSkip();
    else {
      setSkipFailed(true);
      setSkipMode('confirm');
    }
  }

  useEffect(() => {
    function handlePointer(event: PointerEvent) {
      if (skipSaving.current || startPending) return;
      if (event.target instanceof Element && !card.current?.contains(event.target) && !event.target.closest('.adventure-marker')) close.current(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (skipSaving.current || startPending) return;
        if (skipMode === 'confirm') dismissSkip();
        else close.current(true);
      }
    }
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [skipMode, startPending]);

  const count = chapter.nodes.filter(node => completed.has(node.id)).length;
  const style = {
    left: placement?.x,
    top: placement?.y,
    visibility: placement ? 'visible' : 'hidden',
    '--adventure-card-point': `${placement?.point ?? 0}px`,
  } as CSSProperties;
  return createPortal(
    <section ref={card} className="adventure-card" data-map-terrain={terrain} data-side={placement?.side} style={style}
      role="dialog" aria-labelledby="adventure-card-title" aria-busy={skipMode === 'saving' || startPending || undefined}>
      <div className="adventure-card-content">
        <header>
          <div>
            {lesson && <p className="adventure-card-chapter">{chapter.title}</p>}
            <h2 ref={heading} id="adventure-card-title" tabIndex={-1}>{lesson?.title ?? chapter.title}</h2>
          </div>
          <button className="adventure-card-close" aria-label={translate(language, '关闭', 'Close')} disabled={skipMode === 'saving' || startPending} onClick={() => onClose(true)}><X size={21}/></button>
        </header>
        <div className="adventure-card-details" tabIndex={0}>
          {skipMode !== 'view' ? <form className="adventure-card-skip-form" id={formId} onSubmit={confirmSkip}>
            <p id={formId + '-hint'}>{translate(language, '跳过会满足后续小节对本节的前置要求。补学并完成后计入进度。', 'Skipping satisfies this prerequisite. This lesson counts toward progress once completed.')}</p>
            <label htmlFor={formId + '-reason'}>{translate(language, '跳过原因', 'Reason for skipping')}</label>
            <textarea ref={reasonInput} id={formId + '-reason'} aria-describedby={formId + '-hint'} value={reason}
              onChange={event => setReason(event.target.value)} rows={2} maxLength={MAX_SKIP_REASON_LENGTH} required disabled={skipMode === 'saving'}/>
            {skipFailed && <p className="adventure-card-skip-error" role="alert">{translate(language, '保存失败，请重试。', 'Could not save. Try again.')}</p>}
          </form> : lesson ? <>
            <p className="adventure-card-meta"><Clock3 size={16} aria-hidden="true"/>{translate(language, `${lesson.estimatedMinutes} 分钟`, `${lesson.estimatedMinutes} min`)}
              {status === 'complete' && <span className="adventure-card-state"><Check size={16} aria-hidden="true"/>{translate(language, '已完成', 'Completed')}</span>}
              {status === 'locked' && <span className="adventure-card-state"><LockKeyhole size={14} aria-hidden="true"/>{translate(language, '未解锁', 'Locked')}</span>}
              {status === 'skipped' && <span className="adventure-card-state adventure-card-skipped" role="status"><SkipForward size={16} aria-hidden="true"/>{translate(language, '已跳过', 'Skipped')}</span>}
            </p>
            {status === 'skipped' && skippedReason && <div className="adventure-card-objectives adventure-card-skip-reason">
              <h3>{translate(language, '跳过原因', 'Reason for skipping')}</h3>
              <p>{skippedReason}</p>
            </div>}
            {lesson.objectives.length > 0 && <div className="adventure-card-objectives">
              <h3>{translate(language, '学习目标', 'Learning objectives')}</h3>
              <ul>{lesson.objectives.map(item => <li key={item.id}>{item.description}</li>)}</ul>
            </div>}
            {!canStart && <div className="adventure-card-objectives">
              <h3>{translate(language, '前置小节待处理', 'Pending prerequisites')}</h3>
              <ul>{unmet.map(item => <li key={item.node.id}>{item.node.title}</li>)}</ul>
            </div>}
            {startError&&<p className="adventure-card-skip-error" role="alert">{startError}</p>}
          </> : <>
            {chapter.stageGoal && <p className="adventure-card-goal">{chapter.stageGoal}</p>}
            <p className="adventure-card-meta"><Check size={16} aria-hidden="true"/>{translate(language, `${count} / ${chapter.nodes.length} 节已完成`, `${count} / ${chapter.nodes.length} lessons completed`)}</p>
          </>}
        </div>
        {lesson && <div className="adventure-card-actions">
          {skipMode === 'view' ? <>
            {canSkip && <GameButton variant="secondary" disabled={startPending} onClick={() => setSkipMode('confirm')}>{translate(language, '跳过本节', 'Skip lesson')}</GameButton>}
            <GameButton className="adventure-card-start" disabled={!canStart || startPending} onClick={() => onStart(lesson.id)}>
              {startPending ? translate(language, '正在开始…', 'Starting…') : status === 'skipped' ? translate(language, '补学本节', 'Study lesson') : translate(language, '开始学习', 'Start learning')}
            </GameButton>
          </> : <>
            <GameButton variant="secondary" disabled={skipMode === 'saving'} onClick={dismissSkip}>{translate(language, '取消', 'Cancel')}</GameButton>
            <GameButton type="submit" form={formId} disabled={skipMode === 'saving' || !reason.trim() || !canSkip}>
              {skipMode === 'saving' ? translate(language, '保存中…', 'Saving…') : translate(language, '确认跳过', 'Confirm skip')}
            </GameButton>
          </>}
        </div>}
      </div>
    </section>,
    document.body,
  );
}

export function AdventureMap({route, language, onStartLesson, startPending=false, startError, onEdit, onResetLearning, onBack, initialNodeId, currentNodeId, completedNodeIds = EMPTY, skippedReasons = NO_SKIPS, onSkipLesson}: Props) {
  const {lessons, chapters} = useMemo(() => ({
    lessons: new Map(route.chapters.flatMap(chapter => chapter.nodes.map(node => [node.id, {chapter, node}] as const))),
    chapters: new Map(route.chapters.map(chapter => [chapter.id, chapter] as const)),
  }), [route.chapters]);
  const pages = useMemo(() => createRouteMapPages(route), [route]);
  const handled = (id: string) => completedNodeIds.has(id) || skippedReasons.has(id);
  const isNext = (node: RouteNode) => !handled(node.id) && node.prerequisites.every(handled);
  const current = currentNodeId ? lessons.get(currentNodeId)?.node : undefined;
  const suggested = current && isNext(current) ? current.id : Array.from(lessons.values()).find(({node}) => isNext(node))?.node.id;
  const initialLesson = initialNodeId ?? suggested;
  const startingIndex = initialLesson ? Math.max(0, pages.findIndex(page => page.lessonIds.includes(initialLesson))) : 0;
  const [pageChoice, setPageChoice] = useState<number>();
  const [selection, setSelection] = useState<Selection>();
  const [startingLessonId,setStartingLessonId]=useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const pageIndex = Math.min(pageChoice ?? startingIndex, Math.max(0, pages.length - 1));
  const page = pages[pageIndex];
  const markers = useMemo(() => page?.nodes.map(node => ({node, placement: pawPlacement(page, node)})) ?? [], [page]);
  const terrain = page?.themeId ?? 'grassland';
  const lastChapter = page?.continuesToNextPage ? page.nodes.at(-1)?.chapter : undefined;
  const totalCompleted = Array.from(completedNodeIds).filter(id => lessons.has(id)).length;
  const selectedLesson = selection?.node.kind === 'lesson' ? lessons.get(selection.node.id) : undefined;
  const selectedChapter = selectedLesson?.chapter ?? (selection?.node.kind === 'chapter' ? chapters.get(selection.node.id) : undefined);
  const unmet = (lesson: RouteNode) => lesson.prerequisites.flatMap(id => {
    const prerequisite = lessons.get(id);
    return prerequisite && !handled(id) ? [prerequisite] : [];
  });
  const status = (lesson: RouteNode): Status => {
    if (completedNodeIds.has(lesson.id)) return 'complete';
    if (skippedReasons.has(lesson.id)) return 'skipped';
    if (unmet(lesson).length) return 'locked';
    return lesson.id === suggested ? 'current' : 'ready';
  };
  const statusLabels = {complete: ['已完成', 'Completed'], locked: ['未解锁', 'Locked'], current: ['当前小节', 'Current lesson'], ready: ['可学习', 'Available'], skipped: ['已跳过', 'Skipped']} as const;
  function changePage(index: number) {
    setSelection(undefined);
    setPageChoice(index);
    scroller.current?.scrollTo({top: 0, left: 0});
  }
  function closeCard(restoreFocus = false) {
    if (restoreFocus) selection?.anchor.focus({preventScroll: true});
    setSelection(undefined);
  }

  return <section className="adventure-map" data-map-terrain={terrain}>
    <header className="adventure-map-header">
      <BackHomeButton language={language} onClick={onBack} disabled={startPending}/>
      <div className="adventure-map-heading">
        <h1 title={route.title}>{route.title}</h1>
        <div className="adventure-map-progress">
          <span>{translate(language, '学习进度', 'Progress')}</span>
          <progress max={Math.max(1, lessons.size)} value={totalCompleted} aria-label={translate(language, '学习进度', 'Progress')}/>
          <span>{totalCompleted} / {lessons.size}</span>
        </div>
      </div>
      <div className="adventure-map-actions">
        <GameButton variant="secondary" leadingIcon={<Pencil/>} onClick={onEdit} disabled={startPending}>{translate(language, '编辑路线', 'Edit route')}</GameButton>
        {onResetLearning&&<button type="button" className="text-button adventure-map-reset" onClick={onResetLearning} disabled={startPending}>{translate(language, '清空学习记录并编辑', 'Clear progress & edit')}</button>}
      </div>
    </header>
    {page ? <>
      <div className="adventure-board-scroller" ref={scroller}>
        <div className="adventure-board" role="region" aria-label={terrainName(terrain, language)}>
          <img className="adventure-background" src={mapAsset(`${terrain}-background`)} alt="" draggable={false}/>
          <TerrainTrail page={page}/>
          {markers.map(({node, placement}) => {
            const lesson = node.kind === 'lesson' ? lessons.get(node.id)?.node : undefined;
            const chapter = node.kind === 'chapter' ? chapters.get(node.id) : undefined;
            if (!lesson && !chapter) return null;
            const state = lesson && status(lesson);
            const label = state && translate(language, statusLabels[state][0], statusLabels[state][1]);
            const chapterTitle = translate(language, `第${node.chapter}章`, `Chapter ${node.chapter}`);
            const style = {
              left: `${placement.left / WIDTH * 100}%`,
              top: `${placement.top / HEIGHT * 100}%`,
              width: `${node.width / WIDTH * 100}%`,
              height: `${node.height / HEIGHT * 100}%`,
              zIndex: Math.round(node.y),
            };
            return <button key={node.key} type="button" className="adventure-marker" style={style} disabled={startPending}
              aria-label={lesson ? `${lesson.title} · ${label}` : `${chapterTitle} · ${chapter?.title}`}
              aria-haspopup="dialog" aria-expanded={selection?.node === node} data-kind={node.kind} data-status={state}
              onClick={event => {
                if (selection?.node === node) closeCard();
                else {
                  setPageChoice(pageIndex);
                  setSelection({anchor: event.currentTarget, node});
                }
              }}>
              <span className="adventure-terrain-contact" aria-hidden="true"/>
              {chapter ? <LandmarkArt terrain={terrain} node={node} language={language}/>
                : <PawArt terrain={terrain} placement={placement}/>}
              {state && state !== 'ready' && <span className="adventure-marker-badge" aria-hidden="true">
                {state === 'complete' ? <Check/> : state === 'skipped' ? <SkipForward/> : state === 'locked' ? <LockKeyhole/> : <MapPin/>}
              </span>}
            </button>;
          })}
        </div>
      </div>
      <nav className="adventure-map-pages" aria-label={translate(language, '地图分页', 'Map pages')}>
        <GameButton variant="secondary" leadingIcon={<ArrowLeft/>} disabled={startPending || pageIndex === 0} onClick={() => changePage(pageIndex - 1)}>{translate(language, '上一张地图', 'Previous map')}</GameButton>
        <div className="adventure-map-page-location">
          <label className="adventure-map-page-select">
            <select aria-label={translate(language, '跳转地图', 'Go to map')} disabled={startPending} value={pageIndex} onChange={event => changePage(Number(event.target.value))}>
              {pages.map((item, index) => <option key={index} value={index}>{index + 1} / {pages.length} · {terrainName(item.themeId, language)}</option>)}
            </select>
            <ChevronDown size={15} aria-hidden="true"/>
          </label>
          {page.continuedChapter && <span title={page.continuedChapter.title}>{translate(language,
            `续接第${page.continuedChapter.number}章 · 第${page.continuedChapter.firstLesson}–${page.continuedChapter.lastLesson}节`,
            `Chapter ${page.continuedChapter.number} continued · Lessons ${page.continuedChapter.firstLesson}–${page.continuedChapter.lastLesson}`)}</span>}
          {lastChapter !== undefined && <span>{translate(language,
            `第${lastChapter}章在下一张地图继续`, `Chapter ${lastChapter} continues on the next map`)}</span>}
        </div>
        <GameButton variant="secondary" leadingIcon={<ArrowRight/>} disabled={startPending || pageIndex >= pages.length - 1} onClick={() => changePage(pageIndex + 1)}>{translate(language, '下一张地图', 'Next map')}</GameButton>
      </nav>
    </> : <p className="adventure-map-empty">{translate(language, '暂无学习小节', 'No lessons yet')}</p>}
    {selection && selectedChapter && <LandmarkCard key={selection.node.key} selection={selection} chapter={selectedChapter}
      lesson={selectedLesson?.node} completed={completedNodeIds} unmet={selectedLesson ? unmet(selectedLesson.node) : []}
      skippedReason={selectedLesson && skippedReasons.get(selectedLesson.node.id)} status={selectedLesson && status(selectedLesson.node)}
      terrain={terrain} language={language} startPending={startPending&&selectedLesson?.node.id===startingLessonId}
      startError={selectedLesson?.node.id===startingLessonId?startError:undefined}
      onStart={nodeId=>{setStartingLessonId(nodeId);onStartLesson(nodeId)}} onSkip={onSkipLesson} onClose={closeCard}/>}
  </section>;
}

export default AdventureMap;
