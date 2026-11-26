import {emptyLessonWorkspace, nextLessonWorkspace, recoverLessonWorkspace, resetLessonWorkspace, validateLessonIdentity, validateLessonWorkspace} from '../../../../packages/domain/lesson-workspace.mjs';
import type {ResourceSelection} from '../../../../packages/domain/planning.mjs';
import {browserProjectTransaction, withProjectLock} from '../planning/browser-store';
import {resourceRef} from '../resources/service';
import type {LessonIdentity, LessonWorkspace} from './types';

export type LessonPreview = {url: string; mimeType: string; name: string};
let database: Promise<IDBDatabase> | undefined;
const opened = new Set<string>();
const documentKey = (identity: LessonIdentity) => JSON.stringify([identity.projectId, identity.routeId, identity.nodeId]);
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibe-improve.lessons.v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces', {keyPath: ['projectId', 'routeId', 'nodeId']});
    request.onsuccess = () => {
      request.result.onversionchange = () => {request.result.close(); database = undefined;};
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => {database = undefined; reject(new Error('LESSON_STORAGE_UNAVAILABLE'));};
  });
}
async function browserIdentity(identity: LessonIdentity): Promise<number> {
  validateLessonIdentity(identity);
  return browserProjectTransaction(identity.projectId, ({state, progress}) => {
    const route = state?.routeDraft;
    if (!route || route.id !== identity.routeId || state?.confirmedRevision !== route.revision ||
        !route.chapters.some(chapter => chapter.nodes.some(node => node.id === identity.nodeId))) throw new Error('LESSON_TARGET_UNAVAILABLE');
    return progress.notebookResetRevision;
  });
}
type StoredWorkspace = LessonIdentity & {storageVersion: 1; notebookResetRevision: number; workspace: LessonWorkspace};
function restored(raw: unknown, identity: LessonIdentity, epoch: number): LessonWorkspace {
  const stored = raw as Partial<StoredWorkspace> | undefined;
  const revision = stored?.storageVersion === undefined ? 0 : stored.notebookResetRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > epoch ||
      stored?.storageVersion !== undefined && stored.storageVersion !== 1) throw new Error('LESSON_STORAGE_UNAVAILABLE');
  let workspace = stored?.storageVersion === undefined
    ? raw === undefined ? emptyLessonWorkspace(identity) : validateLessonWorkspace(raw, identity)
    : validateLessonWorkspace(stored.workspace, identity);
  if (revision < epoch) workspace = resetLessonWorkspace(workspace, identity);
  return opened.has(documentKey(identity)) ? workspace : recoverLessonWorkspace(workspace, identity);
}
function storedWorkspace(identity: LessonIdentity, workspace: LessonWorkspace, epoch: number): StoredWorkspace {
  return {...identity, storageVersion: 1, notebookResetRevision: epoch, workspace};
}
async function read(identity: LessonIdentity): Promise<LessonWorkspace> {
  validateLessonIdentity(identity);
  const native = window.vibeNative?.projects;
  if (native) return validateLessonWorkspace(await native.request('lesson.read', {...identity}), identity);
  return withProjectLock(identity.projectId, async () => {
    const epoch = await browserIdentity(identity);
    const storage = await db();
    return new Promise((resolve, reject) => {
      const transaction = storage.transaction('workspaces', 'readwrite');
      const documents = transaction.objectStore('workspaces');
      const key = documentKey(identity);
      let result: LessonWorkspace;
      let failure: unknown = new Error('LESSON_STORAGE_UNAVAILABLE');
      transaction.oncomplete = () => {opened.add(key);resolve(result);};
      transaction.onerror = transaction.onabort = () => reject(failure);
      const request = documents.get([identity.projectId, identity.routeId, identity.nodeId]);
      request.onsuccess = () => {
        try {
          result = restored(request.result, identity, epoch);
          // Also migrate the initial bare workspace format without altering its revision.
          documents.put(storedWorkspace(identity, result, epoch));
        } catch (error) {failure = error;transaction.abort();}
      };
    });
  });
}
async function save(identity: LessonIdentity, expectedRevision: number, workspace: LessonWorkspace): Promise<LessonWorkspace> {
  validateLessonWorkspace(workspace, identity);
  const native = window.vibeNative?.projects;
  if (native) return validateLessonWorkspace(await native.request('lesson.save', {...identity, expectedRevision, workspace}), identity);
  return withProjectLock(identity.projectId, async () => {
    const epoch = await browserIdentity(identity);
    const storage = await db();
    return new Promise((resolve, reject) => {
      const transaction = storage.transaction('workspaces', 'readwrite');
      const documents = transaction.objectStore('workspaces');
      let result: LessonWorkspace;
      let failure: unknown = new Error('LESSON_STORAGE_UNAVAILABLE');
      transaction.oncomplete = () => {opened.add(documentKey(identity));resolve(result);};
      transaction.onerror = transaction.onabort = () => reject(failure);
      const request = documents.get([identity.projectId, identity.routeId, identity.nodeId]);
      request.onsuccess = () => {
        try {
          const current = restored(request.result, identity, epoch);
          result = nextLessonWorkspace(current, identity, expectedRevision, workspace);
          documents.put(storedWorkspace(identity, result, epoch));
        } catch (error) {failure = error; transaction.abort();}
      };
    });
  });
}
async function preview(identity: LessonIdentity, ref: ResourceSelection): Promise<LessonPreview> {
  validateLessonIdentity(identity);
  if (!window.vibeNative?.projects) throw new Error('LESSON_DESKTOP_REQUIRED');
  const result = await window.vibeNative.projects.request('lesson.preview', {...identity, ref: resourceRef(ref)}) as LessonPreview;
  if (!result || typeof result.url !== 'string' || typeof result.mimeType !== 'string' || typeof result.name !== 'string') throw new Error('LESSON_PREVIEW_UNAVAILABLE');
  // Local content must come from this app's current loopback origin; web links are not fetched here.
  const url = new URL(result.url, location.href);
  if (result.mimeType === 'text/uri-list' ? !['https:', 'http:'].includes(url.protocol) : url.origin !== location.origin || !url.pathname.startsWith('/vibe-improve/lesson-preview/')) throw new Error('LESSON_PREVIEW_UNAVAILABLE');
  return {...result, url: url.href};
}
export const lessonService = {read, save, preview};
