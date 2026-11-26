import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {build, transform} from 'esbuild';
import ts from 'typescript';
import {emptyLessonWorkspace, validateLessonWorkspace} from '../packages/domain/lesson-workspace.mjs';

const {outputFiles} = await build({
  entryPoints: ['apps/local-ui/src/lesson/web-notes.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const moduleURL = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64');
const {readWebNoteRequest, webNotes, webNoteRecord} = await import(moduleURL);
const id = 'page-1';
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const note = {
  id: 'note-1',
  anchor: {
    url: 'https://example.com/tutorial?language=en#section',
    quote: 'A selected paragraph',
    prefix: 'Before ',
    suffix: ' after',
  },
  text: '**That paragraph** answers the question.',
};
const request = {id, requestId, action: 'save', note};

test('the web note event accepts only valid requests for the mounted resource', () => {
  assert.deepEqual(readWebNoteRequest(request, id), {requestId, action: 'save', note});
  assert.equal(readWebNoteRequest(request, 'page-2'), undefined);
  assert.equal(readWebNoteRequest({...request, note: {...note, text: ' '}}, id), undefined);
  assert.equal(readWebNoteRequest({...request, note: {...note, anchor: {...note.anchor, url: 'file:///notes'}}}, id), undefined);
  assert.equal(readWebNoteRequest({...request, note: {...note, anchor: {...note.anchor, quote: 'x'.repeat(1001)}}}, id), undefined);
});

test('a page note round-trips through the existing lesson document as an attached editable note', () => {
  const record = webNoteRecord(note, 'Page note');
  const identity = {
    projectId: 'proj_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    routeId: 'route-1', nodeId: 'lesson-1',
  };
  const regularNote = {id: 'note-2', kind: 'note', title: 'Regular note', messages: [], collapsed: false};
  const workspace = validateLessonWorkspace({
    ...emptyLessonWorkspace(identity),
    blocks: [{
      id: 'lesson-link', kind: 'link', url: 'https://example.com/tutorial', collapsed: false,
      records: [record, regularNote],
    }],
  }, identity);
  assert.equal(workspace.blocks[0].records[0].collapsed, true);
  assert.deepEqual(webNotes(workspace.blocks[0].records), [note]);

  const edited = {...note, text: 'A follow-up note.'};
  const current = {...record, title: 'Edited in the notebook', collapsed: false};
  assert.strictEqual(webNoteRecord(note, 'Page note', current).content, current.content);
  const updated = webNoteRecord(edited, 'Page note', current);
  assert.deepEqual(webNotes([updated]), [edited]);
  assert.equal(updated.title, current.title);
  assert.equal(updated.collapsed, false);
  assert.deepEqual(updated.source, current.source);
});

test('the notebook acknowledges a page note after its save and rolls back only the failed change', async () => {
  const source = await readFile('apps/local-ui/src/components/NotebookLesson.tsx', 'utf8');
  const syntax = ts.createSourceFile('NotebookLesson.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const notebook = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'NotebookLesson');
  const handler = notebook.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'commitWebNote');
  assert.ok(handler);
  const {code} = await transform(`
    export function harness({store, identity, changeBlock, webNoteRecord}) {
      const alive = {current: true}, finishIdentity = {current: identity}, finishingRequest = {current: null};
      const interactionLocked = false, t = (_zh, en) => en;
      ${handler.getText(syntax)}
      return commitWebNote;
    }
  `, {loader: 'ts', format: 'esm'});
  const {harness} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const blockId = 'link-1';
  const block = {id: blockId, kind: 'link', collapsed: false, records: []};
  const store = {current: {current: {blocks: [block]}}};
  const currentBlock = () => store.current.current.blocks[0];
  let generation = 0;
  const changeBlock = (id, change) => {
    assert.equal(id, blockId);
    store.current.current = {blocks: [change(currentBlock())]};
    return ++generation;
  };
  const commit = harness({store, identity: {}, changeBlock, webNoteRecord});
  let resolve, acknowledged = false;
  store.flushUpdate = version => {
    assert.equal(version, 1);
    return new Promise(done => { resolve = done; });
  };
  const save = commit(blockId, 'save', note).then(ok => { acknowledged = true; return ok; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.deepEqual(webNotes(currentBlock().records), [note]);
  const otherRecord = {id: 'later-note'};
  changeBlock(blockId, value => ({...value, records: [...value.records, otherRecord]}));
  resolve(false);
  assert.equal(await save, false);
  assert.deepEqual(currentBlock().records, [otherRecord]);

  store.flushUpdate = async () => true;
  assert.equal(await commit(blockId, 'save', note), true);
  store.flushUpdate = async () => false;
  assert.equal(await commit(blockId, 'delete', note), false);
  assert.deepEqual(webNotes(currentBlock().records), [note]);
  store.flushUpdate = async () => true;
  assert.equal(await commit(blockId, 'delete', note), true);
  assert.deepEqual(currentBlock().records, [otherRecord]);
});
