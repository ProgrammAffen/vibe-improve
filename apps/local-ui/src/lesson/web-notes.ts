import {lessonURL} from '../../../../packages/domain/lesson-workspace.mjs';
import {documentMarkdown, markdownDocument} from '../lesson-editor/markdown';
import type {LessonRecord} from './types';

export type WebNote = {
  id: string;
  anchor: {url: string; quote: string; prefix: string; suffix: string};
  text: string;
};
export type WebNoteAction = 'save' | 'delete';
export type WebAnnotations = {
  records: readonly LessonRecord[];
  commit: (action: WebNoteAction, note: WebNote) => Promise<boolean>;
};

export function readWebNoteRequest(detail: unknown, id: string): {requestId: string; action: WebNoteAction; note: WebNote} | undefined {
  if (!detail || typeof detail !== 'object' || !('id' in detail) || detail.id !== id
    || !('requestId' in detail) || typeof detail.requestId !== 'string'
    || !/^[a-f0-9-]{36}$/i.test(detail.requestId)
    || !('action' in detail) || (detail.action !== 'save' && detail.action !== 'delete')
    || !('note' in detail) || !detail.note || typeof detail.note !== 'object') return;
  const note = detail.note as Partial<WebNote>;
  const anchor = note.anchor;
  if (typeof note.id !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(note.id)
    || typeof note.text !== 'string' || note.text.length > 100_000 || note.text.includes('\0')
    || (detail.action === 'save' && !note.text.trim())
    || !anchor || typeof anchor.url !== 'string'
    || typeof anchor.quote !== 'string' || !anchor.quote.trim() || anchor.quote.length > 1000 || anchor.quote.includes('\0')
    || typeof anchor.prefix !== 'string' || anchor.prefix.length > 120 || anchor.prefix.includes('\0')
    || typeof anchor.suffix !== 'string' || anchor.suffix.length > 120 || anchor.suffix.includes('\0')) return;
  try { lessonURL(anchor.url); } catch { return; }
  return {
    requestId: detail.requestId,
    action: detail.action,
    note: {
      id: note.id,
      anchor: {url: anchor.url, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix},
      text: note.text,
    },
  };
}

export function webNotes(records: readonly LessonRecord[]): WebNote[] {
  return records.flatMap(record => {
    const source = record.source;
    if (record.kind !== 'note' || !source?.web) return [];
    const text = record.content ? documentMarkdown(record.content) : '';
    if (text.length > 100_000) return [];
    return [{id: record.id, anchor: {...source.web, quote: source.quote}, text}];
  });
}

export function webNoteRecord(note: WebNote, title: string, existing?: LessonRecord): LessonRecord {
  const {quote, ...web} = note.anchor;
  return {
    ...(existing ?? {id: note.id, kind: 'note', title, collapsed: true, messages: []}),
    source: existing?.source ?? {quote, web},
    content: existing?.content && documentMarkdown(existing.content) === note.text
      ? existing.content : markdownDocument(note.text),
  };
}
