import {validatePlanning, type PlanningState} from '../../../../packages/domain/planning.mjs';
import {emptyProgress, MAX_PROGRESS_SIZE, parseProgress, type LearningProgress} from '../routes/learning-record';

let database: Promise<IDBDatabase> | undefined;
const queues = new Map<string, Promise<unknown>>();

export async function withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return await navigator.locks.request('vibe-improve.planning.' + projectId, work);
  const queued = (queues.get(projectId) ?? Promise.resolve()).then(work, work);
  queues.set(projectId, queued);
  return queued.finally(() => {if (queues.get(projectId) === queued) queues.delete(projectId);});
}

function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibe-improve.planning.v1', 2);
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore('plans', {keyPath: 'projectId'});
      request.result.createObjectStore('learning', {keyPath: ['projectId', 'routeId']});
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {request.result.close(); database = undefined;};
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => {database = undefined; reject(new Error('PLANNING_STORAGE_UNAVAILABLE'));};
  });
}

export async function browserRead(projectId: string): Promise<PlanningState | null> {
  const storage = await db();
  return new Promise((resolve, reject) => {
    const request = storage.transaction('plans').objectStore('plans').get(projectId);
    request.onsuccess = () => {
      try {resolve(request.result ? validatePlanning(request.result) : null);}
      catch {reject(new Error('PLANNING_STORAGE_UNAVAILABLE'));}
    };
    request.onerror = () => reject(new Error('PLANNING_STORAGE_UNAVAILABLE'));
  });
}

export function legacyProgressKey(projectId: string, routeId: string): string {
  return `vibe-improve.learning.${projectId}.${routeId}`;
}

function legacyProgress(projectId: string, routeId: string): LearningProgress {
  const raw = globalThis.localStorage?.getItem(legacyProgressKey(projectId, routeId));
  if (raw == null) return emptyProgress();
  if (raw.length > MAX_PROGRESS_SIZE) throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  const record = JSON.parse(raw);
  if (record?.routeId !== routeId) throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  return parseProgress(record, raw.length);
}

type ProjectTransaction = {
  state: PlanningState | null;
  progress: LearningProgress;
  savePlan: (state: PlanningState) => void;
  saveProgress: (progress: LearningProgress) => void;
};

export async function browserProjectTransaction<T>(projectId: string, work: (value: ProjectTransaction) => T): Promise<T> {
  const storage = await db();
  return new Promise((resolve, reject) => {
    const transaction = storage.transaction(['plans', 'learning'], 'readwrite');
    const plans = transaction.objectStore('plans');
    const learning = transaction.objectStore('learning');
    let result: T;
    let failure: unknown = new Error('PLANNING_STORAGE_UNAVAILABLE');
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(failure);
    function abort(cause: unknown) {
      failure = cause;
      transaction.abort();
    }
    const plan = plans.get(projectId);
    plan.onsuccess = () => {
      try {
        const state = plan.result ? validatePlanning(plan.result) : null;
        const routeId = state?.routeDraft?.id;
        const apply = (progress: LearningProgress) => {
          result = work({
            state, progress,
            savePlan: next => {plans.put(next);},
            saveProgress: next => {
              if (!routeId) throw new Error('PLANNING_CONFLICT');
              const record = {projectId, routeId, progressRevision: next.progressRevision, notebookResetRevision: next.notebookResetRevision,
                startedNodeIds: [...next.startedNodeIds], completedNodeIds: [...next.completedNodeIds],
                masteredNodeIds: [...next.masteredNodeIds],
                skippedReasons: Object.fromEntries(next.skippedReasons)};
              if (JSON.stringify(record).length > MAX_PROGRESS_SIZE) throw new Error('PLANNING_TOO_LARGE');
              learning.put(record);
            },
          });
        };
        if (!routeId) {apply(emptyProgress()); return;}
        const record = learning.get([projectId, routeId]);
        record.onsuccess = () => {
          try {apply(record.result ? parseProgress(record.result, MAX_PROGRESS_SIZE) : legacyProgress(projectId, routeId));}
          catch (cause) {abort(cause);}
        };
      } catch (cause) {abort(cause);}
    };
  });
}
