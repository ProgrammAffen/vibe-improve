import type {Editor, JSONContent} from '@tiptap/core';

/** ProseMirror attrs use null prototypes; persisted JSON uses ordinary objects. */
export function editorDocument(editor: Pick<Editor, 'getJSON'>): JSONContent {
  return JSON.parse(JSON.stringify(editor.getJSON())) as JSONContent;
}
