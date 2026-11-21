import {Extension, InputRule, type Editor, type InputRuleMatch, type NodeViewRenderer} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import {InlineMath, BlockMath} from '@tiptap/extension-mathematics';
import {TextSelection} from '@tiptap/pm/state';
import katex from 'katex';
import {completeBlockMath, safeLink, trailingInlineMath} from './import-content';

export const MATH_EDITOR_EVENT = 'lesson-edit-math';
export type MathRequest = {position?: number; latex: string; display: boolean};

export function openMathEditor(editor: Editor, request: MathRequest = {latex: '', display: false}) {
  if (!editor.isDestroyed && editor.isEditable) editor.view.dom.dispatchEvent(new CustomEvent<MathRequest>(MATH_EDITOR_EVENT, {detail: request}));
}

function mathNodeView(editor: Editor, display: boolean): NodeViewRenderer {
  return ({node, getPos}) => {
    const element = document.createElement(display ? 'div' : 'span');
    element.className = 'lesson-rich-math';
    element.dataset.type = display ? 'block-math' : 'inline-math';
    element.dataset.latex = node.attrs.latex;
    const latex = String(node.attrs.latex ?? '');
    element.setAttribute('aria-label', latex);
    if (editor.isEditable) {
      element.tabIndex = 0;
      element.setAttribute('role', 'button');
    }
    try {katex.render(latex, element, {displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000});}
    catch {element.textContent = latex; element.classList.add('lesson-rich-math--invalid');}
    const edit = (event: Event) => {
      if (!editor.isEditable) return;
      event.preventDefault();
      event.stopPropagation();
      const position = getPos();
      if (typeof position === 'number') openMathEditor(editor, {position, latex, display});
    };
    const keydown = (rawEvent: Event) => {
      const event = rawEvent as KeyboardEvent;
      if (!event.isComposing && event.keyCode !== 229 && ['Enter', ' '].includes(event.key)) edit(event);
    };
    element.addEventListener('click', edit);
    element.addEventListener('keydown', keydown);
    return {dom: element, destroy() {element.removeEventListener('click', edit); element.removeEventListener('keydown', keydown);}};
  };
}

const ConventionalInlineMath = InlineMath.extend({
  addInputRules() {
    return [new InputRule({
      find(text): InputRuleMatch | null {
        const match = trailingInlineMath(text);
        return match ? {index: match.from, text: text.slice(match.from), data: {latex: match.latex}} : null;
      },
      handler: ({state, range, match}) => {state.tr.replaceWith(range.from, range.to, this.type.create({latex: match.data?.latex}));},
    })];
  },
  addNodeView() {return mathNodeView(this.editor, false);},
});

const ConventionalBlockMath = BlockMath.extend({
  addInputRules() {
    return [new InputRule({
      find(text): InputRuleMatch | null {
        const latex = completeBlockMath(text);
        return latex ? {index: 0, text, data: {latex}} : null;
      },
      handler: ({state, range, match}) => {
        const $from = state.doc.resolve(range.from);
        if ($from.depth < 1 || !$from.parent.isTextblock || range.from !== $from.start() || range.to !== $from.end()) return null;
        if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)) return null;
        state.tr.replaceWith($from.before(), $from.after(), this.type.create({latex: match.data?.latex}));
      },
    })];
  },
  addKeyboardShortcuts() {return {Enter: () => convertMultilineBlockMath(this.editor)};},
  addNodeView() {return mathNodeView(this.editor, true);},
});

/** Convert $$ on separate paragraph lines when its closing delimiter is confirmed. */
export function convertMultilineBlockMath(editor: Editor): boolean {
  if (editor.view.composing) return false;
  const {selection, doc} = editor.state;
  const {$from} = selection;
  if (!selection.empty || $from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.textContent.trim() !== '$$' || $from.parentOffset !== $from.parent.content.size) return false;
  const last = $from.index(0);
  const lines: string[] = [];
  let first = -1;
  for (let index = last - 1; index >= 0; index--) {
    const node = doc.child(index);
    if (node.type.name !== 'paragraph') break;
    if (node.textContent.trim() === '$$') {first = index; break;}
    lines.unshift(node.textBetween(0, node.content.size, '\n', '\n'));
  }
  if (first < 0 || !lines.join('\n').trim()) return false;
  let start = 0;
  for (let index = 0; index < first; index++) start += doc.child(index).nodeSize;
  const end = $from.after();
  const tr = editor.state.tr.replaceWith(start, end, [
    editor.schema.nodes.blockMath.create({latex: lines.join('\n')}),
    editor.schema.nodes.paragraph.create(),
  ]);
  tr.setSelection(TextSelection.create(tr.doc, start + 2));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const PreserveMarkdownImages = Extension.create({
  name: 'lessonImageSource',
  markdownTokenName: 'image',
  parseMarkdown(token) {return {type: 'text', text: token.raw || `![${token.text || ''}](${token.href || ''})`};},
});

const PreserveMarkdownTables = Extension.create({
  name: 'lessonTableSource',
  markdownTokenName: 'table',
  parseMarkdown(token) {return {type: 'codeBlock', attrs: {language: 'markdown'}, content: [{type: 'text', text: token.raw || ''}]};},
});

const SafeMarkdownLinks = Extension.create({
  name: 'lessonSafeLinks',
  priority: 1100,
  markdownTokenName: 'link',
  parseMarkdown(token, helpers) {
    const href = safeLink(token.href || '');
    if (!href) return {type: 'text', text: token.raw || token.text || ''};
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {href});
  },
});

export function createRichExtensions() {
  return [
    StarterKit.configure({link: {openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['http', 'https'], isAllowedUri: url => /^https?:\/\//i.test(url)}, heading: {levels: [1, 2, 3]}}),
    ConventionalInlineMath,
    ConventionalBlockMath,
    PreserveMarkdownImages,
    PreserveMarkdownTables,
    SafeMarkdownLinks,
    Markdown,
  ];
}
