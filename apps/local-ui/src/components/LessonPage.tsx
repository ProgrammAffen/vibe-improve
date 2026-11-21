import {lazy, Suspense, useEffect, useRef} from 'react';
import {ArrowLeft, Clock3} from 'lucide-react';
import type {RouteChapter, RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {translate, type Language} from '../i18n';
import BackHomeButton from './BackHomeButton';
import GameButton from './GameButton';
import LegacyLessonContent from './LegacyLessonContent';
import './lesson-page.css';

const NotebookLesson = lazy(() => import('./NotebookLesson'));

export type LessonPageProps = {
  chapter: RouteChapter;
  node: RouteNode;
  language: Language;
  projectId?: string;
  routeId?: string;
  completed: boolean;
  busy: boolean;
  error: string;
  onComplete: () => void | Promise<void>;
  onMap: () => void;
  onHome: () => void;
};

function LegacyLesson({chapter, node, language, error, onMap, onHome}: LessonPageProps) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), [node.id]);
  const t = (zh: string, en: string) => translate(language, zh, en);
  return <section className="lesson-page">
    <nav className="lesson-navigation" aria-label={t('课程导航', 'Lesson navigation')}>
      <BackHomeButton language={language} onClick={onHome}/>
      <GameButton variant="secondary" leadingIcon={<ArrowLeft/>} onClick={onMap}>{t('返回地图', 'Back to map')}</GameButton>
    </nav>
    <article className="lesson-sheet">
      <header><p className="lesson-chapter">{chapter.title}</p><h1 ref={title} tabIndex={-1}>{node.title}</h1>
        <span className="lesson-duration"><Clock3 aria-hidden="true"/>{t(`${node.estimatedMinutes} 分钟`, `${node.estimatedMinutes} min`)}</span>
        <span className="lesson-requirement">{node.requirement === 'optional' ? t('选学', 'Elective') : t('必学', 'Required')}</span>
      </header>
      <section><h2>{t('学习目标', 'Learning goals')}</h2><ul>{node.objectives.map(objective => <li key={objective.id}>{objective.description}</li>)}</ul></section>
      {!!node.activities?.length && <section><h2>{t('学习活动', 'Learning activities')}</h2><ol>{node.activities.map((activity, index) => <li key={index}>{activity}</li>)}</ol></section>}
      <LegacyLessonContent node={node} language={language}/>
      {error && <p role="alert" className="lesson-error">{error}</p>}
    </article>
  </section>;
}

export default function LessonPage(props: LessonPageProps) {
  if (!props.projectId || !props.routeId) return <LegacyLesson {...props}/>;
  return <Suspense fallback={<section className="lesson-page"><p role="status">{translate(props.language, '正在打开小节…', 'Opening lesson…')}</p></section>}>
    <NotebookLesson {...props} projectId={props.projectId} routeId={props.routeId}/>
  </Suspense>;
}
