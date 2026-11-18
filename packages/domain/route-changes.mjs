import {assessmentAnswer} from './assessment.mjs';
import {generationRouteHash} from './planning-generation-draft.mjs';
export const routeEditHash = route => generationRouteHash({...route, revision: 0});

const texts = value => (Array.isArray(value) ? value : value == null ? [] : [String(value)]).filter(value => value.trim());
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const indexed = route => {
  const chapters = new Map(), nodes = new Map();
  route?.chapters.forEach((chapter, ci) => {
    chapters.set(chapter.id, {chapter, number: String(ci + 1)});
    chapter.nodes.forEach((node, ni) => nodes.set(node.id, {node, chapter, number: `${ci + 1}.${ni + 1}`}));
  });
  return {chapters, nodes};
};

export function routeChanges(before, after, locale = 'zh-CN') {
  const old = indexed(before), next = indexed(after), changes = [];
  const fields = pairs => pairs.flatMap(([key, a, b]) => {
    const previous = texts(a), proposed = texts(b);
    return equal(previous, proposed) ? [] : [{key, before: previous, after: proposed}];
  });
  const title = fields([['title', before?.title, after?.title]]);
  if (title.length) changes.push({kind: 'route', title: after?.title ?? before.title, number: '', status: 'changed', fields: title});
  for (const id of new Set([...old.chapters.keys(), ...next.chapters.keys()])) {
    const a = old.chapters.get(id), b = next.chapters.get(id);
    const changed = fields([['title', a?.chapter.title, b?.chapter.title], ['stageGoal', a?.chapter.stageGoal, b?.chapter.stageGoal], ['position', a?.number, b?.number]]);
    if (changed.length) changes.push({kind: 'chapter', id, title: (b ?? a).chapter.title, number: (b ?? a).number, status: !a ? 'added' : !b ? 'removed' : 'changed', fields: changed});
  }
  const data = (item, index) => {
    if (!item) return {};
    const node = item.node;
    return {title: node.title, position: item.number, objectives: node.objectives.map(o => o.description),
      estimatedMinutes: node.estimatedMinutes, requirement: node.requirement ?? 'required',
      prerequisites: node.prerequisites.map(id => {const source=index.nodes.get(id);return source?`${source.number} ${source.node.title}`:id}), activities: node.activities,
      quiz: node.assessment?.task, answer: node.assessment ? assessmentAnswer(node.assessment, locale) : undefined,
      reviewEnabled: node.review ? 'on' : 'off', reviewContent: node.review?.content, reviewCriteria: node.review?.passCriteria};
  };
  for (const id of new Set([...old.nodes.keys(), ...next.nodes.keys()])) {
    const a = old.nodes.get(id), b = next.nodes.get(id), first = data(a, old), second = data(b, next);
    const changed = fields([...new Set([...Object.keys(first), ...Object.keys(second)])].map(key => [key, first[key], second[key]]));
    if (changed.length) changes.push({kind: 'lesson', id, chapterId: (b ?? a).chapter.id, title: (b ?? a).node.title,
      number: (b ?? a).number, status: !a ? 'added' : !b ? 'removed' : 'changed', fields: changed});
  }
  return changes;
}

export function messageEditRoutes(state, message) {
  const edit = message.routeEdit;
  if (!edit) return null;
  const routes = [state.routeDraft, state.undoRoute, ...(state.history?.past ?? []), ...(state.history?.future ?? [])].filter(Boolean);
  const find = (revision, hash) => routes.find(route => route.id === edit.routeId && (hash ? routeEditHash(route) === hash : route.revision === revision));
  const pending = state.proposal?.baseRevision === edit.requestRevision ? state.proposal : undefined;
  return {before: find(edit.beforeRevision,edit.beforeHash), after: pending?.route ?? find(edit.afterRevision,edit.afterHash),
    status: pending ? 'pending' : edit.afterRevision ? 'applied' : 'not-applied'};
}
