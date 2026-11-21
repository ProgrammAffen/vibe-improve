import type {JSONContent} from '@tiptap/core';
import {MarkdownManager} from '@tiptap/markdown';
import {createRichExtensions} from './extensions';

let manager: MarkdownManager | undefined;

/** JSON is the stored document; Markdown is an import/export and display format. */
export function markdownDocument(source: string): JSONContent {
  manager ??= new MarkdownManager({extensions: createRichExtensions()});
  try {return manager.parse(source);}
  catch {
    // A partial streamed response must remain readable even before its syntax
    // closes. Never discard the response because a rich-text conversion failed.
    return {type: 'doc', content: [{type: 'paragraph', content: source ? [{type: 'text', text: source}] : undefined}]};
  }
}

export function documentMarkdown(document: JSONContent): string {
  manager ??= new MarkdownManager({extensions: createRichExtensions()});
  return manager.serialize(document);
}
