import {useCallback, useEffect, useRef, useState} from 'react';
import {ChevronDown, ExternalLink, File, Link2, LoaderCircle, RefreshCw} from 'lucide-react';
import type {PlanningState} from '../../../../packages/domain/planning.mjs';
import {translate, type Language} from '../i18n';
import {
  isResourceParseFailed, resourceKey, resourceLocation, resourceMessage, resourceService, timecode,
  type ResourceDraft, type ResourceItem, type ResourceLimits
} from '../resources/service';
import GameButton from './GameButton';
import GameSelect from './GameSelect';
import Modal from './Modal';
import {reportMessage, ResourceBadge, resourceFormatLabels, ResourceIcon, resourceReasons} from './ResourceDialog';

type Props = {
  state: PlanningState;
  language: Language;
  limits?: ResourceLimits;
  onSaved: () => Promise<void>;
  onClose: () => void;
};

type ResourceAction = (work: () => Promise<void>, refresh?: boolean) => void;

function ResourceContents({projectId, item, language, busy, onAction}: {
  projectId: string; item: ResourceItem; language: Language; busy: boolean; onAction: ResourceAction;
}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [detail, setDetail] = useState<ResourceItem>();
  const [error, setError] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const {id, version, status, segmentCount, reason} = item;
  useEffect(() => {
    if (!segmentCount) return;
    let current = true;
    setError('');
    void resourceService.detail(projectId, {id, version}).then(info => {
      if (current) setDetail(info);
    }, cause => {
      if (current) setError(resourceMessage(cause, language));
    });
    return () => {current = false;};
  }, [projectId, id, version, status, segmentCount, language]);
  const segments = segmentCount && detail?.status === status ? detail.segments ?? [] : [];
  const segment = segments.find(value => value.id === segmentId) ?? segments[0];
  const canAddCaptions = (item.format === 'video' || item.format === 'audio') &&
    status !== 'processing' && !segmentCount && reason !== 'moved';
  const resume = reason === 'speechPaused' || status === 'partial' && reason === 'speechFailed';
  const transcribing = status === 'processing' && reason === 'transcribing';
  return <>
    {reason && resourceReasons[reason] && <p>{t(...resourceReasons[reason])}</p>}
    {item.read !== undefined && item.total !== undefined && (item.format === 'audio' || item.format === 'video') &&
      <p>{t('已转写 ', 'Transcribed ')}{timecode(item.read * 1000)} / {timecode(item.total * 1000)}</p>}
    {error && <p className="form-message is-error" role="alert">{error}</p>}
    {Boolean(segmentCount) && !detail && !error && <p role="status">{t('正在读取解析内容…', 'Loading parsed content…')}</p>}
    {segment && <>
      {detail?.overview && <div className="resource-overview">
        <strong>{t('内容概览', 'Overview')}</strong>
        <p>{detail.overview}</p>
      </div>}
      {(segments.length > 1 || detail?.overview?.trim() !== segment.text.trim()) && <div className="resource-snippet">
        <label>{t('正文摘录', 'Excerpt')}
          {segments.length > 1
            ? <GameSelect aria-label={t('正文摘录', 'Excerpt')} value={segment.id} onChange={setSegmentId}
                options={segments.map(part => ({value: part.id, label: resourceLocation(part.location, language)}))}/>
            : <span>{resourceLocation(segment.location, language)}</span>}
        </label>
        <p>{segment.text}</p>
      </div>}
    </>}
    {(item.hasTranscript || transcribing || resume || canAddCaptions) && <div className="resource-detail-actions">
      {item.hasTranscript && <button type="button" className="resource-link-button" disabled={busy}
        onClick={() => onAction(() => resourceService.openTranscript(projectId, item), false)}>{t('查看转写', 'View transcript')}</button>}
      {transcribing && <button type="button" className="resource-link-button" disabled={busy}
        onClick={() => onAction(() => resourceService.pauseTranscription(projectId, item))}>{t('暂停转写', 'Pause transcription')}</button>}
      {resume && <button type="button" className="resource-link-button" disabled={busy}
        onClick={() => onAction(() => resourceService.transcribe(projectId, item, item.speechLocale ?? 'auto'))}>{t('继续转写', 'Resume transcription')}</button>}
      {canAddCaptions && <button type="button" className="resource-link-button" disabled={busy}
        onClick={() => onAction(() => resourceService.change(projectId, 'chooseCaptions', item))}>{t('添加字幕', 'Add captions')}</button>}
    </div>}
  </>;
}

export default function PlanningResourcesDialog({state, language, limits, onSaved, onClose}: Props) {
  const projectId = state.projectId;
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [draft, setDraft] = useState<ResourceDraft>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<'links' | 'restart' | 'discard'>();
  const [links, setLinks] = useState('');
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');
  const linkInput = useRef<HTMLTextAreaElement>(null);
  const readNumber = useRef(0);
  const active = useRef(false);
  const editing = useRef(false);
  const draftId = draft?.id;
  const items = draft?.items ?? [];
  const manual = items.filter(item => !item.fromTutorialSearch);
  const tutorials = items.filter(item => item.fromTutorialSearch);
  const linkCount = items.filter(item => item.format === 'web').length;
  const fileCount = items.length - linkCount;
  const linksFull = limits !== undefined && linkCount >= limits.links;
  const filesFull = limits !== undefined && fileCount >= limits.files;
  const processing = items.some(item => item.status === 'processing');

  useEffect(() => {
    active.current = true;
    let valid = true;
    void resourceService.beginDraft(projectId).then(value => {
      if (valid) setDraft(value);
    }, cause => {
      if (valid) setError(String(cause));
    });
    return () => {valid = false; active.current = false;};
  }, [projectId, loadAttempt]);

  const refresh = useCallback(async (id: string) => {
    const number = ++readNumber.current;
    const next = await resourceService.readDraft(projectId, id);
    if (active.current && number === readNumber.current) setDraft(next);
  }, [projectId]);

  useEffect(() => {
    if (!draftId || busy || !(searching || processing)) return;
    const timer = window.setInterval(() => void refresh(draftId).catch(() => {}), 1000);
    return () => window.clearInterval(timer);
  }, [draftId, busy, searching, processing, refresh]);

  useEffect(() => {
    if (prompt === 'links') linkInput.current?.focus({preventScroll: true});
  }, [prompt]);

  async function run<T>(work: () => Promise<T>, done?: (value: T) => void | Promise<void>, read = true) {
    if (editing.current) return;
    editing.current = true;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const value = await work();
      if (read && draftId) await refresh(draftId);
      if (active.current) await done?.(value);
      return true;
    } catch (cause) {
      if (active.current) setError(String(cause));
      return false;
    } finally {
      editing.current = false;
      if (active.current) setBusy(false);
    }
  }

  function addLinks() {
    if (!draftId || !links.trim()) return;
    void run(() => resourceService.addDraftLinks(projectId, draftId, links), report => {
      setLinks('');
      setPrompt(undefined);
      setFeedback(reportMessage(report, language, false));
    });
  }

  const chosen = items.filter(item => marked.has(resourceKey(item)));
  const allChosen = chosen.length > 0 && chosen.length === items.length;
  const hasFailed = items.some(isResourceParseFailed);

  async function search(mode: 'start' | 'continue') {
    if (!draftId || searching) return;
    setPrompt(undefined);
    setSearchStatus('');
    setSearching(true);
    try {
      const result = await resourceService.searchTutorials(state, draftId, mode);
      if (!active.current) return;
      setSearchStatus(result.status === 'full' ? t('网页链接已达上限。', 'The link limit has been reached.')
        : result.added ? '' : t('未找到新教程。', 'No new tutorials found.'));
    } catch (cause) {
      if (active.current && !editing.current) setSearchStatus(resourceMessage(cause, language));
    } finally {
      if (active.current && !editing.current) await refresh(draftId).catch(() => {});
      if (active.current) setSearching(false);
    }
  }

  function finish(save: boolean) {
    if (!draft) {onClose(); return;}
    // Any final poll from the search or parser must not reopen a finished draft.
    readNumber.current += 1;
    void run(() => save ? resourceService.saveDraft(projectId, draft) : resourceService.discardDraft(projectId, draft.id),
      save ? onSaved : onClose, false).then(success => {
        if (!success && active.current && save) void refresh(draft.id).catch(() => {});
      });
  }

  function close() {
    if (draft?.dirty || searching) setPrompt('discard');
    else finish(false);
  }

  function resourceRows(list: ResourceItem[], label: string) {
    return <ul className="planning-resource-list" aria-label={label}>
      {list.map(item => {
        const key = resourceKey(item);
        const detailId = 'resource-details-' + item.id + '-' + item.version;
        const checked = marked.has(key);
        const show = expanded === key;
        const hasContents = item.segmentCount > 0 || Boolean(item.reason && resourceReasons[item.reason]) || item.hasTranscript || item.reason === 'transcribing';
        const viewOriginal = t('查看原文', 'View original');
        const retry = t('重试解析', 'Retry');
        const disclosure = show ? t('收起', 'Collapse') : t('展开', 'Expand');
        return <li className="planning-resource-entry" key={key}>
          <div className="planning-resource-row" data-checked={checked || undefined}>
            <input type="checkbox" checked={checked} aria-label={t('选择 ', 'Select ') + item.name} disabled={busy}
              onChange={event => {
                const selected = event.currentTarget.checked;
                setMarked(previous => {
                  const next = new Set(previous);
                  if (selected) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}/>
            <ResourceIcon format={item.format}/>
            <span className="resource-name-group"><strong title={item.name}>{item.name}</strong>
              <small>{t(...resourceFormatLabels[item.format])}</small>
            </span>
            <div className="planning-resource-row-actions">
              <ResourceBadge item={item} language={language} planning/>
              {isResourceParseFailed(item) && <button type="button" className="resource-link-button" disabled={busy} title={retry} aria-label={retry + ' · ' + item.name}
                onClick={() => void run(() => resourceService.change(projectId, 'retry', item))}>
                <RefreshCw aria-hidden="true"/><span>{retry}</span>
              </button>}
              <button type="button" className="resource-link-button" disabled={busy} title={viewOriginal} aria-label={viewOriginal + ' · ' + item.name}
                onClick={() => void run(() => resourceService.open(projectId, item), undefined, false)}>
                <ExternalLink aria-hidden="true"/><span>{viewOriginal}</span>
              </button>
              {hasContents && <button type="button" className="resource-link-button resource-expand" aria-expanded={show}
                aria-controls={show ? detailId : undefined} aria-label={disclosure + ' · ' + item.name} title={disclosure}
                onClick={() => setExpanded(show ? undefined : key)}>
                <ChevronDown aria-hidden="true"/><span>{disclosure}</span>
              </button>}
            </div>
          </div>
          {show && <div className="planning-resource-details" id={detailId}>
            <ResourceContents projectId={projectId} item={item} language={language} busy={busy}
              onAction={(work, read) => void run(work, undefined, read)}/>
          </div>}
        </li>;
      })}
    </ul>;
  }

  const closeLabel = t('关闭', 'Close');
  return <>
    <Modal title={t('学习资料（可选）', 'Resources (optional)')} className="resource-dialog planning-resource-dialog"
      closeLabel={closeLabel} onClose={close} busy={busy} focusHeading explicitClose>
      <div className="resource-toolbar">
        <GameButton variant="secondary" leadingIcon={<File aria-hidden="true"/>} disabled={busy || !draftId || filesFull}
          onClick={() => draftId && void run(() => resourceService.addDraftFiles(projectId, draftId), report => {
            if (report) setFeedback(reportMessage(report, language, false));
          })}>{t('添加本地文件', 'Add local files')}</GameButton>
        <GameButton variant="secondary" leadingIcon={<Link2 aria-hidden="true"/>} disabled={busy || !draftId || linksFull}
          onClick={() => {setLinks(''); setError(''); setPrompt('links');}}>{t('添加链接', 'Add links')}</GameButton>
        {limits && <span className="resource-counts">{t('文件', 'Files')} {fileCount}/{limits.files} · {t('链接', 'Links')} {linkCount}/{limits.links}</span>}
      </div>
      <div className="planning-resource-scroll">
        {!prompt && error && <p className="form-message is-error" role="alert">{resourceMessage(error, language)}</p>}
        {!draftId && error && <button type="button" className="resource-link-button" onClick={() => {
          setError(''); setLoadAttempt(attempt => attempt + 1);
        }}>{t('重试读取', 'Retry loading')}</button>}
        {feedback && <p className="resource-feedback" role="status">{feedback}</p>}
        {items.length > 0 && <div className="planning-resource-selection">
          <div className="planning-resource-selection-actions">
            <button type="button" className="resource-link-button resource-select-all" disabled={busy}
              onClick={() => setMarked(new Set(allChosen ? [] : items.map(resourceKey)))}>
              <span aria-hidden={allChosen}>{t('全选', 'Select all')}</span>
              <span aria-hidden={!allChosen}>{t('取消全选', 'Deselect all')}</span>
            </button>
            <button type="button" className="resource-link-button is-danger" disabled={busy || !chosen.length} onClick={() => draftId &&
              void run(() => resourceService.removeDraftItems(projectId, draftId, chosen), () => setMarked(new Set()))}>{t('删除所选', 'Delete selected')}</button>
            <span role="status">{t('（' + chosen.length + ' 项）', '(' + chosen.length + ')')}</span>
          </div>
          {hasFailed && <button type="button" className="resource-link-button is-danger" disabled={busy} onClick={() => draftId &&
            void run(() => resourceService.removeDraftFailures(projectId, draftId))}>{t('删除失败资料', 'Delete failed resources')}</button>}
        </div>}
        {manual.length > 0 ? resourceRows(manual, t('已添加资料', 'Added resources')) :
          !error && <div className="resource-empty">{draftId ? t('暂无本地文件或手动链接', 'No local files or added links') : t('正在读取资料…', 'Loading resources…')}</div>}
        <section className="planning-resource-search" aria-label={t('网页搜索', 'Web search')}>
          <div className="planning-resource-search-heading">
            <h3>{t('网页搜索', 'Web search')}</h3>
            <GameButton variant="secondary" disabled={busy || !draftId || searching || linksFull && !tutorials.length}
              onClick={() => {setError(''); if (tutorials.length) setPrompt('restart'); else void search('start');}}>
              {t('开始搜索', 'Start search')}
            </GameButton>
            <GameButton variant="secondary" disabled={busy || !draftId || searching || !tutorials.length || linksFull}
              onClick={() => void search('continue')}>{t('继续搜索', 'Continue search')}</GameButton>
          </div>
          {(searching || searchStatus) && <p className="planning-resource-search-status" role="status">
            {searching ? <><LoaderCircle aria-hidden="true"/>{t('正在搜索和解析教程…', 'Finding and parsing tutorials…')}</> : searchStatus}
          </p>}
          {tutorials.length > 0 && resourceRows(tutorials, t('教程搜索结果', 'Tutorial search results'))}
        </section>
      </div>
      <footer className="resource-dialog-footer">
        <GameButton variant="secondary" onClick={close} disabled={busy}>{closeLabel}</GameButton>
        <GameButton onClick={() => finish(true)} disabled={busy || !draft?.dirty}>{t('保存资料', 'Save resources')}</GameButton>
      </footer>
    </Modal>

    {prompt === 'links' && <Modal title={t('添加网页链接', 'Add web links')} className="planning-resource-prompt"
      closeLabel={closeLabel} onClose={() => setPrompt(undefined)} busy={busy}>
      <form className="planning-resource-link-form" onSubmit={event => {event.preventDefault(); addLinks();}}>
        <label htmlFor="planning-resource-urls">{t('每行一个网页链接', 'One web link per line')}</label>
        <textarea id="planning-resource-urls" ref={linkInput} value={links} onChange={event => setLinks(event.target.value)}
          maxLength={48_000} rows={5} readOnly={busy} placeholder="https://example.org/guide"/>
        {error && <p className="form-message is-error" role="alert">{resourceMessage(error, language)}</p>}
        <div className="confirmation-actions">
          <GameButton variant="secondary" type="button" disabled={busy} onClick={() => setPrompt(undefined)}>{t('取消', 'Cancel')}</GameButton>
          <GameButton type="submit" disabled={busy || linksFull || !links.trim()}>{t('添加链接', 'Add links')}</GameButton>
        </div>
      </form>
    </Modal>}
    {prompt === 'restart' && <Modal title={t('重新搜索教程？', 'Start a new search?')} className="planning-resource-prompt"
      closeLabel={closeLabel} onClose={() => setPrompt(undefined)} focusHeading>
      <p className="confirmation-copy">{t('开始搜索会清空当前的网页搜索结果。', 'Starting a new search clears the current search results.')}</p>
      <div className="confirmation-actions">
        <GameButton variant="secondary" onClick={() => setPrompt(undefined)}>{t('取消', 'Cancel')}</GameButton>
        <GameButton onClick={() => void search('start')}>{t('开始搜索', 'Start search')}</GameButton>
      </div>
    </Modal>}
    {prompt === 'discard' && <Modal title={t('关闭学习资料？', 'Close learning resources?')} className="planning-resource-prompt"
      closeLabel={closeLabel} onClose={() => setPrompt(undefined)} busy={busy} focusHeading>
      <p className="confirmation-copy">{t('未保存的资料不会作为路线参考', 'Unsaved resources will not be used as route references.')}</p>
      {error && <p className="form-message is-error" role="alert">{resourceMessage(error, language)}</p>}
      <div className="confirmation-actions">
        <GameButton variant="secondary" disabled={busy} onClick={() => setPrompt(undefined)}>{t('返回编辑', 'Keep editing')}</GameButton>
        <GameButton variant="danger" disabled={busy} onClick={() => finish(false)}>{t('关闭', 'Close')}</GameButton>
      </div>
    </Modal>}
  </>;
}
