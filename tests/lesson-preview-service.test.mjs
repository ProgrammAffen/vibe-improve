import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

test('lesson previews send only resource identity for saved web and local materials', async t => {
  const {outputFiles} = await build({
    entryPoints: ['apps/local-ui/src/lesson/service.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const moduleURL = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64');
  const {lessonService} = await import(moduleURL);
  const identity = {
    projectId: 'proj_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    routeId: 'route-original',
    nodeId: 'lesson-one',
  };
  const material = {
    id: '11111111-1111-4111-8111-111111111111',
    version: '22222222-2222-4222-8222-222222222222',
    name: 'Saved tutorial',
    format: 'web',
    planning: true,
    removed: false,
    status: 'ready',
    lessonCount: 0,
    segmentCount: 1,
    positions: [{id: 'intro', location: {kind: 'paragraph', start: 1}}],
  };
  const pdf = {...material, id: '33333333-3333-4333-8333-333333333333', name: 'Saved guide.pdf', format: 'pdf'};
  const linkedURL = 'https://example.com/tutorial?view=1#chapter';
  const previewPath = '/vibe-improve/lesson-preview/test-token';
  const nativePreviews = [
    {item: material, response: {url: linkedURL, mimeType: 'text/uri-list', name: material.name}},
    {item: pdf, response: {url: previewPath, mimeType: 'application/pdf', name: pdf.name}},
  ];
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  });
  globalThis.location = new URL('http://127.0.0.1:43129/vibe-improve/');
  globalThis.window = {vibeNative: {projects: {request: async (action, payload) => {
    assert.equal(action, 'lesson.preview');
    const preview = nativePreviews.find(({item}) => item.id === payload.ref.id);
    assert.ok(preview);
    assert.deepEqual(payload, {...identity, ref: {id: preview.item.id, version: preview.item.version}});
    return preview.response;
  }}}};

  assert.deepEqual(await lessonService.preview(identity, material), nativePreviews[0].response);
  assert.deepEqual(await lessonService.preview(identity, pdf), {
    ...nativePreviews[1].response,
    url: location.origin + previewPath,
  });

  nativePreviews[1].response.url = 'https://example.com/guide.pdf';
  await assert.rejects(lessonService.preview(identity, pdf), /LESSON_PREVIEW_UNAVAILABLE/);
});

test('opening an original web link prevents in-app navigation and requests the default browser', async () => {
  const source = await readFile('apps/local-ui/src/lesson/LessonWebPage.tsx', 'utf8');
  const syntax = ts.createSourceFile('LessonWebPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let anchor;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(syntax) === 'a') anchor = node;
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(anchor);
  const attribute = name => anchor.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(syntax) === name);
  assert.equal(attribute('target').initializer.text, '_blank');
  const expression = attribute('onClick').initializer.expression.getText(syntax);
  const clickHandler = new Function('desktop', 'address', 'setOriginalError', 'return ' + expression);
  const url = 'https://example.com/guide?part=1#intro';
  let prevented = false;
  const errorStates = [];
  const open = clickHandler({request: async (action, payload) => {
    assert.equal(action, 'browser.openExternal');
    assert.deepEqual(payload, {url});
  }}, url, value => errorStates.push(value));
  open({preventDefault: () => {prevented = true;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(prevented);
  assert.deepEqual(errorStates, [null]);
  assert.equal(clickHandler(undefined, url, () => {}), undefined);
});
