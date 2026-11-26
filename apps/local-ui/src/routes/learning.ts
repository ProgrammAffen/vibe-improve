import type {PlanningState} from '../../../../packages/domain/planning.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import {learningPrerequisiteIds} from '../../../../packages/domain/route-learning.mjs';
import {browserProjectTransaction, legacyProgressKey, withProjectLock} from '../planning/browser-store';
import {currentProgress, emptyProgress, MAX_PROGRESS_REVISION, MAX_SKIP_REASON_LENGTH, parseProgress, prerequisiteMet, recordedNodes, type LearningProgress} from './learning-record';

export {MAX_SKIP_REASON_LENGTH, prerequisiteMet, type LearningProgress} from './learning-record';

type LearningChange =
  | {kind: 'start' | 'complete' | 'master'; nodeId: string; progressRevision: number}
  | {kind: 'skip'; nodeId: string; reason: string; progressRevision: number}
  | {kind: 'reset'; progressRevision: number};

export function confirmedRoute(state: PlanningState | null): RouteDocument | null {
  const route = state?.routeDraft;
  return route && state.confirmedRevision === route.revision ? route : null;
}

function nextProgressRevision(revision: number): number {
  if (revision >= MAX_PROGRESS_REVISION) throw new Error('PLANNING_LIMIT');
  return revision + 1;
}

async function progress(projectId: string, route: RouteDocument, change?: LearningChange): Promise<LearningProgress> {
  const native = window.vibeNative?.projects;
  if (native) {
    const ids = new Set(route.chapters.flatMap(chapter => chapter.nodes.map(node => node.id)));
    const identity = {projectId, routeId: route.id, routeRevision: route.revision};
    if (!change) return currentProgress(parseProgress(await native.request('planning.learning.read', identity)), ids);
    const {kind, ...details} = change;
    return currentProgress(parseProgress(await native.request(`planning.learning.${kind}`, {...identity, ...details})), ids);
  }

  return withProjectLock(projectId, async () => {
    const result = await browserProjectTransaction(projectId, ({state, progress: history, saveProgress}) => {
      const current = state?.routeDraft;
      if (!state || current?.id !== route.id || current.revision !== route.revision) throw new Error('PLANNING_CONFLICT');
      const nodes = current.chapters.flatMap(chapter => chapter.nodes);
      const ids = new Set(nodes.map(node => node.id));
      if (!change) return currentProgress(history, ids);
      if (change.progressRevision !== history.progressRevision) throw new Error('PLANNING_CONFLICT');
      if (change.kind === 'reset') {
        if (state.pending) throw new Error('PLANNING_CONFLICT');
        const reset = emptyProgress(nextProgressRevision(history.progressRevision));
        reset.notebookResetRevision = reset.progressRevision;
        saveProgress(reset);
        return reset;
      }
      if (state.confirmedRevision !== route.revision) throw new Error('PLANNING_CONFLICT');
      const node = nodes.find(item => item.id === change.nodeId);
      const completed = history.completedNodeIds.has(change.nodeId);
      const mastered = history.masteredNodeIds.has(change.nodeId);
      if (!node || (!completed && !mastered && learningPrerequisiteIds(current, node.id).some(id => !prerequisiteMet(history, id)))) {
        throw new Error('PLANNING_CONFLICT');
      }
      switch (change.kind) {
        case 'skip': {
          const reason = change.reason.trim();
          if (reason.length > MAX_SKIP_REASON_LENGTH) throw new Error('PLANNING_INVALID');
          if (completed || mastered) throw new Error('PLANNING_CONFLICT');
          if (history.skippedReasons.has(node.id)) return currentProgress(history, ids);
          history.skippedReasons.set(node.id, reason);
          break;
        }
        case 'start':
          if (history.startedNodeIds.has(node.id)) return currentProgress(history, ids);
          history.startedNodeIds.add(node.id);
          break;
        case 'master': {
          if (completed) return currentProgress(history, ids);
          const wasSkipped = history.skippedReasons.delete(node.id);
          if (mastered && !wasSkipped) return currentProgress(history, ids);
          history.masteredNodeIds.add(node.id);
          break;
        }
        case 'complete':
          if (completed && !history.skippedReasons.has(node.id)) return currentProgress(history, ids);
          if (!history.startedNodeIds.has(node.id)) throw new Error('PLANNING_CONFLICT');
          history.completedNodeIds.add(node.id);
          history.masteredNodeIds.delete(node.id);
          history.skippedReasons.delete(node.id);
          break;
      }
      history.progressRevision = nextProgressRevision(history.progressRevision);
      history.recordedNodeCount = recordedNodes(history).size;
      saveProgress(history);
      return currentProgress(history, ids);
    });
    if (change?.kind === 'reset') {
      try {localStorage.removeItem(legacyProgressKey(projectId, route.id));} catch { /* The stored reset supersedes the legacy value. */ }
    }
    return result;
  });
}

export const learningService = {
  read: (projectId: string, route: RouteDocument) => progress(projectId, route),
  start: (projectId: string, route: RouteDocument, nodeId: string, progressRevision: number) => progress(projectId, route, {kind: 'start', nodeId, progressRevision}),
  complete: (projectId: string, route: RouteDocument, nodeId: string, progressRevision: number) => progress(projectId, route, {kind: 'complete', nodeId, progressRevision}),
  master: (projectId: string, route: RouteDocument, nodeId: string, progressRevision: number) => progress(projectId, route, {kind: 'master', nodeId, progressRevision}),
  skip: (projectId: string, route: RouteDocument, nodeId: string, reason: string, progressRevision: number) => progress(projectId, route, {kind: 'skip', nodeId, reason, progressRevision}),
  reset: (projectId: string, route: RouteDocument, progressRevision: number) => progress(projectId, route, {kind: 'reset', progressRevision}),
};
