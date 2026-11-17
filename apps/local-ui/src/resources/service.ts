import {useCallback, useEffect, useRef, useState} from 'react';
import {translate, type Language} from '../i18n';
import type {MaterialLink, PlanningState, ResourceSelection} from '../../../../packages/domain/planning.mjs';
import {validatePlanning} from '../../../../packages/domain/planning.mjs';

export type ResourceStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'needsAttention' | 'attachment';
export type ResourceLocation = {kind: 'page' | 'paragraph' | 'time'; start: number; end?: number};
export type ResourcePosition = {id: string; location: ResourceLocation};
export type ResourceSegment = ResourcePosition & {text: string};
export type SpeechLocale = 'auto' | 'zh-CN' | 'en-US';
export type ResourceItem = ResourceSelection & {
  format: 'pdf' | 'document' | 'captions' | 'audio' | 'video' | 'web' | 'file';
  name: string;
  planning: boolean;
  removed: boolean;
  status: ResourceStatus;
  reason?: string;
  read?: number;
  total?: number;
  lessonCount: number;
  segmentCount: number;
  positions?: ResourcePosition[];
  segments?: ResourceSegment[];
  overview?: string;
  fromTutorialSearch?: boolean;
  speechLocale?: SpeechLocale;
  hasTranscript?: boolean;
};
export type ResourceScope = {routeId: string; nodeId: string};
export type ResourceImport = {added: number; duplicates: number; overLimit: number; invalidLines: number[]; skipped: number; scanLimited: boolean};
export type ResourceDraft = {id: string; items: ResourceItem[]; dirty: boolean};
type TutorialSearchResult = {status: 'full' | 'complete'; added: number};
export type ResourceLimits = {files: number; links: number; lessonFiles: number; lessonLinks: number};
export type AttachmentTarget = {kind: MaterialLink['kind']; targetId: string};

export const resourceRef = ({id, version}: ResourceSelection): ResourceSelection => ({id, version});
export const resourceKey = ({id, version}: ResourceSelection): string => id + '/' + version;
export const isResourceUsable = (item: ResourceItem) => !item.removed && item.segmentCount > 0 &&
  (item.status === 'ready' || item.status === 'partial');
export const isResourceParseFailed = (item: ResourceItem) => item.status === 'attachment' ||
  (item.status === 'needsAttention' && item.reason !== 'speechPaused');
export const hasDesktopResources = () => typeof window !== 'undefined' && Boolean(window.vibeNative?.projects);

async function request<T>(action: string, projectId: string, body: Record<string, unknown> = {}): Promise<T> {
  const native = window.vibeNative?.projects;
  if (!native) throw new Error('RESOURCE_DESKTOP_REQUIRED');
  return await native.request('resources.' + action, {projectId, ...body}) as T;
}
const scopeData = (scope?: ResourceScope) => scope ? {scope} : {};
export const resourceService = {
  read: (project: string, scope?: ResourceScope) => request<ResourceItem[]>('read', project, scopeData(scope)),
  library: (project: string) => request<ResourceItem[]>('library', project),
  detail: (project: string, item: ResourceSelection) => request<ResourceItem>('detail', project, {ref: resourceRef(item)}),
  limits: (project: string) => request<ResourceLimits>('limits', project),
  addFiles: (project: string, scope?: ResourceScope) =>
    request<ResourceImport | null>('chooseFiles', project, scopeData(scope)),
  addLinks: (project: string, text: string, scope?: ResourceScope) => request<ResourceImport>('addLinks', project, {text, ...scopeData(scope)}),
  beginDraft: (project: string) => request<ResourceDraft>('beginDraft', project),
  readDraft: (project: string, draftId: string) => request<ResourceDraft>('readDraft', project, {draftId}),
  addDraftFiles: (project: string, draftId: string) =>
    request<ResourceImport | null>('chooseFiles', project, {draftId}),
  addDraftLinks: (project: string, draftId: string, text: string) =>
    request<ResourceImport>('addLinks', project, {draftId, text}),
  removeDraftItems: (project: string, draftId: string, items: ResourceSelection[]) =>
    request<void>('removeDraftItems', project, {draftId, refs: items.map(resourceRef)}),
  removeDraftFailures: (project: string, draftId: string) => request<void>('removeDraftFailures', project, {draftId}),
  saveDraft: (project: string, draft: ResourceDraft) =>
    request<void>('saveDraft', project, {draftId: draft.id, refs: draft.items.map(resourceRef)}),
  discardDraft: (project: string, draftId: string) => request<void>('discardDraft', project, {draftId}),
  searchTutorials: (state: PlanningState, draftId: string, mode: 'start' | 'continue') =>
    request<TutorialSearchResult>('searchTutorials', state.projectId, {draftId, mode, expectedRevision: state.revision}),
  open: (project: string, item: ResourceSelection, segmentId?: string) =>
    request<void>('open', project, {ref: resourceRef(item), ...(segmentId ? {segmentId} : {})}),
  openTranscript: (project: string, item: ResourceSelection) =>
    request<void>('openTranscript', project, {ref: resourceRef(item)}),
  pauseTranscription: (project: string, item: ResourceSelection) =>
    request<void>('pauseTranscription', project, {ref: resourceRef(item)}),
  change: (project: string, verb: 'retry' | 'chooseCaptions' | 'detach', item: ResourceSelection, scope?: ResourceScope) =>
    request<void>(verb, project, {ref: resourceRef(item), ...scopeData(scope)}),
  transcribe: (project: string, item: ResourceSelection, locale: SpeechLocale) =>
    request<void>('transcribe', project, {ref: resourceRef(item), locale}),
  bindings: (project: string, routeId: string) => request<{links: MaterialLink[]; items: ResourceItem[]}>('bindings', project, {routeId}),
  bind: async (state: PlanningState, routeId: string, target: AttachmentTarget, item: ResourceSelection, add: boolean, segmentId?: string) =>
    validatePlanning(await request<unknown>(add ? 'bind' : 'unbind', state.projectId,
      {routeId, ...target, ref: resourceRef(item), expectedRevision: state.revision, ...(segmentId ? {segmentId} : {})}))
};

const resourceMessages: Record<string, [string, string]> = {
  RESOURCE_DESKTOP_REQUIRED: ['请在桌面 App 中添加学习资料。', 'Add resources in the desktop app.'],
  RESOURCE_INVALID: ['资料操作未完成，请检查输入或重新选择。', 'Check the input or select the resource again.'],
  RESOURCE_STORAGE: ['无法读取或保存资料，请重试。', 'Could not read or save resources. Try again.'],
  RESOURCE_LIMIT: ['超出资料容量。请减少本次添加的数量或文本长度。', 'Resource limit reached. Add fewer items or shorten the input.'],
  RESOURCE_UNAVAILABLE: ['资料已移动、变更或移除，请重新添加。', 'The resource moved, changed or was removed. Add it again.'],
  RESOURCE_SELECTION_CHANGED: ['资料或章节已更新，请重新打开后继续。', 'The source or chapter changed. Reopen it to continue.'],
  RESOURCE_SEARCH_UNAVAILABLE: ['本次未能完成联网搜索，可使用已有资料继续。', 'Online search could not finish. You can continue with your current resources.'],
  RESOURCE_SEARCH_NEEDS_TOPIC: ['先确认学习方向，再搜索教程。', 'Confirm your learning topic before searching.'],
  PLANNING_STUDIED_LESSON_LOCKED: ['该章节已开始学习，可在小节背包添加资料。', 'This chapter is locked. Add resources in the lesson backpack.'],
  PLANNING_CONFLICT: ['路线已更新，请重新打开后继续。', 'The route changed. Reopen it to continue.'],
  PLANNING_LIMIT: ['本路线的资料关联已满。', 'This route has reached the attachment limit.']
};
export function resourceMessage(cause: unknown, language: Language): string {
  const code = String(cause).match(/(?:RESOURCE|PLANNING)_[A-Z_]+/)?.[0] ?? 'RESOURCE_STORAGE';
  return translate(language, ...(resourceMessages[code] ?? resourceMessages.RESOURCE_STORAGE));
}

export function useResourceList(projectId: string, scope?: ResourceScope) {
  const enabled = hasDesktopResources();
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [limits, setLimits] = useState<ResourceLimits>();
  const [error, setError] = useState<unknown>();
  const [loaded, setLoaded] = useState(false);
  const reading = useRef(0);
  const routeId = scope?.routeId, nodeId = scope?.nodeId;
  const refresh = useCallback(async () => {
    if (!enabled) return [];
    const seq = ++reading.current;
    try {
      const next = await resourceService.read(projectId, routeId && nodeId ? {routeId, nodeId} : undefined);
      if (seq === reading.current) {setItems(next); setError(undefined); setLoaded(true);}
      return next;
    } catch (cause) {
      if (seq === reading.current) {setError(cause); setLoaded(true);}
      throw cause;
    }
  }, [enabled, projectId, routeId, nodeId]);
  useEffect(() => {
    setItems([]);
    setLoaded(false);
    setError(undefined);
    if (enabled) void refresh().catch(() => {});
    return () => {reading.current += 1;};
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void resourceService.limits(projectId).then(value => {if (current) setLimits(value);}, () => {});
    return () => {current = false;};
  }, [enabled, projectId]);
  const processing = items.some(item => item.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 1100);
    return () => window.clearInterval(timer);
  }, [processing, refresh]);
  return {enabled, items, limits, error, loaded, refresh};
}

export function useResourceBindings(project: string, routeId: string | undefined, revision?: number) {
  const [data, setData] = useState<{routeId: string; links: MaterialLink[]; items: ResourceItem[]}>();
  useEffect(() => {
    if (!routeId || !hasDesktopResources()) return;
    let current = true;
    void resourceService.bindings(project, routeId).then(value => {
      if (current) setData({routeId, ...value});
    }, () => {});
    return () => {current = false;};
  }, [project, routeId, revision]);
  return data?.routeId === routeId ? data : undefined;
}

export function timecode(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
export function resourceLocation(location: ResourceLocation | undefined, language: Language) {
  if (!location) return translate(language, '原件', 'Original');
  const {kind, start, end} = location;
  if (kind === 'time') return timecode(start) + (end && end !== start ? '–' + timecode(end) : '');
  const range = start + (end && end !== start ? '–' + end : '');
  return kind === 'page' ? translate(language, '第 ' + range + ' 页', 'Page ' + range)
    : translate(language, '第 ' + range + ' 段', 'Paragraph ' + range);
}
