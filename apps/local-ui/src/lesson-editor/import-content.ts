import type {JSONContent} from '@tiptap/core';

export type HTMLImport = {html?: string; content?: JSONContent; preservedSource: boolean};

// Unsupported HTML is kept as editable source, rather than silently dropping it
// while ProseMirror converts the document to its registered schema.
const supportedTags = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'STRIKE', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'A', 'SPAN', 'DIV']);
const presentationAttributes = new Set(['style', 'class', 'id', 'dir', 'lang', 'title']);

export function safeLink(value: string): string | null {
  const input = value.trim();
  try {
    const url = new URL(input);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {return null;}
}

export function prepareHTMLImport(source: string, document: Document): HTMLImport {
  const template = document.createElement('template');
  template.innerHTML = source;
  const comments = document.createTreeWalker(template.content, 128 /* SHOW_COMMENT */);
  let unsupported = false;
  while (comments.nextNode()) {
    if (!/^\s*(StartFragment|EndFragment)\s*$/.test(comments.currentNode.textContent ?? '')) unsupported = true;
  }
  for (const element of template.content.querySelectorAll('*')) {
    if (!supportedTags.has(element.tagName)) {unsupported = true; break;}
    for (const attribute of Array.from(element.attributes)) {
      if (presentationAttributes.has(attribute.name)) {element.removeAttribute(attribute.name); continue;}
      if (element.tagName === 'A' && attribute.name === 'href' && safeLink(attribute.value)) continue;
      if (element.tagName === 'OL' && attribute.name === 'start' && /^\d+$/.test(attribute.value)) continue;
      // Math nodes carry their LaTeX source through safe HTML copies.
      if (['SPAN', 'DIV'].includes(element.tagName) && ['data-type', 'data-latex'].includes(attribute.name)) continue;
      if (element.tagName === 'CODE' && attribute.name === 'data-language') continue;
      unsupported = true;
    }
  }
  if (unsupported) return {
    content: {type: 'doc', content: [{type: 'codeBlock', attrs: {language: 'html'}, content: source ? [{type: 'text', text: source}] : undefined}]},
    preservedSource: true,
  };
  return {html: template.innerHTML, preservedSource: false};
}

/** Recognize conventional Markdown delimiters only; escaped dollars stay text. */
export function trailingInlineMath(text: string): {from: number; latex: string} | null {
  if (!text.endsWith('$') || text.endsWith('$$')) return null;
  const closing = text.length - 1;
  if (isEscaped(text, closing)) return null;
  for (let start = closing - 1; start >= 0; start--) {
    if (text[start] === '\n') return null;
    if (text[start] !== '$' || isEscaped(text, start)) continue;
    if (text[start - 1] === '$' || text[start + 1] === '$') return null;
    const latex = text.slice(start + 1, closing);
    return latex.trim() ? {from: start, latex} : null;
  }
  return null;
}

export function completeBlockMath(text: string): string | null {
  const value = text.trim();
  if (!value.startsWith('$$') || !value.endsWith('$$') || value.length <= 4 || value.startsWith('$$$') || value.endsWith('$$$')) return null;
  const latex = value.slice(2, -2).trim();
  return latex && !/(^|[^\\])\$/.test(latex) ? latex : null;
}

function isEscaped(text: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}
