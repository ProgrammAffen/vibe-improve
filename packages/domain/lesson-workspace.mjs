/** Notebook documents contain structured editor JSON, never executable HTML. */
export const LESSON_MAX_BYTES = 2_097_152;
export const LESSON_MAX_BLOCKS = 500;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = (code = 'LESSON_INVALID') => {throw new Error(code);};
const keys = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
};
const string = (value, maximum, empty = true) => {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || value.includes('\0')) fail();
  return value;
};
const integer = (value, maximum = 1_000_000_000) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) fail();
  return value;
};
const identifier = value => {
  string(value, 128, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail();
  return value;
};
const uuid = value => {if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) fail();};
export function validateLessonIdentity(value) {
  keys(value, ['projectId', 'routeId', 'nodeId']);
  if (!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.projectId)) fail();
  identifier(value.routeId); identifier(value.nodeId);
  return {...value};
}
export function lessonURL(value) {
  string(value, 2048, false);
  if (/\s|[\u0000-\u001f\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value)) fail();
  // Kept independent of DOM URL APIs so the same validator runs in JavaScriptCore.
  const match = value.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);
  if (!match || match[1].includes('@') || !/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::\d{1,5})?$/.test(match[1])) fail();
  return value;
}
const boolean = value => {if (typeof value !== 'boolean') fail();};
const containers = new Set(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'taskList', 'taskItem']);
const leaves = new Set(['hardBreak', 'horizontalRule', 'inlineMath', 'blockMath']);
const markNames = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link']);
function editor(value, depth = 0, budget = {nodes: 0}) {
  if (depth > 32 || ++budget.nodes > 20_000) fail('LESSON_TOO_LARGE');
  keys(value, ['type'], ['attrs', 'content', 'marks', 'text']);
  if (!containers.has(value.type) && !leaves.has(value.type) && value.type !== 'text') fail();
  if (depth === 0 && value.type !== 'doc' || depth > 0 && value.type === 'doc') fail();
  if (value.type === 'text') {
    string(value.text, 100_000, false);
    if (value.content !== undefined || value.attrs !== undefined) fail();
  } else if (value.text !== undefined) fail();
  if (value.content !== undefined) {
    if (!containers.has(value.type) || !Array.isArray(value.content)) fail();
    for (const child of value.content) editor(child, depth + 1, budget);
  }
  if (value.attrs !== undefined) {
    if (value.type === 'heading') {keys(value.attrs, ['level']); if (![1, 2, 3, 4, 5, 6].includes(value.attrs.level)) fail();}
    else if (value.type === 'orderedList') {keys(value.attrs, [], ['start', 'type']); if (value.attrs.start != null) integer(value.attrs.start); if (value.attrs.type != null) string(value.attrs.type, 8);}
    else if (value.type === 'taskItem') {keys(value.attrs, ['checked']); boolean(value.attrs.checked);}
    else if (value.type === 'codeBlock') {keys(value.attrs, [], ['language']); if (value.attrs.language != null) string(value.attrs.language, 64);}
    else if (value.type === 'inlineMath' || value.type === 'blockMath') {keys(value.attrs, ['latex']); string(value.attrs.latex, 10_000);}
    else if (!object(value.attrs) || Object.keys(value.attrs).length) fail();
  }
  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks) || value.marks.length > 8) fail();
    for (const mark of value.marks) {
      keys(mark, ['type'], ['attrs']);
      if (!markNames.has(mark.type)) fail();
      if (mark.type === 'link') {
        keys(mark.attrs, ['href'], ['target', 'rel', 'class', 'title']); lessonURL(mark.attrs.href);
        if (mark.attrs.target != null && !['_blank', '_self'].includes(mark.attrs.target)) fail();
        if (mark.attrs.rel != null) string(mark.attrs.rel, 100);
        if (mark.attrs.title != null) string(mark.attrs.title, 500);
        // No arbitrary styling or CSS selectors from pasted/imported documents.
        if (mark.attrs.class != null) fail();
      } else if (mark.attrs !== undefined && (!object(mark.attrs) || Object.keys(mark.attrs).length)) fail();
    }
  }
}
function source(value) {
  keys(value, ['quote'], ['page', 'startMs', 'endMs', 'web']); string(value.quote, 10_000);
  if (value.page !== undefined) {integer(value.page, 1_000_000); if (value.page < 1) fail();}
  if (value.startMs !== undefined) integer(value.startMs);
  if (value.endMs !== undefined) {integer(value.endMs); if (value.startMs === undefined || value.endMs < value.startMs) fail();}
  if (value.web !== undefined) {
    if (value.page !== undefined || value.startMs !== undefined || value.endMs !== undefined) fail();
    keys(value.web, ['url', 'prefix', 'suffix']);
    lessonURL(value.web.url);
    string(value.quote, 1000, false);
    string(value.web.prefix, 120);
    string(value.web.suffix, 120);
  }
}
export function validateLessonWorkspace(input, identity) {
  keys(input, ['schemaVersion', 'projectId', 'routeId', 'nodeId', 'revision', 'blocks']);
  const ownIdentity = validateLessonIdentity({projectId: input.projectId, routeId: input.routeId, nodeId: input.nodeId});
  if (identity && Object.keys(ownIdentity).some(key => ownIdentity[key] !== validateLessonIdentity(identity)[key])) fail('LESSON_CONFLICT');
  if (input.schemaVersion !== 1) fail();
  integer(input.revision);
  if (!Array.isArray(input.blocks) || input.blocks.length > LESSON_MAX_BLOCKS) fail('LESSON_TOO_LARGE');
  const ids = new Set();
  const unique = value => {identifier(value); if (ids.has(value)) fail(); ids.add(value);};
  const blockIds = new Set(input.blocks.map(block => block?.id));
  let records = 0;
  for (const block of input.blocks) {
    keys(block, ['id', 'kind', 'collapsed', 'records'], ['content', 'latex', 'resource', 'url', 'title']);
    unique(block.id); boolean(block.collapsed);
    if (!['text', 'math', 'resource', 'link'].includes(block.kind)) fail();
    if (block.title !== undefined) string(block.title, 500);
    if (block.content !== undefined) {if (block.kind !== 'text') fail(); editor(block.content);}
    if (block.latex !== undefined) {if (block.kind !== 'math') fail(); string(block.latex, 10_000);}
    if (block.resource !== undefined) {if (block.kind !== 'resource') fail(); keys(block.resource, ['id', 'version']); uuid(block.resource.id); uuid(block.resource.version);}
    if (block.kind === 'resource' && !block.resource || block.kind === 'link' && !block.url) fail();
    if (block.url !== undefined) {if (block.kind !== 'link') fail(); lessonURL(block.url);}
    if (!Array.isArray(block.records) || (records += block.records.length) > 2000) fail('LESSON_TOO_LARGE');
    for (const record of block.records) {
      keys(record, ['id', 'kind', 'title', 'messages', 'collapsed'], ['content', 'source', 'references']);
      unique(record.id); boolean(record.collapsed); string(record.title, 500);
      if (!['note', 'question'].includes(record.kind)) fail();
      if (record.content !== undefined) editor(record.content);
      if (record.source !== undefined) source(record.source);
      if (record.references !== undefined) {
        if (!Array.isArray(record.references) || record.references.length > 30) fail();
        for (const reference of record.references) {
          keys(reference, ['blockId', 'source']);
          if (!blockIds.has(reference.blockId)) fail();
          source(reference.source);
        }
      }
      if (!Array.isArray(record.messages) || record.messages.length > 300) fail('LESSON_TOO_LARGE');
      for (const message of record.messages) {
        keys(message, ['id', 'role', 'text'], ['status']); unique(message.id); string(message.text, 100_000);
        if (!['user', 'assistant'].includes(message.role) || message.status !== undefined && !['pending', 'complete', 'incomplete'].includes(message.status)) fail();
      }
    }
  }
  // JSON is copied rather than preserving caller-owned mutable objects.
  const json = JSON.stringify(input);
  // A conservative UTF-8 bound that also works without TextEncoder in JavaScriptCore.
  const size = json.replace(/[\u0080-\u07ff]/g, '..').replace(/[\u0800-\uffff]/g, '...').length;
  if (size > LESSON_MAX_BYTES) fail('LESSON_TOO_LARGE');
  return JSON.parse(json);
}
export function emptyLessonWorkspace(identity) {
  return {...validateLessonIdentity(identity), schemaVersion: 1, revision: 0, blocks: []};
}
export function nextLessonWorkspace(current, identity, expectedRevision, proposed) {
  const previous = validateLessonWorkspace(current, identity);
  integer(expectedRevision);
  const next = validateLessonWorkspace(proposed, identity);
  if (expectedRevision !== previous.revision || next.revision !== expectedRevision) fail('LESSON_CONFLICT');
  return validateLessonWorkspace({...next, revision: previous.revision + 1}, identity);
}
/** A fresh app process retains partial answers but cannot resurrect an old CLI process. */
export function recoverLessonWorkspace(input, identity) {
  const workspace = validateLessonWorkspace(input, identity);
  let changed = false;
  for (const block of workspace.blocks) for (const record of block.records) for (const message of record.messages) {
    if (message.status === 'pending') {message.status = 'incomplete'; changed = true;}
  }
  return changed ? validateLessonWorkspace({...workspace, revision: workspace.revision + 1}, identity) : workspace;
}

/** Explicitly clearing a route's learning history retains only the original material placements. */
export function resetLessonWorkspace(input, identity) {
  const workspace = validateLessonWorkspace(input, identity);
  return validateLessonWorkspace({...workspace, revision: workspace.revision + 1,
    blocks: workspace.blocks.filter(block => block.kind === 'resource' || block.kind === 'link').map(block => ({...block, records: []})),
  }, identity);
}
