import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {Editor, inputRulesPlugin} from '@tiptap/core';
import {emptyLessonWorkspace, validateLessonWorkspace} from '../../../../packages/domain/lesson-workspace.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const output = path.join(root, 'tmp/checks/lesson-editor-tests');
await mkdir(output, {recursive: true});
await build({entryPoints: [path.join(directory, 'extensions.ts'), path.join(directory, 'markdown.ts'), path.join(directory, 'import-content.ts'), path.join(directory, 'editor-json.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', outdir: output, logLevel: 'silent'});
const {createRichExtensions, convertMultilineBlockMath} = await import(pathToFileURL(path.join(output, 'extensions.js')));
const {markdownDocument, documentMarkdown} = await import(pathToFileURL(path.join(output, 'markdown.js')));
const {safeLink, trailingInlineMath, completeBlockMath} = await import(pathToFileURL(path.join(output, 'import-content.js')));
const {editorDocument} = await import(pathToFileURL(path.join(output, 'editor-json.js')));

function headless(content) {return new Editor({element: null, extensions: createRichExtensions(), content});}
function mathNodes(node, result = []) {
  if (['inlineMath', 'blockMath'].includes(node.type)) result.push({type: node.type, latex: node.attrs.latex});
  for (const child of node.content ?? []) mathNodes(child, result);
  return result;
}
function allText(node) {return [node.text ?? '', ...(node.content ?? []).map(allText)].join('');}
function typing(editor, text) {
  const rules = editor.extensionManager.extensions.filter(extension => ['inlineMath', 'blockMath'].includes(extension.name)).flatMap(extension => extension.config.addInputRules.call({type: editor.schema.nodes[extension.name]}));
  const plugin = inputRulesPlugin({editor, rules});
  for (const character of text) {
    const {from, to} = editor.state.selection;
    const handled = plugin.props.handleTextInput.call(plugin, editor.view, from, to, character, () => {});
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}

test('Markdown imports and exports both conventional math delimiters without losing LaTeX', () => {
  const source = 'A **bold** statement with $E=mc^2$.\n\n$$\n\\frac{1}{2} + x\n$$';
  const parsed = markdownDocument(source);
  assert.deepEqual(mathNodes(parsed), [{type: 'inlineMath', latex: 'E=mc^2'}, {type: 'blockMath', latex: '\\frac{1}{2} + x'}]);
  assert.deepEqual(mathNodes(markdownDocument(documentMarkdown(parsed))), mathNodes(parsed));
  assert.match(documentMarkdown(parsed), /\*\*bold\*\*/);
});

test('typing $…$ inserts inline math, preserves neighboring text and matches Markdown import', () => {
  const editor = headless({type: 'doc', content: [{type: 'paragraph'}]});
  typing(editor, 'Before $x^2$ after');
  assert.deepEqual(mathNodes(editor.getJSON()), mathNodes(markdownDocument('Before $x^2$ after')));
  assert.equal(editor.state.doc.textContent, 'Before  after');
  editor.destroy();
});

test('typing $$…$$ creates a display node rather than the official double-dollar inline rule', () => {
  const editor = headless({type: 'doc', content: [{type: 'paragraph'}]});
  typing(editor, '$$x^2$$');
  assert.deepEqual(mathNodes(editor.getJSON()), [{type: 'blockMath', latex: 'x^2'}]);
  assert.equal(editor.state.doc.firstChild.type.name, 'blockMath');
  editor.destroy();
});

test('escaped dollars and code context do not become math', () => {
  assert.equal(trailingInlineMath('a \\$x$'), null);
  assert.equal(trailingInlineMath('a $x\\$'), null);
  assert.equal(completeBlockMath('$$$x$$$'), null);
  const editor = headless({type: 'doc', content: [{type: 'codeBlock'}]});
  typing(editor, '$x$');
  assert.deepEqual(mathNodes(editor.getJSON()), []);
  assert.equal(editor.state.doc.textContent, '$x$');
  editor.destroy();
});

test('multiline display math replaces only its delimiters and leaves a fresh editable paragraph', () => {
  const paragraphs = ['before', '$$', '\\begin{aligned}', 'x &= 1 \\\\', 'y &= 2', '\\end{aligned}', '$$', 'after'];
  const editor = headless({type: 'doc', content: paragraphs.map(text => ({type: 'paragraph', content: [{type: 'text', text}]}))});
  const closingEnd = paragraphs.slice(0, 7).reduce((sum, text) => sum + text.length + 2, 0) - 1;
  editor.commands.setTextSelection(closingEnd);
  assert.equal(convertMultilineBlockMath(editor), true);
  assert.equal(editor.state.doc.child(0).textContent, 'before');
  assert.equal(editor.state.doc.child(1).type.name, 'blockMath');
  assert.equal(editor.state.doc.child(1).attrs.latex, paragraphs.slice(2, 6).join('\n'));
  assert.equal(editor.state.doc.child(2).type.name, 'paragraph');
  assert.equal(editor.state.doc.lastChild.textContent, 'after');
  assert.equal(editor.state.selection.$from.parent.type.name, 'paragraph');
  editor.destroy();
});

test('unsupported Markdown images and tables retain their full editable source', () => {
  const image = '![Diagram](https://example.org/image.png)';
  const table = '| one | two |\n| --- | --- |\n| alpha | beta |';
  const parsed = markdownDocument(`${image}\n\n${table}`);
  assert.match(allText(parsed), /!\[Diagram\]\(https:\/\/example\.org\/image\.png\)/);
  assert.match(allText(parsed), /alpha \| beta/);
  const editor = headless(parsed);
  assert.match(allText(editor.getJSON()), /alpha \| beta/);
  editor.destroy();
});

test('incomplete streamed Markdown and unsafe HTML are retained without a raw executable node', () => {
  const source = 'An unfinished **thought with $x and <script>alert(1)</script>';
  const parsed = markdownDocument(source);
  const editor = headless(parsed);
  assert.match(editor.state.doc.textContent, /unfinished/);
  assert.match(editor.state.doc.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(JSON.stringify(parsed).includes('"type":"script"'), false);
  editor.destroy();
});

test('links reject executable and embedded data protocols', () => {
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('data:text/html,<script>hi</script>'), null);
  assert.equal(safeLink('https://example.org/path'), 'https://example.org/path');
  assert.equal(safeLink('mailto:learner@example.org'), null);
  assert.equal(safeLink('https://user:password@example.org'), null);
  const source = '[unsafe](javascript:alert(1)) [mail](mailto:learner@example.org)';
  const parsed = markdownDocument(source);
  assert.equal(JSON.stringify(parsed).includes('"type":"link"'), false);
  assert.match(allText(parsed), /mailto:learner@example.org/);
});

test('AI Markdown can be saved directly as a note before an editor has normalized its attributes', () => {
  const identity = {projectId: 'proj_11111111-1111-4111-8111-111111111111', routeId: 'route_1', nodeId: 'node_1'};
  const workspace = emptyLessonWorkspace(identity);
  workspace.blocks.push({id: 'text_1', kind: 'text', collapsed: false, content: {type: 'doc', content: [{type: 'paragraph'}]}, records: [{id: 'note_1', kind: 'note', title: 'Saved reply', collapsed: false, messages: [], content: markdownDocument('Read the [official guide](https://example.org "Guide") and solve $x^2=4$.')}]});
  assert.doesNotThrow(() => validateLessonWorkspace(workspace, identity));
});

test('a real Tiptap formula edit emits standard JSON that the workspace can persist', () => {
  const identity = {projectId: 'proj_11111111-1111-4111-8111-111111111111', routeId: 'route_1', nodeId: 'node_1'};
  const editor = headless(markdownDocument('Inline $x$ and [a guide](https://example.org).\n\n$$y=1$$'));
  let changed;
  editor.on('update', () => {changed = editorDocument(editor);});
  let position;
  editor.state.doc.descendants((node, pos) => {if (node.type.name === 'blockMath') position = pos;});
  assert.equal(editor.commands.updateBlockMath({pos: position, latex: 'y=2'}), true);
  assert.equal(Object.getPrototypeOf(editor.getJSON().content.find(node => node.type === 'blockMath').attrs), null);
  const workspace = emptyLessonWorkspace(identity);
  workspace.blocks.push({id: 'text_1', kind: 'text', collapsed: false, content: changed, records: []});
  const saved = validateLessonWorkspace(workspace, identity);
  assert.equal(saved.blocks[0].content.content.find(node => node.type === 'blockMath').attrs.latex, 'y=2');
  assert.equal(Object.getPrototypeOf(changed.content.find(node => node.type === 'blockMath').attrs), Object.prototype);
  editor.destroy();
});
