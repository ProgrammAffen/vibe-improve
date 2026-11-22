import {MAX_ROUTE_NODES} from '../../../../packages/domain/route-validation.mjs';

export const MAX_SKIP_REASON_LENGTH = 240;
export const MAX_PROGRESS_SIZE = 8_388_608;
export const MAX_PROGRESS_REVISION = 999_999_999;

export type LearningProgress = {
  progressRevision: number;
  notebookResetRevision: number;
  recordedNodeCount: number;
  startedNodeIds: Set<string>;
  completedNodeIds: Set<string>;
  skippedReasons: Map<string, string>;
};

export function emptyProgress(progressRevision = 0): LearningProgress {
  return {progressRevision, notebookResetRevision: 0, recordedNodeCount: 0, startedNodeIds: new Set(), completedNodeIds: new Set(), skippedReasons: new Map()};
}

export function recordedNodes(progress: LearningProgress): Set<string> {
  return new Set([...progress.startedNodeIds, ...progress.completedNodeIds, ...progress.skippedReasons.keys()]);
}

export function prerequisiteMet(progress: LearningProgress, nodeId: string): boolean {
  return progress.completedNodeIds.has(nodeId) || progress.skippedReasons.has(nodeId);
}

export function parseProgress(value: unknown, max = MAX_ROUTE_NODES): LearningProgress {
  if (!value || typeof value !== 'object') throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  const {completedNodeIds, startedNodeIds = [], skippedReasons = {}, progressRevision = 0, notebookResetRevision = 0, recordedNodeCount} = value as Record<string, unknown>;
  const ids = (items: unknown): items is string[] => Array.isArray(items) && items.length <= max
    && items.every((id: unknown) => typeof id === 'string');
  if (!ids(completedNodeIds) || !ids(startedNodeIds)
      || !skippedReasons || typeof skippedReasons !== 'object' || Array.isArray(skippedReasons)
      || typeof progressRevision !== 'number' || !Number.isSafeInteger(progressRevision)
      || progressRevision < 0 || progressRevision > MAX_PROGRESS_REVISION
      || typeof notebookResetRevision !== 'number' || !Number.isSafeInteger(notebookResetRevision)
      || notebookResetRevision < 0 || notebookResetRevision > progressRevision) {
    throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  }
  const skipped = Object.entries(skippedReasons);
  // The key records the skipped state. Empty values are new no-reason skips;
  // retain nonempty legacy values without inventing an explanation.
  if (skipped.length > max || !skipped.every(([, reason]) => typeof reason === 'string'
      && reason.length <= MAX_SKIP_REASON_LENGTH)) throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  const result = {
    progressRevision, notebookResetRevision, recordedNodeCount: 0, startedNodeIds: new Set([...startedNodeIds, ...completedNodeIds]),
    completedNodeIds: new Set(completedNodeIds), skippedReasons: new Map<string, string>(skipped),
  };
  const count = recordedNodes(result).size;
  if (recordedNodeCount !== undefined && (typeof recordedNodeCount !== 'number' || !Number.isSafeInteger(recordedNodeCount)
      || recordedNodeCount < count || recordedNodeCount > MAX_PROGRESS_SIZE)) throw new Error('PLANNING_STORAGE_UNAVAILABLE');
  result.recordedNodeCount = typeof recordedNodeCount === 'number' ? recordedNodeCount : count;
  return result;
}

export function currentProgress(history: LearningProgress, ids: Set<string>): LearningProgress {
  return {
    progressRevision: history.progressRevision,
    notebookResetRevision: history.notebookResetRevision,
    recordedNodeCount: history.recordedNodeCount,
    startedNodeIds: new Set([...history.startedNodeIds].filter(id => ids.has(id))),
    completedNodeIds: new Set([...history.completedNodeIds].filter(id => ids.has(id))),
    skippedReasons: new Map([...history.skippedReasons].filter(([id]) => ids.has(id) && !history.completedNodeIds.has(id))),
  };
}
