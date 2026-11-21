import {forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {EditorContent, useEditor, type Editor} from '@tiptap/react';
import type {JSONContent} from '@tiptap/core';
import type {Node as ProseMirrorNode} from '@tiptap/pm/model';
import katex from 'katex';
import GameButton from '../components/GameButton';
import GameSelect from '../components/GameSelect';
import Modal from '../components/Modal';
import {translate, type Language} from '../i18n';
import {createRichExtensions, MATH_EDITOR_EVENT, type MathRequest} from './extensions';
import {prepareHTMLImport} from './import-content';
import {editorDocument} from './editor-json';
import 'katex/dist/katex.min.css';
import './rich-editor.css';

export type RichEditorHandle = {
  focus: () => void;
  getEditor: () => Editor | null;
  insertMath: (latex: string, display?: boolean) => boolean;
  getMarkdown: () => string;
  importMarkdown: (source: string, replace?: boolean) => boolean;
  importHTML: (source: string, replace?: boolean) => boolean;
};

export type RichEditorProps = {
  value: JSONContent;
  onChange?: (value: JSONContent) => void;
  language: Language;
  readOnly?: boolean;
  onReady?: (editor: Editor | null) => void;
  onFocus?: (editor: Editor) => void;
  onQuote?: (text: string) => void;
  label?: string;
  className?: string;
};

type MathDraft = MathRequest & {doc: ProseMirrorNode; from: number; to: number};

export function selectedEditorText(editor: Editor) {
  const {from, to} = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n', node => node.attrs.latex ? `$${node.attrs.latex}$` : '').trim();
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  {value, onChange, language, readOnly = false, onReady, onFocus, onQuote, label, className = ''}, ref,
) {
  const callbacks = useRef({onChange, onReady, onFocus, language});
  callbacks.current = {onChange, onReady, onFocus, language};
  const extensions = useMemo(createRichExtensions, []);
  const currentEditor = useRef<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState('');
  const [draft, setDraft] = useState<MathDraft | null>(null);
  const [formula, setFormula] = useState('');
  const [display, setDisplay] = useState(false);
  const [mathError, setMathError] = useState('');
  const t = (zh: string, en: string) => translate(language, zh, en);

  const editor = useEditor({
    extensions,
    content: value,
    editable: !readOnly,
    immediatelyRender: true,
    editorProps: {
      attributes: {class: 'lesson-rich-content', role: 'textbox', 'aria-multiline': 'true'},
      handleKeyDown(_view, event) {
        // Never let an editor Enter bubble into a surrounding chat submit handler.
        // Do not preventDefault: an IME candidate still needs its native confirmation.
        if (event.key === 'Enter' || event.isComposing || event.keyCode === 229) event.stopPropagation();
        return false;
      },
      handlePaste(_view, event) {
        const instance = currentEditor.current;
        const html = event.clipboardData?.getData('text/html');
        if (!instance?.isEditable || !html) return false;
        const prepared = prepareHTMLImport(html, document);
        if (prepared.preservedSource) {
          event.preventDefault();
          instance.commands.insertContent(prepared.content!.content!);
          setNotice(translate(callbacks.current.language, '无法显示的 HTML 已作为源码保留。', 'Unsupported HTML was kept as editable source.'));
          return true;
        }
        event.preventDefault();
        instance.commands.insertContent(prepared.html!, {contentType: 'html'});
        return true;
      },
    },
    onUpdate({editor: instance}) {callbacks.current.onChange?.(editorDocument(instance));},
    onFocus({editor: instance}) {callbacks.current.onFocus?.(instance);},
    onSelectionUpdate({editor: instance}) {setSelection(selectedEditorText(instance));},
  });
  currentEditor.current = editor;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly, false);
    editor.setOptions({editorProps: {...editor.options.editorProps, attributes: {...editor.options.editorProps.attributes as Record<string, string>, 'aria-label': label ?? t('文字与笔记', 'Text and notes'), 'aria-readonly': String(readOnly)}}});
  }, [editor, readOnly, label, language]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || JSON.stringify(value) === JSON.stringify(editor.getJSON())) return;
    try {editor.commands.setContent(value, {emitUpdate: false, errorOnInvalidContent: true});}
    catch {setNotice(t('内容格式无法显示，已保留当前内容。', 'This content format cannot be displayed. The current content was retained.'));}
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    callbacks.current.onReady?.(editor);
    const surface = editor.view.dom;
    const editMath = (event: Event) => {
      if (!editor.isEditable) return;
      const request = (event as CustomEvent<MathRequest>).detail;
      setDraft({...request, doc: editor.state.doc, from: editor.state.selection.from, to: editor.state.selection.to});
      setFormula(request.latex);
      setDisplay(request.display);
      setMathError('');
    };
    surface.addEventListener(MATH_EDITOR_EVENT, editMath);
    return () => {surface.removeEventListener(MATH_EDITOR_EVENT, editMath); callbacks.current.onReady?.(null);};
  }, [editor]);

  useImperativeHandle(ref, () => ({
    focus() {if (editor && !editor.isDestroyed) editor.commands.focus();},
    getEditor() {return editor;},
    insertMath(latex, block = false) {
      return !!editor?.isEditable && !!latex.trim() && editor.chain().focus().insertContent({type: block ? 'blockMath' : 'inlineMath', attrs: {latex}}).run();
    },
    getMarkdown() {return editor?.getMarkdown() ?? '';},
    importMarkdown(source, replace = false) {
      if (!editor?.isEditable) return false;
      return replace ? editor.commands.setContent(source, {contentType: 'markdown'}) : editor.chain().focus().insertContent(source, {contentType: 'markdown'}).run();
    },
    importHTML(source, replace = false) {
      if (!editor?.isEditable) return false;
      const prepared = prepareHTMLImport(source, document);
      const content = prepared.content ?? prepared.html!;
      const result = replace ? editor.commands.setContent(content) : editor.chain().focus().insertContent(typeof content === 'string' ? content : content.content!).run();
      if (prepared.preservedSource) setNotice(t('无法显示的 HTML 已作为源码保留。', 'Unsupported HTML was kept as editable source.'));
      return result;
    },
  }), [editor, language]);

  const preview = useMemo(() => {
    if (!formula.trim()) return {html: '', error: ''};
    try {return {html: katex.renderToString(formula, {displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000}), error: ''};}
    catch {return {html: '', error: translate(language, '公式尚未完成，源码已保留。', 'The formula is incomplete. Its source is retained.')}};
  }, [formula, display, language]);

  function saveMath() {
    if (!editor?.isEditable || !draft || !formula.trim()) return;
    if (!editor.state.doc.eq(draft.doc)) {setMathError(t('内容已改变，请关闭后重新选择公式。', 'The content changed. Close this dialog and select the formula again.')); return;}
    const type = display ? 'blockMath' : 'inlineMath';
    if (draft.position !== undefined) {
      const previous = editor.state.doc.nodeAt(draft.position);
      if (!previous || !['inlineMath', 'blockMath'].includes(previous.type.name) || previous.attrs.latex !== draft.latex) {setMathError(t('公式位置已改变，请重新选择。', 'The formula moved. Select it again.')); return;}
      if (previous.type.name === type) editor.commands.command(({tr}) => {tr.setNodeMarkup(draft.position!, undefined, {...previous.attrs, latex: formula}); return true;});
      else editor.commands.insertContentAt({from: draft.position, to: draft.position + previous.nodeSize}, {type, attrs: {latex: formula}});
    } else editor.commands.insertContentAt({from: draft.from, to: draft.to}, {type, attrs: {latex: formula}});
    setDraft(null);
    editor.commands.focus();
  }

  return <div className={`lesson-rich-editor ${readOnly ? 'lesson-rich-editor--readonly' : ''} ${className}`}>
    <EditorContent editor={editor}/>
    {!readOnly && selection && onQuote && <button type="button" className="lesson-rich-quote" onMouseDown={event => event.preventDefault()} onClick={() => onQuote(selection)}>{t('针对所选内容提问', 'Ask about selection')}</button>}
    {notice && <div className="lesson-rich-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label={t('关闭提示', 'Dismiss notice')}>×</button></div>}
    {draft && <Modal title={t('公式', 'Formula')} closeLabel={t('关闭', 'Close')} onClose={() => setDraft(null)} className="lesson-rich-dialog" explicitClose>
      <GameSelect value={display ? 'block' : 'inline'} onChange={value => setDisplay(value === 'block')} aria-label={t('公式形式', 'Formula layout')} options={[{value: 'inline', label: t('行内公式', 'Inline formula')}, {value: 'block', label: t('独立公式', 'Display formula')}]}/>
      <label className="lesson-rich-field"><span>LaTeX</span><textarea value={formula} onChange={event => {setFormula(event.target.value); setMathError('');}} placeholder="E = mc^2" spellCheck={false} onKeyDown={event => {event.stopPropagation(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {event.preventDefault(); saveMath();}}}/></label>
      <div className="lesson-rich-math-preview" aria-label={t('公式预览', 'Formula preview')}>{preview.html ? <span dangerouslySetInnerHTML={{__html: preview.html}}/> : <span>{preview.error || t('预览', 'Preview')}</span>}</div>
      <p className="lesson-rich-form-error" role="status">{mathError || preview.error}</p>
      <div className="lesson-rich-dialog-actions"><GameButton variant="secondary" onClick={() => setDraft(null)}>{t('取消', 'Cancel')}</GameButton><GameButton onClick={saveMath} disabled={!formula.trim()}>{t('保存公式', 'Save formula')}</GameButton></div>
    </Modal>}
  </div>;
});

export default RichEditor;
