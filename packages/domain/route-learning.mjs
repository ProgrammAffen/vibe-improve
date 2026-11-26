export const isRequiredLesson = node => node.requirement !== 'optional';

export function learningPrerequisiteIds(route, nodeId) {
  for (const chapter of route.chapters) {
    const node = chapter.nodes.find(item => item.id === nodeId);
    if (node) return [...node.prerequisites];
  }
  return [];
}

export function learningProgressSummary(nodes, completedNodeIds, masteredNodeIds) {
  const required = nodes.filter(isRequiredLesson);
  const tracked = required.length ? required : nodes;
  return {
    total: tracked.length,
    completed: tracked.filter(node => completedNodeIds.has(node.id) || masteredNodeIds?.has(node.id)).length,
    optionalOnly: nodes.length > 0 && required.length === 0,
  };
}
