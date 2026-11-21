import {useState, type ReactNode} from 'react';
import {useEditorState, type Editor} from '@tiptap/react';
import {Bold, Italic, Strikethrough, Underline, List, ListOrdered, Quote, Code, Braces, Undo2, Redo2, Link2, FileCode2, MessageCircle, Download} from 'lucide-react';
import type {Node as ProseMirrorNode} from '@tiptap/pm/model';
import GameSelect from '../components/GameSelect';
import GameButton from '../components/GameButton';
import Modal from '../components/Modal';
import {translate, type Language} from '../i18n';
import {openMathEditor} from './extensions';
import {prepareHTMLImport, safeLink} from './import-content';
import {selectedEditorText} from './RichEditor';
import './rich-editor.css';

export type RichEditorToolbarProps = {editor: Editor | null; language: Language; onQuote?: (text: string) => void; className?: string};
type SourceDraft = {editor: Editor; format: 'markdown' | 'html'; source: string; doc: ProseMirrorNode};
type LinkDraft = {editor: Editor; source: string; from: number; to: number; doc: ProseMirrorNode};

export function RichEditorToolbar({editor, language, onQuote, className = ''}: RichEditorToolbarProps) {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const [source, setSource] = useState<SourceDraft | null>(null);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [error, setError] = useState('');
  const state = useEditorState({editor, selector: ({editor: instance}) => {
    if (!instance || instance.isDestroyed) return null;
    return {
      editable: instance.isEditable,
      heading: instance.isActive('heading', {level: 1}) ? '1' : instance.isActive('heading', {level: 2}) ? '2' : instance.isActive('heading', {level: 3}) ? '3' : 'paragraph',
      bold: instance.isActive('bold'), italic: instance.isActive('italic'), underline: instance.isActive('underline'), strike: instance.isActive('strike'),
      bullet: instance.isActive('bulletList'), ordered: instance.isActive('orderedList'), quote: instance.isActive('blockquote'), code: instance.isActive('codeBlock'),
      link: instance.isActive('link'), undo: instance.can().undo(), redo: instance.can().redo(), selection: selectedEditorText(instance),
    };
  }});
  const disabled = !state?.editable;
  function tool(label: string, icon: ReactNode, action: () => void, active = false, unavailable = disabled) {
    return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={unavailable}
      className="lesson-rich-tool" onMouseDown={event => event.preventDefault()} onClick={action}>{icon}</button>;
  }
  function openSource() {
    if (!editor || editor.isDestroyed) return;
    setError(''); setSource({editor, format: 'markdown', source: editor.getMarkdown(), doc: editor.state.doc});
  }
  function applySource() {
    if (!source || source.editor.isDestroyed) return;
    if (!source.editor.state.doc.eq(source.doc)) {setError(t('内容已改变，请重新打开。', 'The content changed. Open this editor again.')); return;}
    try {
      if (source.format === 'markdown') source.editor.commands.setContent(source.source, {contentType: 'markdown'});
      else {
        const prepared = prepareHTMLImport(source.source, document);
        source.editor.commands.setContent(prepared.content ?? prepared.html!);
      }
      setSource(null); source.editor.commands.focus();
    } catch {setError(t('无法转换，原内容和输入均已保留。', 'Could not convert this content. Both the original and your input were retained.'));}
  }
  function saveLink() {
    if (!link || link.editor.isDestroyed) return;
    if (!link.editor.state.doc.eq(link.doc)) {setError(t('内容已改变，请重新选择文字。', 'The content changed. Select the text again.')); return;}
    const href = safeLink(link.source);
    if (link.source.trim() && !href) {setError(t('请输入 http 或 https 网址。', 'Enter an http or https URL.')); return;}
    const chain = link.editor.chain().focus().setTextSelection({from: link.from, to: link.to}).extendMarkRange('link');
    if (href) chain.setLink({href}).run(); else chain.unsetLink().run();
    setLink(null);
  }
  function downloadMarkdown() {
    if (!source) return;
    const url = URL.createObjectURL(new Blob([source.format === 'markdown' ? source.source : source.editor.getMarkdown()], {type: 'text/markdown;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'notes.md'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <div className={`lesson-rich-toolbar ${className}`} role="toolbar" aria-label={t('文字工具栏', 'Text toolbar')}>
      <GameSelect value={state?.heading ?? 'paragraph'} options={[{value: 'paragraph', label: t('正文', 'Text')}, {value: '1', label: t('标题 1', 'Heading 1')}, {value: '2', label: t('标题 2', 'Heading 2')}, {value: '3', label: t('标题 3', 'Heading 3')}]}
        disabled={disabled} aria-label={t('段落格式', 'Paragraph format')} className="lesson-rich-heading" onChange={value => {if (value === 'paragraph') editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().setHeading({level: Number(value) as 1 | 2 | 3}).run();}}/>
      <span className="lesson-rich-tool-group">
        {tool(t('加粗', 'Bold'), <Bold/>, () => editor?.chain().focus().toggleBold().run(), state?.bold)}
        {tool(t('斜体', 'Italic'), <Italic/>, () => editor?.chain().focus().toggleItalic().run(), state?.italic)}
        {tool(t('下划线', 'Underline'), <Underline/>, () => editor?.chain().focus().toggleUnderline().run(), state?.underline)}
        {tool(t('删除线', 'Strikethrough'), <Strikethrough/>, () => editor?.chain().focus().toggleStrike().run(), state?.strike)}
      </span>
      <span className="lesson-rich-tool-group">
        {tool(t('无序列表', 'Bullet list'), <List/>, () => editor?.chain().focus().toggleBulletList().run(), state?.bullet)}
        {tool(t('有序列表', 'Numbered list'), <ListOrdered/>, () => editor?.chain().focus().toggleOrderedList().run(), state?.ordered)}
        {tool(t('引用', 'Blockquote'), <Quote/>, () => editor?.chain().focus().toggleBlockquote().run(), state?.quote)}
        {tool(t('代码块', 'Code block'), <Code/>, () => editor?.chain().focus().toggleCodeBlock().run(), state?.code)}
      </span>
      <span className="lesson-rich-tool-group">
        {tool(t('添加链接', 'Add link'), <Link2/>, () => {if (editor) {setError(''); setLink({editor, source: editor.getAttributes('link').href ?? '', from: editor.state.selection.from, to: editor.state.selection.to, doc: editor.state.doc});}}, state?.link)}
        {tool(t('公式', 'Formula'), <Braces/>, () => {if (editor) openMathEditor(editor);})}
        {tool(t('Markdown 与 HTML', 'Markdown and HTML'), <FileCode2/>, openSource)}
      </span>
      <span className="lesson-rich-tool-group">
        {tool(t('撤销', 'Undo'), <Undo2/>, () => editor?.chain().focus().undo().run(), false, disabled || !state?.undo)}
        {tool(t('重做', 'Redo'), <Redo2/>, () => editor?.chain().focus().redo().run(), false, disabled || !state?.redo)}
      </span>
      {onQuote && tool(t('针对所选内容提问', 'Ask about selection'), <MessageCircle/>, () => {if (state?.selection) onQuote(state.selection);}, false, disabled || !state?.selection)}
    </div>
    {source && <Modal title={t('编辑源码', 'Edit source')} closeLabel={t('关闭', 'Close')} className="lesson-rich-dialog" explicitClose onClose={() => setSource(null)}>
      <GameSelect value={source.format} aria-label={t('内容格式', 'Content format')} options={[{value: 'markdown', label: 'Markdown'}, {value: 'html', label: 'HTML'}]} onChange={format => {
        if (format === source.format) return;
        // Switching the view must not overwrite edits in the current source field.
        if (source.source !== (source.format === 'markdown' ? source.editor.getMarkdown() : source.editor.getHTML())) {setError(t('请先应用当前修改，或关闭后重新打开。', 'Apply your edits first, or close and reopen this dialog.')); return;}
        setError(''); setSource({...source, format: format as 'markdown' | 'html', source: format === 'markdown' ? source.editor.getMarkdown() : source.editor.getHTML()});
      }}/>
      <textarea className="lesson-rich-source" spellCheck={false} aria-label={source.format} value={source.source} onChange={event => {setError(''); setSource({...source, source: event.target.value});}} onKeyDown={event => event.stopPropagation()}/>
      <p className="lesson-rich-form-error" role="status">{error}</p>
      <div className="lesson-rich-dialog-actions"><GameButton variant="secondary" leadingIcon={<Download/>} onClick={downloadMarkdown}>{t('导出 Markdown', 'Export Markdown')}</GameButton><GameButton onClick={applySource}>{t('应用', 'Apply')}</GameButton></div>
    </Modal>}
    {link && <Modal title={t('链接', 'Link')} closeLabel={t('关闭', 'Close')} className="lesson-rich-dialog" explicitClose onClose={() => setLink(null)}>
      <label className="lesson-rich-field"><span>{t('网址', 'URL')}</span><input type="url" value={link.source} onChange={event => {setError(''); setLink({...link, source: event.target.value});}} placeholder="https://" onKeyDown={event => {event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {event.preventDefault(); saveLink();}}}/></label>
      <p className="lesson-rich-form-error" role="status">{error}</p>
      <div className="lesson-rich-dialog-actions"><GameButton variant="secondary" onClick={() => setLink(null)}>{t('取消', 'Cancel')}</GameButton><GameButton onClick={saveLink}>{t('保存', 'Save')}</GameButton></div>
    </Modal>}
  </>;
}

export default RichEditorToolbar;
