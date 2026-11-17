const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value);
const shape = (value, keys, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));

export function validResourceSelection(ref) {
  return shape(ref, ['id', 'version']) && uuid(ref.id) && uuid(ref.version);
}

export function validResourceSnapshot(snapshot) {
  return shape(snapshot, ['provider', 'items']) && token(snapshot.provider) && Array.isArray(snapshot.items) &&
    snapshot.items.length > 0 && snapshot.items.length <= 40 && snapshot.items.every(validResourceSelection) &&
    new Set(snapshot.items.map(item => item.id)).size === snapshot.items.length;
}

export function validMaterialLink(link) {
  return shape(link, ['id', 'version', 'kind', 'targetId', 'origin'], ['segmentId']) &&
    uuid(link.id) && uuid(link.version) && ['chapter', 'lesson'].includes(link.kind) && token(link.targetId) &&
    ['ai', 'editor'].includes(link.origin) && (link.segmentId === undefined || typeof link.segmentId === 'string' && /^s[1-9][0-9]{0,4}$/.test(link.segmentId)) &&
    (link.origin !== 'ai' || link.segmentId !== undefined);
}

export function materialKey(link) {
  return JSON.stringify([link.kind, link.targetId, link.id, link.version, link.segmentId ?? null]);
}

export function validRouteMaterials(sets) {
  return Array.isArray(sets) && sets.length <= 22 &&
    new Set(sets.map(set => set?.routeId)).size === sets.length && sets.every(set =>
      shape(set, ['routeId', 'links']) && token(set.routeId) && Array.isArray(set.links) && set.links.length <= 1024 &&
      set.links.every(validMaterialLink) && new Set(set.links.map(materialKey)).size === set.links.length);
}

export function retainRouteMaterials(state) {
  if (!state.routeMaterials) return;
  const routes = [state.routeDraft, state.undoRoute, ...(state.history?.past ?? []), ...(state.history?.future ?? [])];
  const ids = new Set(routes.map(route => route?.id));
  state.routeMaterials = state.routeMaterials.filter(entry => ids.has(entry.routeId) && entry.links.length);
  if (!state.routeMaterials.length) delete state.routeMaterials;
}

export function materialTargetExists(route, {kind, targetId}) {
  return route.chapters.some(chapter => kind === 'chapter' ? chapter.id === targetId : chapter.nodes.some(node => node.id === targetId));
}
