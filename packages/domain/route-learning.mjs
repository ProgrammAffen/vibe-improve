export const isRequiredLesson = node => node.requirement !== 'optional';

// Elective lessons do not gate progress; their required foundations still do.
export function learningPrerequisiteIds(route, nodeId) {
  const nodes = new Map(route.chapters.flatMap(chapter => chapter.nodes.map(node => [node.id, node])));
  const required = new Set(), visited = new Set([nodeId]);
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.get(id);
    if (!node || isRequiredLesson(node)) required.add(id);
    else node.prerequisites.forEach(visit);
  }
  nodes.get(nodeId)?.prerequisites.forEach(visit);
  return [...required];
}

export function learningProgressSummary(nodes, completedNodeIds) {
  const required = nodes.filter(isRequiredLesson);
  const tracked = required.length ? required : nodes;
  return {total: tracked.length, completed: tracked.filter(node => completedNodeIds.has(node.id)).length, optionalOnly: nodes.length > 0 && required.length === 0};
}
