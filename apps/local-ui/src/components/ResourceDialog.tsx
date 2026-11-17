import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, CircleCheck, Clock, File, FileText, Film, Headphones, Link2, LoaderCircle, LockKeyhole, Paperclip} from 'lucide-react';
import {translate, type Language} from '../i18n';
import {
  isResourceParseFailed, resourceKey, resourceLocation, resourceMessage, resourceService, timecode, useResourceList,
  type ResourceImport, type ResourceItem, type ResourceScope, type SpeechLocale
} from '../resources/service';
import GameButton from './GameButton';
import Modal from './Modal';
import './resources.css';

const formatIcons = {pdf: FileText, document: FileText, captions: FileText, audio: Headphones, video: Film, web: Link2, file: File};
export const resourceFormatLabels: Record<ResourceItem['format'], [string, string]> = {
  pdf: ['PDF', 'PDF'], document: ['文档', 'Document'], captions: ['字幕', 'Captions'],
  audio: ['音频', 'Audio'], video: ['视频', 'Video'], web: ['网页', 'Web page'], file: ['文件', 'File']
};
export const resourceReasons: Record<string, [string, string]> = {
  encrypted: ['PDF 已加密，请添加解锁版。', 'Add an unlocked copy of this PDF.'],
  somePages: ['部分页面未能读出正文。', 'Some pages have no readable text.'],
  sizeLimited: ['只提取了部分正文。', 'Only part of the text was extracted.'],
  fileTooLarge: ['文件超过解析大小，仅保留原件。', 'This file is too large to read. The original is available.'],
  storageFull: ['资料摘录空间不足，仅保留原件。', 'Excerpt storage is full. The original is available.'],
  encoding: ['无法识别文字编码。', 'The text encoding could not be read.'],
  empty: ['没有读到可用正文。', 'No readable text was found.'],
  emptyPage: ['没有读到公开正文。可以添加本地副本。', 'No public article text was found. You can add a local copy.'],
  invalidLink: ['网页链接无效。', 'The page link is invalid.'],
  unreachableLink: ['无法访问此公开地址。', 'This public address could not be reached.'],
  network: ['网页读取失败，请重试。', 'The page could not be read. Try again.'],
  requiresLogin: ['网页需要登录或访问权限，可以添加本地副本。', 'The page requires access. You can add a local copy.'],
  unsupported: ['此格式可作为附件。', 'This format is available as an attachment.'],
  moved: ['原文件已移动或更新，请重新添加。', 'The file moved or changed. Add it again.'],
  readFailed: ['未能读取文件，请重试。', 'Could not read the file. Try again.'],
  captionsNeeded: ['可导入 SRT/VTT 字幕，或将音轨转成带时间码的文字。', 'Import SRT/VTT captions or transcribe the audio track into timestamped text.'],
  invalidCaptions: ['没有读到有效字幕。请选择带时间码的字幕。', 'Add captions with valid timestamps.'],
  someCaptions: ['只读到部分字幕。', 'Only part of the captions could be read.'],
  speechUnavailable: ['本机不支持转写此音轨，可添加字幕。', 'On-device transcription is unavailable for this track. You can add captions.'],
  speechFailed: ['转写中断，可从已保存的位置继续。', 'Transcription was interrupted. You can resume from the saved position.'],
  speechPaused: ['转写已暂停，进度已保存。', 'Transcription paused. Progress was saved.'],
  speechPartial: ['本机转写仅覆盖部分音频。', 'The transcript covers part of the audio.'],
  noSpeech: ['未识别到可用的语音文字，可以添加字幕。', 'No spoken text was recognized. You can add captions.'],
  noAudio: ['未找到音轨，可添加字幕。', 'No audio track was found. You can add captions.']
};

export function ResourceIcon({format}: {format: ResourceItem['format']}) {
  const Icon = formatIcons[format];
  return <span className="resource-type-icon"><Icon aria-hidden="true"/></span>;
}

export function ResourceBadge({item, language, planning}: {item: ResourceItem; language: Language; planning: boolean}) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const appearance = {
    pending: [Clock, t('待解析', 'Pending')],
    processing: [LoaderCircle, item.reason === 'transcribing' ? t('转写中', 'Transcribing') : t('解析中', 'Parsing')],
    ready: [CircleCheck, t('已解析', 'Parsed')],
    partial: [AlertTriangle, t('部分可用', 'Partial')],
    needsAttention: [item.reason === 'requiresLogin' ? LockKeyhole : AlertTriangle, item.reason === 'speechPaused'
      ? t('已暂停', 'Paused') : t('需处理', 'Needs action')],
    attachment: [Paperclip, t('仅附件', 'Attachment')]
  } as const;
  if (planning && isResourceParseFailed(item)) return <span className="resource-badge is-needsAttention">
    <AlertTriangle aria-hidden="true"/>{t('解析失败', 'Failed')}
  </span>;
  const [Icon, label] = appearance[item.status];
  return <span className={'resource-badge is-' + item.status}><Icon aria-hidden="true"/>{label}</span>;
}

export function reportMessage(report: ResourceImport, language: Language, lesson: boolean) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const summary = [t('已添加 ' + report.added + ' 项', 'Added ' + report.added)];
  if (report.duplicates) summary.push(t('跳过 ' + report.duplicates + ' 项重复资料', report.duplicates + ' duplicates skipped'));
  if (report.overLimit) summary.push(t(report.overLimit + ' 项超出上限。' + (lesson ? '' : '可在小节背包补加。'),
    report.overLimit + ' over the limit.' + (lesson ? '' : ' Add them later in a lesson backpack.')));
  if (report.invalidLines.length) {
    const lines = report.invalidLines.slice(0, 10).join(language === 'en' ? ', ' : '、');
    const suffix = report.invalidLines.length > 10 ? '…' : '';
    summary.push(t('无效链接行 ' + lines + suffix, 'Invalid link lines ' + lines + suffix));
  }
  if (report.skipped) summary.push(t(report.skipped + ' 个项目不可读取或为链接文件', report.skipped + ' unreadable files or aliases skipped'));
  if (report.scanLimited) summary.push(t('还有文件未扫描', 'Some files were not scanned'));
  return summary.join(' · ');
}

type ResourceDialogProps = {
  projectId: string;
  language: Language;
  onClose: () => void;
  list: ReturnType<typeof useResourceList>;
  scope: ResourceScope;
  inherited?: ResourceItem[];
};
export default function ResourceDialog({projectId, language, list, scope, inherited = [], onClose}: ResourceDialogProps) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [selected, setSelected] = useState<string>();
  const [details, setDetails] = useState<ResourceItem>();
  const [segmentId, setSegmentId] = useState('');
  const [linksOpen, setLinksOpen] = useState(false);
  const [links, setLinks] = useState('');
  const linkInput = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [speechLanguage, setSpeechLanguage] = useState<{key: string; locale: SpeechLocale}>();
  const items = [...list.items, ...inherited.filter(item => !list.items.some(value => resourceKey(value) === resourceKey(item)))];
  const item = items.find(value => resourceKey(value) === selected) ?? items[0];
  const key = item ? resourceKey(item) : undefined;
  const currentDetails = details && resourceKey(details) === key && details.status === item?.status ? details : undefined;
  const segments = currentDetails?.segments ?? [];
  const segment = segments.find(part => part.id === segmentId) ?? segments[0];
  const direct = list.items.some(value => resourceKey(value) === key);

  useEffect(() => {
    if (!item || !key) return;
    let active = true;
    void resourceService.detail(projectId, item).then(value => {if (active) setDetails(value);}, () => {});
    return () => {active = false;};
  }, [projectId, key, item?.status, item?.segmentCount]);

  useEffect(() => {
    if (linksOpen) linkInput.current?.focus();
  }, [linksOpen]);

  async function run<T>(work: () => Promise<T>, completed?: (value: T) => void, refresh = true) {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const outcome = await work();
      if (refresh) await list.refresh();
      completed?.(outcome);
    } catch (cause) {setError(resourceMessage(cause, language));}
    finally {setBusy(false);}
  }
  function added(report: ResourceImport | null) {
    if (report) setFeedback(reportMessage(report, language, true));
  }
  function submitLinks() {
    if (!links.trim()) return;
    void run(() => resourceService.addLinks(projectId, links, scope), report => {
      added(report);
      if (!report.invalidLines.length && !report.overLimit) {setLinks(''); setLinksOpen(false);}
    });
  }
  const linksCount = list.items.filter(value => value.format === 'web').length;
  const fileCount = list.items.length - linksCount;
  const fileLimit = list.limits?.lessonFiles;
  const linkLimit = list.limits?.lessonLinks;
  const filesFull = fileLimit !== undefined && fileCount >= fileLimit;
  const linksFull = linkLimit !== undefined && linksCount >= linkLimit;
  const media = item?.format === 'audio' || item?.format === 'video';
  const captionsAllowed = media && !item.segmentCount && item.status !== 'processing' && item.status !== 'pending' && item.reason !== 'moved';
  const transcribing = item?.status === 'processing' && item.reason === 'transcribing';
  const savedLanguage = item?.hasTranscript !== undefined ? item.speechLocale : undefined;
  const resuming = item?.reason === 'speechPaused' || item?.status === 'partial' && item.reason === 'speechFailed';
  const canTranscribe = item && (captionsAllowed || media && item.status === 'partial' && item.speechLocale) &&
    item.reason !== 'moved' && (!savedLanguage || !['noAudio', 'noSpeech', 'speechUnavailable'].includes(item.reason ?? ''));
  const locale = savedLanguage ?? (speechLanguage?.key === key ? speechLanguage?.locale : undefined) ?? 'auto';
  const metadata = item?.read !== undefined && item.total !== undefined
    ? item.format === 'pdf' || item.format === 'web'
      ? t(item.read + ' / ' + item.total + ' 页可读', item.read + ' / ' + item.total + ' pages readable')
      : t('已转写 ', 'Transcribed ') + timecode(item.read * 1_000) + ' / ' + timecode(item.total * 1_000)
    : undefined;

  return <Modal title={t('背包资料', 'Backpack resources')}
    className="resource-dialog" closeLabel={t('关闭', 'Close')} onClose={onClose} busy={busy} focusHeading>
    <div className="resource-dialog-content">
    <div className="resource-toolbar">
      <GameButton variant="secondary" leadingIcon={<File aria-hidden="true"/>} disabled={busy || filesFull}
        onClick={() => void run(() => resourceService.addFiles(projectId, scope), added)}>{t('添加文件', 'Add files')}</GameButton>
      <GameButton variant="secondary" leadingIcon={<Link2 aria-hidden="true"/>} disabled={busy || (linksFull && !linksOpen)}
        aria-expanded={linksOpen} onClick={() => setLinksOpen(value => !value)}>{t('添加链接', 'Add links')}</GameButton>
      {fileLimit !== undefined && linkLimit !== undefined && <span className="resource-counts">
        {t('文件', 'Files')} {fileCount}/{fileLimit} · {t('链接', 'Links')} {linksCount}/{linkLimit}
      </span>}
    </div>
    {linksOpen && <form className="resource-link-form" onSubmit={event => {event.preventDefault(); submitLinks();}}>
      <label htmlFor="resource-urls">{t('每行一个网页链接', 'One web link per line')}</label>
      <textarea ref={linkInput} id="resource-urls" value={links} onChange={event => setLinks(event.target.value)} maxLength={48_000}
        rows={3} placeholder={'https://example.org/guide\nhttps://example.org/notes'} readOnly={busy}/>
      <GameButton type="submit" disabled={busy || linksFull || !links.trim()}>{t('加入清单', 'Add to list')}</GameButton>
    </form>}
    {feedback && <p className="resource-feedback" role="status">{feedback}</p>}
    {error && <p role="alert" className="form-message is-error">{error}</p>}
    {Boolean(list.error) && <div className="resource-retry"><p role="alert">{resourceMessage(list.error, language)}</p>
      <button className="resource-link-button" type="button" onClick={() => void list.refresh().catch(() => {})}>{t('重试', 'Retry')}</button>
    </div>}
    {items.length ? <div className="resource-grid">
      <div className="resource-list" aria-label={t('资料列表', 'Resource list')}>
        {items.map(value => {
          const valueKey = resourceKey(value);
          const info = <>
            <ResourceIcon format={value.format}/>
            <span className="resource-name-group"><strong title={value.name}>{value.name}</strong>
              <small>{value.fromTutorialSearch ? t('网上找到的教程', 'Online tutorial') : t(...resourceFormatLabels[value.format])}</small>
            </span>
            <ResourceBadge item={value} language={language} planning={false}/>
          </>;
          return <button type="button" className="resource-list-row" key={valueKey} aria-pressed={key === valueKey}
            onClick={() => {setSelected(valueKey); setSegmentId('');}}>{info}</button>;
        })}
      </div>
      {item && <section className="resource-detail">
        <div className="resource-detail-header"><h3>{t('解析结果', 'Parse result')}</h3><ResourceBadge item={item} language={language} planning={false}/></div>
        <strong className="resource-detail-name">{item.name}</strong>
        {metadata && <p>{metadata}</p>}
        {item.reason && resourceReasons[item.reason] && <p>{t(...resourceReasons[item.reason])}</p>}
        {canTranscribe && !savedLanguage && <p>{t('Whisper 在本机转写完整音轨，分段保存进度。',
          'Whisper transcribes the full audio track on this Mac and saves progress as it goes.')}</p>}
        {segment && <div className="resource-snippet">
          {segments.length > 1 && <label>{t('摘录位置', 'Excerpt location')}
            <select value={segment.id} onChange={event => setSegmentId(event.target.value)}>
              {segments.map(part => <option key={part.id} value={part.id}>{resourceLocation(part.location, language)}</option>)}
            </select>
          </label>}
          {segments.length === 1 && <strong>{resourceLocation(segment.location, language)}</strong>}
          <p>{segment.text}</p>
        </div>}
        <div className="resource-detail-actions">
          <button className="resource-link-button" type="button" disabled={busy}
            onClick={() => void run(() => resourceService.open(projectId, item, segment?.id), undefined, false)}>{t('打开原件', 'Open original')}</button>
          {item.hasTranscript && <button className="resource-link-button" type="button" disabled={busy}
            onClick={() => void run(() => resourceService.openTranscript(projectId, item), undefined, false)}>{t('查看转写', 'View transcript')}</button>}
          {transcribing && <button className="resource-link-button" type="button" disabled={busy}
            onClick={() => void run(() => resourceService.pauseTranscription(projectId, item))}>{t('暂停转写', 'Pause transcription')}</button>}
          {item.status === 'needsAttention' && !item.speechLocale && !['requiresLogin', 'moved', 'encrypted'].includes(item.reason ?? '') &&
            <button className="resource-link-button" type="button" disabled={busy} onClick={() => void run(() => resourceService.change(projectId, 'retry', item))}>{t('重试', 'Retry')}</button>}
          {captionsAllowed && <button type="button" className="resource-link-button" disabled={busy}
            onClick={() => void run(() => resourceService.change(projectId, 'chooseCaptions', item))}>{t('添加字幕', 'Add captions')}</button>}
          {canTranscribe && <>
            {!savedLanguage && <select aria-label={t('音频语言', 'Audio language')} value={locale} disabled={busy}
              onChange={event => setSpeechLanguage({key: resourceKey(item), locale: event.target.value as SpeechLocale})}>
              <option value="auto">{t('自动识别', 'Detect language')}</option>
              <option value="zh-CN">{t('中文', 'Chinese')}</option><option value="en-US">{t('英语', 'English')}</option>
            </select>}
            <button type="button" className="resource-link-button" disabled={busy}
              onClick={() => void run(() => resourceService.transcribe(projectId, item, locale))}>
              {resuming ? t('继续转写', 'Resume transcription') : t('本机转写', 'Transcribe locally')}
            </button>
          </>}
        </div>
        {direct && <div className="resource-detail-bottom">
          <button className="resource-link-button is-danger" type="button" disabled={busy}
            onClick={() => void run(() => resourceService.change(projectId, 'detach', item, scope))}>{t('移除', 'Remove')}</button>
        </div>}
      </section>}
    </div> : <div className="resource-empty">{list.loaded ? t('尚未添加资料', 'No resources added') : t('正在读取资料…', 'Loading resources…')}</div>}
    </div>
    <footer className="resource-dialog-footer">
      <div className="resource-footer-status"><span role="status">{t(items.length + ' 项资料', items.length + ' resources')}</span></div>
      <GameButton variant="secondary" onClick={onClose} disabled={busy}>{t('完成', 'Done')}</GameButton>
    </footer>
  </Modal>;
}
