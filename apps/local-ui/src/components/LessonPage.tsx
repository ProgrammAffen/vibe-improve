import {ArrowLeft, Check, Clock3} from 'lucide-react';
import {useEffect, useRef} from 'react';
import type {RouteChapter, RouteNode} from '../../../../packages/domain/route-validation.mjs';
import {translate, type Language} from '../i18n';
import BackHomeButton from './BackHomeButton';
import GameButton from './GameButton';
import {LessonBackpack} from './ResourceAttachments';
import './lesson-page.css';

type Props = {
  chapter: RouteChapter;
  node: RouteNode;
  language: Language;
  projectId?: string;
  routeId?: string;
  completed: boolean;
  busy: boolean;
  error: string;
  onComplete: () => void;
  onMap: () => void;
  onHome: () => void;
};

export default function LessonPage({chapter, node, language, projectId, routeId, completed, busy, error, onComplete, onMap, onHome}: Props) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), [node.id]);

  return <section className="lesson-page">
    <nav className="lesson-navigation" aria-label={t('课程导航', 'Lesson navigation')}>
      <BackHomeButton language={language} onClick={onHome}/>
      <GameButton variant="secondary" leadingIcon={<ArrowLeft/>} onClick={onMap}>{t('返回地图', 'Back to map')}</GameButton>
    </nav>
    <article className="lesson-sheet">
      <header>
        <p className="lesson-chapter">{chapter.title}</p>
        <h1 ref={title} tabIndex={-1}>{node.title}</h1>
        <span className="lesson-duration"><Clock3 aria-hidden="true"/>{t(`${node.estimatedMinutes} 分钟`, `${node.estimatedMinutes} min`)}</span>
      </header>
      <section>
        <h2>{t('学习目标', 'Learning goals')}</h2>
        <ul>{node.objectives.map(objective => <li key={objective.id}>{objective.description}</li>)}</ul>
      </section>
      {projectId && routeId && <LessonBackpack projectId={projectId} scope={{routeId, nodeId: node.id}} chapterId={chapter.id} language={language}/>}
      {!!node.activities?.length && <section>
        <h2>{t('学习活动', 'Learning activities')}</h2>
        <ol>{node.activities.map((activity, index) => <li key={index}>{activity}</li>)}</ol>
      </section>}
      {node.assessment && <section>
        <h2>{t('验收标准', 'Completion criteria')}</h2>
        <p>{node.assessment.task}</p>
        <ul>{node.assessment.passCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      </section>}
      <footer>
        {error && <p role="alert" className="lesson-error">{error}</p>}
        {completed
          ? <span className="lesson-complete" role="status"><Check aria-hidden="true"/>{t('已自评完成', 'Self-assessed complete')}</span>
          : <GameButton disabled={busy} onClick={onComplete}>{busy ? t('保存中…', 'Saving…') : t('自评完成', 'Mark complete')}</GameButton>}
      </footer>
    </article>
  </section>;
}
