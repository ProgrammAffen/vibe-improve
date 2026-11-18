import {useEffect, useState} from 'react';
import {Backpack, Plus, X} from 'lucide-react';
import type {MaterialLink} from '../../../../packages/domain/planning.mjs';
import {translate, type Language} from '../i18n';
import {
  resourceKey, resourceLocation, resourceMessage, resourceService, useResourceBindings, useResourceList,
  type ResourceItem, type ResourceScope
} from '../resources/service';
import ResourceDialog, {ResourceIcon} from './ResourceDialog';
import GameButton from './GameButton';
import GameSelect from './GameSelect';
import Modal from './Modal';

export type ResourceAttachment = {item: ResourceItem; segmentId?: string; origin?: MaterialLink['origin']; link?: MaterialLink};

export function attachmentsFrom(links: MaterialLink[], items: ResourceItem[]): ResourceAttachment[] {
  const lookup = new Map(items.map(item => [resourceKey(item), item]));
  return links.flatMap(link => {
    const item = lookup.get(resourceKey(link));
    return item ? [{item, segmentId: link.segmentId, origin: link.origin, link}] : [];
  });
}

type AttachmentProps = {
  projectId: string;
  language: Language;
  items: ResourceAttachment[];
  onChoose?: () => void;
  onRemove?: (link: MaterialLink) => void;
  lesson?: boolean;
};
export default function ResourceAttachments({projectId, language, items, onChoose, onRemove, lesson}: AttachmentProps) {
  const [preview, setPreview] = useState<ResourceAttachment>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const t = (zh: string, en: string) => translate(language, zh, en);
  return <section className="resource-attachments">
    <header className="resource-attachments-heading">
      <h2>{lesson && <Backpack aria-hidden="true"/>}{lesson ? t('背包', 'Backpack') : t('章节资料', 'Chapter resources')}</h2>
      {onChoose && <GameButton variant="secondary" leadingIcon={<Plus aria-hidden="true"/>}
        onClick={onChoose}>{t('添加资料', 'Add resources')}</GameButton>}
    </header>
    {items.length ? <ul className="resource-attachment-list">
      {items.map(({item, segmentId, origin, link}) => {
        const location = item.positions?.find(position => position.id === segmentId)?.location;
        const detail = item.removed ? t('资料已移除', 'Resource removed') : resourceLocation(location, language);
        return <li className="resource-attachment-row" key={resourceKey(item) + '/' + (segmentId ?? '')}>
          <ResourceIcon format={item.format}/>
          <div className="resource-name-group"><strong title={item.name}>{item.name}</strong>
            <small>{detail}{!lesson && origin === 'ai' && !item.removed ? ' · ' + t('AI 建议', 'AI suggestion') : ''}</small>
          </div>
          <div className="resource-detail-actions">
            {!item.removed && <button type="button" className="resource-link-button" disabled={opening} aria-label={t('打开 ', 'Open ') + item.name}
              onClick={() => {
                setError('');
                if (item.segmentCount || segmentId) {setPreview({item, segmentId});return;}
                setOpening(true);
                void resourceService.open(projectId, item).catch(cause => setError(resourceMessage(cause, language)))
                  .finally(() => setOpening(false));
              }}>{t('打开', 'Open')}</button>}
            {link && onRemove && <button type="button" className="icon-button" title={t('解除关联', 'Unlink')}
              aria-label={t('解除关联 ', 'Unlink ') + item.name} onClick={() => onRemove(link)}><X aria-hidden="true"/></button>}
          </div>
        </li>;
      })}
    </ul> : <p>{t('暂无资料', 'No resources')}</p>}
    {error && <p className="form-message is-error" role="alert">{error}</p>}
    {preview && <ResourcePreview projectId={projectId} resource={preview} language={language} onClose={() => setPreview(undefined)}/>}
  </section>;
}

function ResourcePreview({projectId, resource, language, onClose}: {
  projectId: string; resource: ResourceAttachment; language: Language; onClose: () => void;
}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [detail, setDetail] = useState<ResourceItem>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void resourceService.detail(projectId, resource.item).then(value => {if (active) setDetail(value);}, cause => {
      if (active) setError(resourceMessage(cause, language));
    });
    return () => {active = false;};
  }, [projectId, resource, language]);
  const segment = (resource.segmentId && detail?.segments?.find(part => part.id === resource.segmentId)) || detail?.segments?.[0];
  return <Modal title={t('查看资料', 'View resource')} className="resource-preview-dialog"
    closeLabel={t('关闭', 'Close')} onClose={onClose} busy={busy}>
    <p className="resource-excerpt-location">{resource.item.name}{segment ? ' · ' + resourceLocation(segment.location, language) : ''}</p>
    {segment && <p className="resource-excerpt-copy">{segment.text}</p>}
    {error && <p className="form-message is-error" role="alert">{error}</p>}
    <div className="confirmation-actions">
      <GameButton disabled={busy} onClick={() => {
        setBusy(true);setError('');
        void resourceService.open(projectId, resource.item, resource.segmentId ?? segment?.id)
          .catch(cause => setError(resourceMessage(cause, language))).finally(() => setBusy(false));
      }}>{t('打开原件', 'Open original')}</GameButton>
    </div>
  </Modal>;
}

export function ResourcePicker({projectId, language, bindings, busy, onAdd, onClose, wholeOnly = false}: {
  projectId: string; language: Language; bindings: MaterialLink[]; busy: boolean;
  onAdd: (item: ResourceItem, segmentId?: string) => Promise<boolean>; onClose: () => void;
  wholeOnly?: boolean;
}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [items, setItems] = useState<ResourceItem[]>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void resourceService.library(projectId).then(value => {if (active) setItems(value);}, cause => {
      if (active) setError(resourceMessage(cause, language));
    });
    return () => {active = false;};
  }, [projectId, language]);
  return <Modal title={t('从项目资料库添加', 'Add from project resources')} className="resource-picker"
    busy={busy} closeLabel={t('关闭', 'Close')} onClose={onClose} focusHeading>
    {error && <p role="alert" className="form-message is-error">{error}</p>}
    {items?.length ? <ul className="resource-picker-list">
      {items.map(item => {
        const key = resourceKey(item), choice = choices[key] ?? '';
        const linked = bindings.some(link => resourceKey(link) === key && (wholeOnly || (link.segmentId ?? '') === choice));
        return <li className="resource-attachment-row" key={key}>
          <ResourceIcon format={item.format}/>
          <span className="resource-name-group"><strong title={item.name}>{item.name}</strong></span>
          <div className="resource-detail-actions">
            {!wholeOnly && Boolean(item.positions?.length) && <GameSelect aria-label={t('关联位置 ', 'Location for ') + item.name} value={choice}
              onChange={value => setChoices(previous => ({...previous, [key]: value}))}
              options={[{value: '', label: t('原件', 'Original')}, ...(item.positions ?? []).map(part => ({value: part.id, label: resourceLocation(part.location, language)}))]}/>}
            <button type="button" className="resource-link-button" disabled={busy || linked} onClick={() => {
              setError('');
              void onAdd(item, choice || undefined).then(saved => {if (saved) onClose();}, cause => setError(resourceMessage(cause, language)));
            }}>{linked ? t('已加入', 'Added') : t('加入', 'Add')}</button>
          </div>
        </li>;
      })}
    </ul> : <p>{items ? t('项目暂无资料，可在小节背包添加。', 'No project resources. Add them in a lesson backpack.')
      : !error && t('正在读取资料…', 'Loading resources…')}</p>}
    <div className="confirmation-actions"><GameButton variant="secondary" disabled={busy} onClick={onClose}>{t('完成', 'Done')}</GameButton></div>
  </Modal>;
}

export function LessonBackpack({projectId, scope, chapterId, language, provided, editor = false, disabled = false, beforeAdd, onRemove}: {
  projectId: string; scope: ResourceScope; chapterId: string; language: Language;
  provided?: ResourceAttachment[]; editor?: boolean; disabled?: boolean;
  beforeAdd?: () => Promise<boolean>; onRemove?: (link: MaterialLink) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const list = useResourceList(projectId, scope);
  const data = useResourceBindings(projectId, provided ? undefined : scope.routeId);
  if (!list.enabled) return null;
  const links = data?.links.filter(link => (link.kind === 'lesson' && link.targetId === scope.nodeId) ||
    (link.kind === 'chapter' && link.targetId === chapterId)) ?? [];
  const inherited = provided ?? attachmentsFrom(links, data?.items ?? []);
  const combined = [...inherited, ...list.items.map(item => ({item} as ResourceAttachment))];
  const keys = new Set<string>();
  const items = combined.filter(({item, segmentId}) => {
    const key = resourceKey(item) + '/' + (segmentId ?? '');
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  async function choose() {
    if (choosing || disabled) return;
    setChoosing(true);setError('');
    try {
      if (beforeAdd && !await beforeAdd()) return;
      await list.refresh();
      setOpen(true);
    } catch (cause) {setError(resourceMessage(cause, language));}
    finally {setChoosing(false);}
  }
  const bindings: MaterialLink[] = [
    ...inherited.flatMap(value => value.link ? [value.link] : []),
    ...items.map(({item}) => ({id: item.id, version: item.version, kind: 'lesson' as const, targetId: scope.nodeId, origin: 'editor' as const}))
  ];
  return <>
    <ResourceAttachments projectId={projectId} language={language} items={items} lesson={!editor}
      onChoose={disabled || choosing ? undefined : () => void choose()} onRemove={onRemove}/>
    {error && <p className="form-message is-error" role="alert">{error}</p>}
    {open && <ResourceDialog projectId={projectId} language={language} list={list} scope={scope}
      inherited={inherited.map(attachment => attachment.item).filter((item, index, all) =>
        !item.removed && all.findIndex(value => resourceKey(value) === resourceKey(item)) === index)}
      onChooseLibrary={() => setPicker(true)} onClose={() => setOpen(false)}/>}
    {picker && <ResourcePicker projectId={projectId} language={language} bindings={bindings} busy={choosing} wholeOnly
      onAdd={async item => {
        setChoosing(true);
        try {
          const report = await resourceService.attachLesson(projectId, item, scope);
          if (report.overLimit) throw new Error('RESOURCE_LIMIT');
          if (!report.added && !report.duplicates) throw new Error('RESOURCE_UNAVAILABLE');
          await list.refresh();
          return true;
        } finally {setChoosing(false);}
      }} onClose={() => setPicker(false)}/>}
  </>;
}
