import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft, ArrowRight, Check, Clock3, LockKeyhole, MapPin, Pencil, SkipForward, X} from 'lucide-react';
import type {RouteChapter, RouteDocument, RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {isRequiredLesson, learningPrerequisiteIds, learningProgressSummary} from '../../../../packages/domain/route-learning.mjs';
import {createRouteMapPages, HEIGHT, pawPlacement, WIDTH, type MapNode} from '../../../../packages/map-layout/index.mjs';
import {translate, type Language} from '../i18n';
import BackHomeButton from './BackHomeButton';
import GameButton, {GameButtonArt} from './GameButton';
import GameSelect from './GameSelect';
import {projectMapPage, type MapViewport} from './adventure-map-viewport';
import {FinishFlagArt, LandmarkArt, mapAsset, PawArt, terrainName, TerrainTrail, type MapTerrain} from './adventure-map-art';
import './adventure-map.css';

type Props = {
  route: RouteDocument;
  language: Language;
  onStartLesson: (nodeId: string) => void;
  startPending?: boolean;
  startError?: string;
  onEdit: () => void;
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

export function SkipLessonConfirmation({language, saving, failed, canSkip, onConfirm, onCancel}: {
  language: Language; saving: boolean; failed: boolean; canSkip: boolean;
  onConfirm: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void;
}) {
  const prompt = useRef<HTMLParagraphElement>(null);
  useEffect(() => prompt.current?.focus({preventScroll: true}), []);
  return <form className="adventure-card-skip-form" onSubmit={onConfirm}>
    <p ref={prompt} tabIndex={-1}>{translate(language, '确定跳过本节吗？', 'Skip this lesson?')}</p>
    {failed && <p className="adventure-card-skip-error" role="alert">{translate(language, '保存失败，请重试。', 'Could not save. Try again.')}</p>}
    <div className="adventure-card-actions">
      <GameButton variant="secondary" disabled={saving} onClick={onCancel}>{translate(language, '取消', 'Cancel')}</GameButton>
      <GameButton type="submit" disabled={saving || !canSkip}>{saving ? translate(language, '保存中…', 'Saving…') : translate(language, '确认跳过', 'Confirm skip')}</GameButton>
    </div>
  </form>;
}

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
  const skipSaving = useRef(false);
  const close = useRef(onClose);
  const [placement, setPlacement] = useState<Placement>();
  const [skipMode, setSkipMode] = useState<'view' | 'confirm' | 'saving'>('view');
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

  function dismissSkip() {
    setSkipMode('view');
    setSkipFailed(false);
    heading.current?.focus({preventScroll: true});
  }

  async function confirmSkip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lesson || !onSkip || !canSkip || skipSaving.current) return;
    skipSaving.current = true;
    setSkipMode('saving');
    setSkipFailed(false);
    let saved = false;
    try { saved = await onSkip(lesson.id, ''); }
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

  const chapterProgress = learningProgressSummary(chapter.nodes, completed);
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
          {skipMode !== 'view' ? <SkipLessonConfirmation language={language} saving={skipMode === 'saving'} failed={skipFailed} canSkip={canSkip} onConfirm={confirmSkip} onCancel={dismissSkip}/> : lesson ? <>
            <p className="adventure-card-meta"><Clock3 size={16} aria-hidden="true"/>{translate(language, `${lesson.estimatedMinutes} 分钟`, `${lesson.estimatedMinutes} min`)}
              <span className="adventure-card-state">{isRequiredLesson(lesson)?translate(language, '必学', 'Required'):translate(language, '选学', 'Elective')}</span>
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
            <p className="adventure-card-meta"><Check size={16} aria-hidden="true"/>{chapterProgress.optionalOnly ? translate(language, `选学 ${chapterProgress.completed} / ${chapterProgress.total} 节已完成`, `${chapterProgress.completed} / ${chapterProgress.total} elective lessons completed`) : translate(language, `必学 ${chapterProgress.completed} / ${chapterProgress.total} 节已完成`, `${chapterProgress.completed} / ${chapterProgress.total} required lessons completed`)}</p>
          </>}
        </div>
        {lesson && skipMode === 'view' && <div className="adventure-card-actions">
            {canSkip && <GameButton variant="secondary" disabled={startPending} onClick={() => setSkipMode('confirm')}>{translate(language, '跳过本节', 'Skip lesson')}</GameButton>}
            <GameButton className="adventure-card-start" disabled={!canStart || startPending} onClick={() => onStart(lesson.id)}>
              {startPending ? translate(language, '正在开始…', 'Starting…') : status === 'skipped' ? translate(language, '补学本节', 'Study lesson') : translate(language, '开始学习', 'Start learning')}
            </GameButton>
        </div>}
      </div>
    </section>,
    document.body,
  );
}

export function AdventureMap({route, language, onStartLesson, startPending=false, startError, onEdit, onBack, initialNodeId, currentNodeId, completedNodeIds = EMPTY, skippedReasons = NO_SKIPS, onSkipLesson}: Props) {
  const {lessons, chapters} = useMemo(() => ({
    lessons: new Map(route.chapters.flatMap(chapter => chapter.nodes.map(node => [node.id, {chapter, node}] as const))),
    chapters: new Map(route.chapters.map(chapter => [chapter.id, chapter] as const)),
  }), [route.chapters]);
  const pages = useMemo(() => createRouteMapPages(route), [route]);
  const handled = (id: string) => completedNodeIds.has(id) || skippedReasons.has(id);
  const dependencies = useMemo(() => new Map([...lessons.values()].map(({node}) => [node.id, learningPrerequisiteIds(route, node.id)])), [route, lessons]);
  const isNext = (node: RouteNode) => !handled(node.id) && (dependencies.get(node.id) ?? []).every(handled);
  const current = currentNodeId ? lessons.get(currentNodeId)?.node : undefined;
  const available = Array.from(lessons.values()).filter(({node}) => isNext(node));
  const suggested = current && isNext(current) ? current.id : (available.find(({node}) => isRequiredLesson(node)) ?? available[0])?.node.id;
  const initialLesson = initialNodeId ?? suggested;
  const startingIndex = initialLesson ? Math.max(0, pages.findIndex(page => page.lessonIds.includes(initialLesson))) : 0;
  const [pageChoice, setPageChoice] = useState<number>();
  const [selection, setSelection] = useState<Selection>();
  const [startingLessonId,setStartingLessonId]=useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const pagination = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState<MapViewport>({width: WIDTH, height: HEIGHT, top: 128, bottom: 96});
  useLayoutEffect(() => {
    const element = board.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = {width: rect.width, height: rect.height,
        top: Math.max(0, (header.current?.getBoundingClientRect().bottom ?? rect.top) - rect.top) + 14,
        bottom: Math.max(0, rect.bottom - (pagination.current?.getBoundingClientRect().top ?? rect.bottom)) + 18};
      setViewport(previous => Object.keys(next).every(key => previous[key as keyof MapViewport] === next[key as keyof MapViewport]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (header.current) observer.observe(header.current);
    if (pagination.current) observer.observe(pagination.current);
    return () => observer.disconnect();
  }, [pages.length]);
  const pageIndex = Math.min(pageChoice ?? startingIndex, Math.max(0, pages.length - 1));
  const projected = useMemo(() => pages[pageIndex] ? projectMapPage(pages[pageIndex], viewport, pages[pageIndex - 1]) : undefined, [pages, pageIndex, viewport]);
  const page = projected?.page;
  const markers = useMemo(() => page?.nodes.map(node => ({node, placement: pawPlacement(page, node)})) ?? [], [page]);
  const terrain = page?.themeId ?? 'grassland';
  const progress = learningProgressSummary([...lessons.values()].map(({node}) => node), completedNodeIds);
  const selectedLesson = selection?.node.kind === 'lesson' ? lessons.get(selection.node.id) : undefined;
  const selectedChapter = selectedLesson?.chapter ?? (selection?.node.kind === 'chapter' ? chapters.get(selection.node.id) : undefined);
  const unmet = (lesson: RouteNode) => (dependencies.get(lesson.id) ?? []).flatMap(id => {
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
    <header ref={header} className="adventure-map-header">
      <BackHomeButton language={language} onClick={onBack} disabled={startPending}/>
      <div className="adventure-map-heading">
        <GameButtonArt variant="secondary"/>
        <h1 title={route.title}>{route.title}</h1>
        <div className="adventure-map-progress">
          <span>{progress.optionalOnly ? translate(language, '选学进度', 'Elective progress') : translate(language, '必学进度', 'Required progress')}</span>
          <progress max={Math.max(1, progress.total)} value={progress.completed} aria-label={progress.optionalOnly ? translate(language, '选学进度', 'Elective progress') : translate(language, '必学进度', 'Required progress')}/>
          <span>{progress.completed} / {progress.total}</span>
        </div>
      </div>
      <div className="adventure-map-actions">
        <GameButton variant="secondary" leadingIcon={<Pencil/>} onClick={onEdit} disabled={startPending}>{translate(language, '编辑路线', 'Edit route')}</GameButton>
      </div>
    </header>
    {page ? <>
      <div className="adventure-board-scroller" ref={scroller}>
        <div ref={board} className="adventure-board" role="region" aria-label={terrainName(terrain, language)}>
          <img className="adventure-background" src={mapAsset(`${terrain}-background`)} alt="" draggable={false}/>
          <TerrainTrail page={page} height={projected!.height}/>
          {markers.map(({node, placement}) => {
            const lesson = node.kind === 'lesson' ? lessons.get(node.id)?.node : undefined;
            const chapter = node.kind === 'chapter' ? chapters.get(node.id) : undefined;
            if (!lesson && !chapter) return null;
            const state = lesson && status(lesson);
            const label = state && translate(language, statusLabels[state][0], statusLabels[state][1]);
            const chapterTitle = translate(language, `第${node.chapter}章`, `Chapter ${node.chapter}`);
            const style = {
              left: `${placement.left / WIDTH * 100}%`,
              top: `${placement.top / projected!.height * 100}%`,
              width: `${node.width / WIDTH * 100}%`,
              height: `${node.height / projected!.height * 100}%`,
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
                : <PawArt terrain={terrain} placement={placement} gold={state === 'complete' || state === 'skipped'}/>}
              {state && state !== 'ready' && <span className="adventure-marker-badge" aria-hidden="true">
                {state === 'complete' ? <Check/> : state === 'skipped' ? <SkipForward/> : state === 'locked' ? <LockKeyhole/> : <MapPin/>}
              </span>}
            </button>;
          })}
          {page.finish && <span className="adventure-finish-flag" role="img" aria-label={translate(language, '路线终点', 'End of route')}
            style={{left: `${(page.finish.x - page.finish.width / 2) / WIDTH * 100}%`,
              top: `${(page.finish.y - page.finish.height) / projected!.height * 100}%`,
              width: `${page.finish.width / WIDTH * 100}%`, height: `${page.finish.height / projected!.height * 100}%`,
              zIndex: Math.round(page.finish.y)}}>
            <FinishFlagArt/>
          </span>}
        </div>
      </div>
      <nav ref={pagination} className="adventure-map-pages" aria-label={translate(language, '地图分页', 'Map pages')}>
        <GameButton variant="secondary" leadingIcon={<ArrowLeft/>} disabled={startPending || pageIndex === 0} onClick={() => changePage(pageIndex - 1)}>{translate(language, '上一页', 'Previous page')}</GameButton>
        <GameSelect className="adventure-map-page-select" menuClassName="adventure-map-page-options"
          aria-label={translate(language, '跳转到指定页', 'Go to page')}
          valueLabel={translate(language, `第${pageIndex + 1}页`, `Page ${pageIndex + 1}`)}
          disabled={startPending} value={String(pageIndex)} onChange={value => changePage(Number(value))}
          options={pages.map(item => ({value: String(item.pageIndex), label: String(item.pageNumber)}))}/>
        <GameButton variant="secondary" leadingIcon={<ArrowRight/>} disabled={startPending || pageIndex >= pages.length - 1} onClick={() => changePage(pageIndex + 1)}>{translate(language, '下一页', 'Next page')}</GameButton>
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
