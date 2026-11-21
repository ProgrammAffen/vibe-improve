import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  GripVertical,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Plus,
  Send,
  Settings2,
  Square,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type {
  RouteChapter,
  RouteNode,
} from "../../../../packages/domain/route-validation.mjs";
import type {
  AgentOptions,
  PlanningState,
} from "../../../../packages/domain/planning.mjs";
import { translate, type Language } from "../i18n";
import { PROVIDERS, type ProviderId } from "../agents/domain";
import { planningService } from "../planning/service";
import { createImeGuard } from "../planning/input";
import {
  resourceKey,
  resourceService,
  timecode,
  useResourceBindings,
  useResourceList,
  type ResourceItem,
} from "../resources/service";
import {
  RichEditor,
  RichEditorToolbar,
  markdownDocument,
} from "../lesson-editor";
import LessonResource from "../lesson/LessonResource";
import { useLessonWorkspace } from "../lesson/useLessonWorkspace";
import {
  lessonAgent,
  lessonAgentMessage,
  watchLessonAgent,
} from "../lesson/agent";
import type {
  LessonBlock,
  LessonIdentity,
  LessonMessage,
  LessonRecord,
  LessonSource,
} from "../lesson/types";
import GameButton from "./GameButton";
import Modal from "./Modal";
import LegacyLessonContent from "./LegacyLessonContent";
import ResourceDialog from "./ResourceDialog";
import { ResourcePicker, attachmentsFrom } from "./ResourceAttachments";
import PlanningModelControls, {
  PlanningAgentControl,
} from "./PlanningModelControls";
import "./lesson-page.css";

type Props = {
  chapter: RouteChapter;
  node: RouteNode;
  language: Language;
  projectId?: string;
  routeId?: string;
  completed: boolean;
  busy: boolean;
  error: string;
  onComplete: () => void | Promise<void>;
  onMap: () => void;
  onHome: () => void;
};
const uid = () => crypto.randomUUID();
const blank = (): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
const sourceLabel = (source: LessonSource | undefined, language: Language) =>
  !source
    ? ""
    : [
        source.page
          ? language === "en"
            ? `p. ${source.page}`
            : `第 ${source.page} 页`
          : "",
        source.startMs === undefined
          ? ""
          : timecode(source.startMs) +
            (source.endMs === undefined ? "" : `–${timecode(source.endMs)}`),
      ]
        .filter(Boolean)
        .join(" · ");
function Reply({ text, language }: { text: string; language: Language }) {
  const value = useMemo(() => markdownDocument(text), [text]);
  return <RichEditor value={value} language={language} readOnly />;
}
function downloadDraft(value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "lesson-draft.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function NotebookLesson({
  chapter,
  node,
  language,
  projectId,
  routeId,
  completed,
  busy,
  error,
  onComplete,
  onMap,
  onHome,
}: Props & { projectId: string; routeId: string }) {
  const identity: LessonIdentity = useMemo(
    () => ({ projectId, routeId, nodeId: node.id }),
    [projectId, routeId, node.id],
  );
  const t = (zh: string, en: string) => translate(language, zh, en);
  const store = useLessonWorkspace(identity),
    list = useResourceList(projectId, { routeId, nodeId: node.id });
  const bindings = useResourceBindings(projectId, routeId);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null),
    [editorBlock, setEditorBlock] = useState("");
  const [selection, setSelection] = useState<{
    blockId: string;
    recordId: string;
  } | null>(null);
  const [composer, setComposer] = useState(""),
    [quote, setQuote] = useState<{
      blockId: string;
      source: LessonSource;
    } | null>(null);
  const [resourcesOpen, setResourcesOpen] = useState(false),
    [pickerOpen, setPickerOpen] = useState(false);
  const [inserting, setInserting] = useState<number | null>(null),
    [dragging, setDragging] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanningState | null>(null),
    [options, setOptions] = useState<AgentOptions>({
      model: null,
      effort: null,
    });
  const [settingsOpen, setSettingsOpen] = useState(false),
    [providerBusy, setProviderBusy] = useState(false);
  const [notice, setNotice] = useState(""),
    [chatError, setChatError] = useState("");
  const [working, setWorking] = useState(false),
    [workingStage, setWorkingStage] = useState("");
  const [proposal, setProposal] = useState<{
    blockId: string;
    recordId: string;
    before: JSONContent;
    after: string;
  } | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null),
    [remove, setRemove] = useState<LessonBlock | null>(null);
  const [history, setHistory] = useState<LessonBlock[][]>([]);
  const [chatWidth, setChatWidth] = useState(28);
  const input = useRef<HTMLTextAreaElement>(null),
    chatScroll = useRef<HTMLDivElement>(null);
  const ime = useRef(createImeGuard()),
    job = useRef<{
      id?: string;
      controller: AbortController;
      blockId: string;
      recordId: string;
      messageId: string;
    } | null>(null);
  const alive = useRef(true),
    initialized = useRef(false),
    knownSources = useRef(new Set<string>()),
    insertAt = useRef<number | null>(null);
  const current = store.workspace;
  const activeBlock = current?.blocks.find(
    (block) => block.id === selection?.blockId,
  );
  const activeRecord = activeBlock?.records.find(
    (record) => record.id === selection?.recordId,
  );
  const inherited = attachmentsFrom(
    bindings?.links.filter(
      (link) =>
        (link.kind === "lesson" && link.targetId === node.id) ||
        (link.kind === "chapter" && link.targetId === chapter.id),
    ) ?? [],
    bindings?.items ?? [],
  );
  const resourceMap = new Map(
    [...inherited.map((value) => value.item), ...list.items].map((item) => [
      resourceKey(item),
      item,
    ]),
  );
  const blocked = !current || providerBusy;
  useEffect(() => {
    alive.current = true;
    void planningService.read(projectId).then(
      (value) => {
        if (alive.current) {
          setPlan(value);
          setOptions(value?.agentOptions ?? { model: null, effort: null });
        }
      },
      () => {},
    );
    return () => {
      alive.current = false;
      const pending = job.current;
      pending?.controller.abort();
      if (pending?.id)
        void lessonAgent.cancel(projectId, pending.id).catch(() => {});
    };
  }, [projectId]);
  useEffect(() => {
    if (!current || initialized.current) return;
    initialized.current = true;
    const available = [...resourceMap.values()];
    available.forEach((item) => knownSources.current.add(resourceKey(item)));
    if (current.revision === 0 && !current.blocks.length)
      store.update((value) => ({
        ...value,
        blocks: [
          ...available.map(resourceBlock),
          {
            id: uid(),
            kind: "text",
            collapsed: false,
            content: blank(),
            records: [],
          },
        ],
      }));
  }, [current, list.loaded, bindings]);
  useEffect(() => {
    if (!initialized.current || !current) return;
    const additions = [...resourceMap.values()].filter(
      (item) => !knownSources.current.has(resourceKey(item)),
    );
    if (!additions.length) return;
    additions.forEach((item) => knownSources.current.add(resourceKey(item)));
    setHistory([]);
    store.update((value) => {
      const blocks = [...value.blocks],
        fresh = additions
          .filter(
            (item) =>
              !blocks.some(
                (block) =>
                  block.resource &&
                  resourceKey(block.resource) === resourceKey(item),
              ),
          )
          .map(resourceBlock);
      blocks.splice(insertAt.current ?? blocks.length, 0, ...fresh);
      return { ...value, blocks };
    });
  }, [list.items, bindings, current]);
  useEffect(() => {
    if (chatScroll.current)
      chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [
    selection,
    activeRecord?.messages.map((message) => message.text).join("\0"),
    workingStage,
  ]);
  function resourceBlock(item: ResourceItem): LessonBlock {
    return {
      id: uid(),
      kind: "resource",
      resource: { id: item.id, version: item.version },
      title: item.name,
      collapsed: false,
      records: [],
    };
  }
  // A structural snapshot is only safe until the next edit. RichEditor retains its
  // own text undo history; never restore an old block snapshot over newer notes.
  function changeBlock(
    id: string,
    change: (block: LessonBlock) => LessonBlock,
  ) {
    setHistory([]);
    store.update((value) => ({
      ...value,
      blocks: value.blocks.map((block) =>
        block.id === id ? change(block) : block,
      ),
    }));
  }
  function changeRecord(
    blockId: string,
    recordId: string,
    change: (record: LessonRecord) => LessonRecord,
  ) {
    changeBlock(blockId, (block) => ({
      ...block,
      records: block.records.map((record) =>
        record.id === recordId ? change(record) : record,
      ),
    }));
  }
  function remember() {
    if (store.current.current)
      setHistory((previous) => [
        ...previous.slice(-19),
        structuredClone(store.current.current!.blocks),
      ]);
  }
  function addText(index: number) {
    remember();
    store.update((value) => {
      const blocks = [...value.blocks];
      blocks.splice(index, 0, {
        id: uid(),
        kind: "text",
        content: blank(),
        collapsed: false,
        records: [],
      });
      return { ...value, blocks };
    });
    setInserting(null);
  }
  function move(id: string, index: number) {
    remember();
    store.update((value) => {
      const blocks = [...value.blocks],
        from = blocks.findIndex((block) => block.id === id);
      if (from < 0) return value;
      const [block] = blocks.splice(from, 1);
      blocks.splice(Math.max(0, Math.min(index, blocks.length)), 0, block);
      return { ...value, blocks };
    });
  }
  function undo() {
    const snapshot = history.at(-1);
    if (!snapshot || working) return;
    store.update((value) => ({ ...value, blocks: snapshot }));
    setHistory((previous) => previous.slice(0, -1));
  }
  function newRecord(
    blockId: string,
    kind: LessonRecord["kind"],
    source?: LessonSource,
    content?: JSONContent,
  ) {
    const record: LessonRecord = {
      id: uid(),
      kind,
      title:
        kind === "note"
          ? t("新笔记", "New note")
          : t("新的提问", "New question"),
      collapsed: kind === "question",
      messages: [],
      ...(kind === "note" ? { content: content ?? blank() } : {}),
      ...(source ? { source } : {}),
    };
    changeBlock(blockId, (block) => ({
      ...block,
      records: [...block.records, record],
    }));
    if (kind === "question") {
      setSelection({ blockId, recordId: record.id });
      setComposer("");
      setChatError("");
      input.current?.focus();
    }
    return record.id;
  }
  function cite(blockId: string, source: LessonSource) {
    setQuote({
      blockId,
      source: { ...source, quote: source.quote.slice(0, 10_000) },
    });
    input.current?.focus();
  }
  async function switchProvider(provider: ProviderId) {
    if (!plan || working || providerBusy) return;
    setProviderBusy(true);
    setChatError("");
    try {
      setPlan(await planningService.provider(plan, provider));
      setOptions({ model: null, effort: null });
    } catch (cause) {
      setChatError(lessonAgentMessage(cause, language));
    } finally {
      setProviderBusy(false);
    }
  }
  function response(
    blockId: string,
    recordId: string,
    messageId: string,
    text: string,
    status: LessonMessage["status"],
  ) {
    changeRecord(blockId, recordId, (record) => ({
      ...record,
      messages: record.messages.map((message) =>
        message.id === messageId ? { ...message, text, status } : message,
      ),
    }));
  }
  async function send(
    intent: "ask" | "rewrite" = "ask",
    target?: { blockId: string; record: LessonRecord },
  ) {
    if (job.current || working || blocked || (!composer.trim() && !target))
      return;
    const text = target
      ? t(
          "请整理这条笔记，保留原意并纠正明显错误，给我可预览的修改建议。",
          "Polish this note, preserving its meaning and correcting clear mistakes. Propose a replacement for preview.",
        )
      : composer.trim();
    const blockId =
      target?.blockId ??
      activeBlock?.id ??
      quote?.blockId ??
      current!.blocks[0]?.id;
    if (!blockId) {
      setChatError(t("请先插入一个内容块。", "Insert a content block first."));
      return;
    }
    const recordId = target
      ? newRecord(blockId, "question")
      : activeRecord?.kind === "question"
        ? activeRecord.id
        : newRecord(blockId, "question");
    const messageId = uid(),
      controller = new AbortController();
    job.current = { controller, blockId, recordId, messageId };
    setWorking(true);
    setChatError("");
    setWorkingStage(t("正在连接智能体…", "Connecting to agent…"));
    setComposer("");
    const source = quote;
    changeRecord(blockId, recordId, (record) => ({
      ...record,
      title: record.messages.length ? record.title : text.slice(0, 70),
      ...(source && source.blockId === blockId && !record.source
        ? { source: source.source }
        : {}),
      ...(source && (source.blockId !== blockId || record.source)
        ? {
            references: [
              ...(record.references ?? []).filter(
                (reference) =>
                  JSON.stringify(reference) !== JSON.stringify(source),
              ),
              source,
            ].slice(-30),
          }
        : {}),
      messages: [
        ...record.messages,
        { id: uid(), role: "user", text, status: "complete" },
        { id: messageId, role: "assistant", text: "", status: "pending" },
      ],
    }));
    setSelection({ blockId, recordId });
    setQuote(null);
    try {
      if (!(await store.flush())) throw new Error("LESSON_SAVE_FAILED");
      const started = await lessonAgent.start({
        ...identity,
        expectedRevision: store.current.current!.revision,
        blockId,
        recordId,
        locale: language,
        agentOptions: options,
        intent,
        ...(target ? { targetRecordId: target.record.id } : {}),
      });
      if (controller.signal.aborted || !alive.current) {
        void lessonAgent.cancel(projectId, started.id).catch(() => {});
        return;
      }
      job.current!.id = started.id;
      const result = await watchLessonAgent(
        projectId,
        started.id,
        (value) => {
          if (!alive.current || job.current?.messageId !== messageId) return;
          response(
            blockId,
            recordId,
            messageId,
            value.text,
            value.state === "completed"
              ? "complete"
              : value.state === "pending"
                ? "pending"
                : "incomplete",
          );
          setWorkingStage(value.stage === 'thinking' ? t('正在思考…', 'Thinking…') : value.stage === 'connecting' ? t('正在连接智能体…', 'Connecting to agent…') : t('正在回答…', 'Responding…'));
        },
        controller.signal,
      );
      if (!alive.current || job.current?.messageId !== messageId) return;
      if (result?.state === "completed" && result.editText && target)
        setProposal({
          blockId,
          recordId: target.record.id,
          before: structuredClone(target.record.content ?? blank()),
          after: result.editText,
        });
      if (result?.state === "failed")
        setChatError(lessonAgentMessage(result.errorCode, language));
    } catch (cause) {
      if (alive.current) {
        setChatError(lessonAgentMessage(cause, language));
        changeRecord(blockId, recordId, (record) => ({
          ...record,
          messages: record.messages.map((message) =>
            message.id === messageId
              ? { ...message, status: "incomplete" }
              : message,
          ),
        }));
      }
    } finally {
      if (alive.current && job.current?.messageId === messageId) {
        job.current = null;
        setWorking(false);
        setWorkingStage("");
        void store.flush();
      }
    }
  }
  async function stop() {
    const pending = job.current;
    if (!pending) return;
    job.current = null;
    pending.controller.abort();
    try {
      if (pending.id) {
        const result = await lessonAgent.cancel(projectId, pending.id);
        if (alive.current)
          response(
            pending.blockId,
            pending.recordId,
            pending.messageId,
            result.text,
            "incomplete",
          );
      }
    } catch {
      setChatError(
        t(
          "已停止接收，已有回复保留。",
          "Stopped receiving. The partial reply was kept.",
        ),
      );
    }
    if (alive.current) {
      changeRecord(pending.blockId, pending.recordId, (record) => ({
        ...record,
        messages: record.messages.map((message) =>
          message.id === pending.messageId
            ? { ...message, status: "incomplete" }
            : message,
        ),
      }));
      setWorking(false);
      setWorkingStage("");
      job.current = null;
      void store.flush();
    }
  }
  async function navigate(action: () => void) {
    if (working) {
      setNotice(
        t(
          "请先停止当前回答，再离开小节。",
          "Stop the current reply before leaving.",
        ),
      );
      return;
    }
    if ((!store.current.current || await store.flush()) && !composer.trim()) action();
    else setLeave(() => action);
  }
  function removeBlock() {
    if (!remove) return;
    remember();
    store.update((value) => ({
      ...value,
      blocks:
        remove.records.length ||
        remove.kind === "resource" ||
        remove.kind === "link"
          ? value.blocks.map((block) =>
              block.id === remove.id ? { ...block, collapsed: true } : block,
            )
          : value.blocks
              .filter((block) => block.id !== remove.id)
              .map((block) => ({
                ...block,
                records: block.records.map((record) => ({
                  ...record,
                  ...(record.references
                    ? {
                        references: record.references.filter(
                          (reference) => reference.blockId !== remove.id,
                        ),
                      }
                    : {}),
                })),
              })),
    }));
    setRemove(null);
  }
  const saveText =
    store.status === "saving"
      ? t("保存中…", "Saving…")
      : store.status === "saved"
        ? t("已保存", "Saved")
        : store.status === "error"
          ? t("保存失败 · 草稿已保留", "Save failed · draft retained")
          : t("未保存", "Unsaved");
  const focusEditor = (blockId: string, editor: Editor) => {
    setActiveEditor(editor);
    setEditorBlock(blockId);
  };
  function insertLine(index: number, last = false) {
    return (
      <div className={`notebook-insert ${last ? "is-last" : ""}`}>
        <button
          disabled={blocked}
          aria-label={t("插入内容块", "Insert block")}
          aria-expanded={inserting === index}
          onClick={() => setInserting(inserting === index ? null : index)}
        >
          <Plus />
          {last && t("插入内容", "Insert content")}
        </button>
        {inserting === index && (
          <div className="notebook-insert-menu">
            <button onClick={() => addText(index)}>
              <FileText />
              {t("文字 / Markdown", "Text / Markdown")}
            </button>
            <button
              onClick={() => {
                insertAt.current = index;
                setResourcesOpen(true);
                setInserting(null);
              }}
            >
              <Paperclip />
              {t("资料", "Resource")}
            </button>
            <button
              onClick={() => {
                insertAt.current = index;
                setPickerOpen(true);
                setInserting(null);
              }}
            >
              <Download />
              {t("项目资料库", "Project resources")}
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <section className="lesson-page notebook-page">
      <header className="notebook-header">
        <div className="notebook-navigation">
          <GameButton
            variant="secondary"
            leadingIcon={<ArrowLeft />}
            onClick={() => void navigate(onHome)}
          >
            {t("返回主页", "Home")}
          </GameButton>
          <button
            className="notebook-inline-action"
            onClick={() => void navigate(onMap)}
          >
            <ArrowLeft />
            {t("返回地图", "Back to map")}
          </button>
        </div>
        <div className="notebook-heading">
          <span>{chapter.title}</span>
          <h1>{node.title}</h1>
        </div>
        <div className="notebook-save">
          <span
            role="status"
            className={store.status === "error" ? "notebook-error" : ""}
          >
            {saveText}
          </span>
          <GameButton
            disabled={busy || working || !current || completed}
            onClick={() =>
              void store.flush().then((saved) => {
                if (saved) void onComplete();
              })
            }
          >
            {completed
              ? t("已完成", "Completed")
              : t("完成本节", "Finish lesson")}
          </GameButton>
        </div>
      </header>
      <div className="notebook-layout" style={{gridTemplateColumns: `minmax(0,1fr) 6px minmax(300px,${chatWidth}%)`}}>
        <main className="notebook-paper">
          <div className="notebook-toolbar">
            <RichEditorToolbar
              editor={activeEditor?.isDestroyed ? null : activeEditor}
              language={language}
              onQuote={(text) => cite(editorBlock, { quote: text })}
            />
            <button
              className="notebook-inline-action"
              disabled={!history.length || working}
              title={t("撤销块操作", "Undo block action")}
              onClick={undo}
            >
              <Undo2 />
            </button>
          </div>
          <div className="notebook-scroll">
            <details className="notebook-goals">
              <summary>
                <span>{t("学习目标", "Learning goals")}</span>
                <span>
                  <Clock3 />
                  {node.estimatedMinutes}
                  {t(" 分钟", " min")} ·{" "}
                  {node.requirement === "optional"
                    ? t("选学", "Elective")
                    : t("必学", "Required")}
                </span>
                <ChevronDown />
              </summary>
              <ul>
                {node.objectives.map((goal) => (
                  <li key={goal.id}>{goal.description}</li>
                ))}
              </ul>
              {Boolean(node.activities?.length) && (
                <ol>
                  {node.activities!.map((activity, index) => (
                    <li key={index}>{activity}</li>
                  ))}
                </ol>
              )}
              <LegacyLessonContent node={node} language={language} collapsible />
            </details>
            {store.error && (
              <div className="notebook-alert" role="alert">
                <p>
                  {store.error.includes("CONFLICT")
                    ? t(
                        "小节已在其他窗口更新。当前草稿已保留，请先导出再重新打开。",
                        "This lesson changed in another window. Export this draft before reopening.",
                      )
                    : !current ? t('未能打开本节内容，请重试。', 'Could not open this lesson. Try again.') : store.error.includes('TOO_LARGE') ? t('本节内容过多，请先导出草稿，移除部分内容后重新保存。', 'This lesson is too large. Export your draft, remove some content, then save again.') : t(
                        "内容暂未保存，请重试；当前编辑内容仍保留。",
                        "Could not save. Your edits are still here. Try again.",
                      )}
                </p>
                <button onClick={() => {if (current) void store.flush();else store.retryRead();}}>
                  {current ? t("重试保存", "Retry save") : t('重新打开', 'Try again')}
                </button>
                <button onClick={() => downloadDraft(store.current.current)}>
                  {t("导出草稿", "Export draft")}
                </button>
              </div>
            )}
            {!current && store.status === 'loading' && (
              <p className="notebook-loading">
                <LoaderCircle />
                {t("正在打开小节…", "Opening lesson…")}
              </p>
            )}
            {current?.blocks.map((block, index) => (
              <div key={block.id}>
                {insertLine(index)}
                <article
                  className={`notebook-cell notebook-cell--${block.kind}`}
                  onDragOver={(event) => {
                    if (dragging) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging) move(dragging, index);
                    setDragging(null);
                  }}
                >
                  <div className="notebook-cell-header">
                    <button
                      draggable={!working}
                      className="notebook-grip"
                      aria-label={t("拖动内容块", "Drag block")}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", block.id);
                        setDragging(block.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <GripVertical />
                    </button>
                    <button
                      className="notebook-cell-fold"
                      aria-label={
                        block.collapsed
                          ? t("展开内容", "Expand content")
                          : t("收起内容", "Fold content")
                      }
                      onClick={() =>
                        changeBlock(block.id, (value) => ({
                          ...value,
                          collapsed: !value.collapsed,
                        }))
                      }
                    >
                      {block.collapsed ? <ChevronRight /> : <ChevronDown />}
                    </button>
                    <span className="notebook-cell-kind">
                      {block.kind === "resource" ? <Paperclip /> : <FileText />}
                    </span>
                    <input
                      className="notebook-cell-title"
                      aria-label={t("内容块标题", "Block title")}
                      value={block.title ?? ""}
                      placeholder={
                        block.kind === "text"
                          ? t("文字", "Text")
                          : t("资料", "Resource")
                      }
                      maxLength={500}
                      onChange={(event) =>
                        changeBlock(block.id, (value) => ({
                          ...value,
                          title: event.target.value,
                        }))
                      }
                    />
                    <div className="notebook-cell-actions">
                      <button
                        title={t("上移", "Move up")}
                        aria-label={t("上移", "Move up")}
                        disabled={index === 0 || working}
                        onClick={() => move(block.id, index - 1)}
                      >
                        <ArrowUp />
                      </button>
                      <button
                        title={t("下移", "Move down")}
                        aria-label={t("下移", "Move down")}
                        disabled={
                          index === current.blocks.length - 1 || working
                        }
                        onClick={() => move(block.id, index + 1)}
                      >
                        <ArrowDown />
                      </button>
                      <button
                        title={t("移除内容块", "Remove block")}
                        aria-label={t("移除内容块", "Remove block")}
                        disabled={working}
                        onClick={() => setRemove(block)}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                  {!block.collapsed && (
                    <div className="notebook-cell-content">
                      {block.kind === "text" && (
                        <RichEditor
                          value={block.content ?? blank()}
                          language={language}
                          onChange={(content) =>
                            changeBlock(block.id, (value) => ({
                              ...value,
                              content,
                            }))
                          }
                          onReady={(editor) => {
                            if (editor && !activeEditor)
                              focusEditor(block.id, editor);
                            if (!editor && editorBlock === block.id) setActiveEditor(null);
                          }}
                          onFocus={(editor) => focusEditor(block.id, editor)}
                          onQuote={(text) => cite(block.id, { quote: text })}
                        />
                      )}{" "}
                      {block.kind === "math" && (
                        <RichEditor
                          value={{
                            type: "doc",
                            content: [
                              {
                                type: "blockMath",
                                attrs: { latex: block.latex ?? "" },
                              },
                              { type: "paragraph" },
                            ],
                          }}
                          language={language}
                          onChange={(value) =>
                            changeBlock(block.id, (item) => ({
                              ...item,
                              latex:
                                value.content?.find(
                                  (part) => part.type === "blockMath",
                                )?.attrs?.latex ?? "",
                            }))
                          }
                          onFocus={(editor) => focusEditor(block.id, editor)}
                        />
                      )}{" "}
                      {block.kind === "resource" &&
                        (block.resource &&
                        resourceMap.get(resourceKey(block.resource)) ? (
                          <LessonResource
                            identity={identity}
                            item={resourceMap.get(resourceKey(block.resource))!}
                            language={language}
                            onQuote={(source) => cite(block.id, source)}
                          />
                        ) : (
                          <p className="notebook-muted">
                            {t(
                              "资料原件暂不可用，已有笔记和问答仍保留。",
                              "The original is unavailable. Notes and questions are retained.",
                            )}
                          </p>
                        ))}{" "}
                      {block.kind === "link" && (
                        <a href={block.url} target="_blank" rel="noreferrer">
                          {block.url}
                        </a>
                      )}
                    </div>
                  )}
                  <div className="notebook-records">
                    {block.records.map((record) => (
                      <section
                        className={`notebook-record notebook-record--${record.kind}`}
                        key={record.id}
                      >
                        <button
                          className="notebook-record-toggle"
                          aria-expanded={!record.collapsed}
                          onClick={() =>
                            changeRecord(block.id, record.id, (item) => ({
                              ...item,
                              collapsed: !item.collapsed,
                            }))
                          }
                        >
                          {record.collapsed ? (
                            <ChevronRight />
                          ) : (
                            <ChevronDown />
                          )}
                          {record.kind === "note" ? (
                            <StickyNote />
                          ) : (
                            <MessageCircle />
                          )}
                          <span>{record.title}</span>
                          <small>
                            {sourceLabel(record.source, language)}
                            {record.kind === "question" &&
                              ` · ${Math.ceil(record.messages.length / 2)}${t(" 轮", " turns")}`}
                          </small>
                        </button>
                        {!record.collapsed && (
                          <div className="notebook-record-body">
                            {record.source?.quote && (
                              <blockquote>{record.source.quote}</blockquote>
                            )}
                            {record.references?.map((reference, refIndex) => (
                              <span
                                className="notebook-reference"
                                key={refIndex}
                              >
                                {current.blocks.find(
                                  (item) => item.id === reference.blockId,
                                )?.title ||
                                  t("引用内容", "Referenced content")}{" "}
                                {sourceLabel(reference.source, language)}
                              </span>
                            ))}
                            {record.kind === "note" ? (
                              <>
                                <input
                                  className="notebook-note-title"
                                  aria-label={t("笔记标题", "Note title")}
                                  value={record.title}
                                  maxLength={500}
                                  onChange={(event) =>
                                    changeRecord(
                                      block.id,
                                      record.id,
                                      (value) => ({
                                        ...value,
                                        title: event.target.value,
                                      }),
                                    )
                                  }
                                />
                                <RichEditor
                                  value={record.content ?? blank()}
                                  language={language}
                                  onChange={(content) =>
                                    changeRecord(
                                      block.id,
                                      record.id,
                                      (value) => ({ ...value, content }),
                                    )
                                  }
                                  onFocus={(editor) =>
                                    focusEditor(block.id, editor)
                                  }
                                  onQuote={(text) =>
                                    cite(block.id, { quote: text })
                                  }
                                />
                                <button
                                  className="notebook-inline-action"
                                  disabled={working}
                                  onClick={() =>
                                    void send("rewrite", {
                                      blockId: block.id,
                                      record,
                                    })
                                  }
                                >
                                  {t("请 AI 整理", "Ask AI to polish")}
                                </button>
                              </>
                            ) : (
                              <>
                                {record.messages.map((message) => (
                                  <div
                                    className={`notebook-inline-message is-${message.role}`}
                                    key={message.id}
                                  >
                                    <small>
                                      {message.role === "user"
                                        ? t("我", "You")
                                        : t("智能体", "Agent")}
                                    </small>
                                    <Reply
                                      text={
                                        message.text ||
                                        (message.status === "pending"
                                          ? t("正在回答…", "Responding…")
                                          : t("回复未完成", "Incomplete reply"))
                                      }
                                      language={language}
                                    />
                                  </div>
                                ))}
                                <button
                                  className="notebook-inline-action"
                                  onClick={() => {
                                    setSelection({
                                      blockId: block.id,
                                      recordId: record.id,
                                    });
                                    input.current?.focus();
                                  }}
                                >
                                  {t("继续追问", "Follow up")}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                  <footer className="notebook-cell-footer">
                    <button
                      onClick={() => {
                        newRecord(block.id, "question");
                        setQuote(null);
                      }}
                    >
                      <MessageCircle />
                      {t("提问", "Ask")}
                    </button>
                    <button onClick={() => newRecord(block.id, "note")}>
                      <StickyNote />
                      {t("记笔记", "Add note")}
                    </button>
                    {block.collapsed && (
                      <small>{t("内容已收起", "Content folded")}</small>
                    )}
                  </footer>
                </article>
              </div>
            ))}
            {current && insertLine(current.blocks.length, true)}
          </div>
        </main>
        <div className="notebook-divider" role="separator" aria-label={t('调整对话区宽度', 'Resize conversation')} aria-orientation="vertical" aria-valuemin={24} aria-valuemax={42} aria-valuenow={chatWidth} tabIndex={0}
          onKeyDown={event => {if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault();setChatWidth(value => Math.min(42,Math.max(24,value+(event.key === 'ArrowLeft'?2:-2))));}}}
          onPointerDown={event => {const divider=event.currentTarget,bounds=divider.parentElement!.getBoundingClientRect();divider.setPointerCapture(event.pointerId);const move=(pointer:PointerEvent)=>setChatWidth(Math.max(24,Math.min(42,100*(bounds.right-pointer.clientX)/bounds.width)));const done=()=>{divider.removeEventListener('pointermove',move);divider.removeEventListener('lostpointercapture',done);};divider.addEventListener('pointermove',move);divider.addEventListener('lostpointercapture',done);}}/>
        <aside
          className="notebook-chat"
          aria-label={t("智能体对话", "Agent conversation")}
        >
          <header className="notebook-chat-heading">
            <h2>
              <MessageCircle />
              {t("学习助手", "Learning assistant")}
            </h2>
            <button
              title={t("智能体设置", "Agent settings")}
              aria-label={t("智能体设置", "Agent settings")}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <Settings2 />
            </button>
          </header>
          {settingsOpen && (
            <div className="notebook-agent-settings">
              {plan ? (
                <>
                  <PlanningAgentControl
                    state={plan}
                    language={language}
                    busy={working || providerBusy}
                    onProvider={(provider) => void switchProvider(provider)}
                  />
                  <PlanningModelControls
                    state={{ ...plan, agentOptions: options }}
                    language={language}
                    busy={working || providerBusy}
                    onOptions={setOptions}
                  />
                </>
              ) : (
                <p>
                  {t(
                    "请先在项目中连接智能体。",
                    "Connect an agent in this project first.",
                  )}
                </p>
              )}
            </div>
          )}
          <div className="notebook-chat-context">
            <span>
              {PROVIDERS.find((provider) => provider.id === plan?.provider)
                ?.name ?? t("智能体", "Agent")}
            </span>
            <button
              disabled={working || !current?.blocks.length}
              onClick={() => {
                const id = activeBlock?.id ?? current?.blocks[0]?.id;
                if (id) {
                  newRecord(id, "question");
                  setQuote(null);
                }
              }}
            >
              <Plus />
              {t("新提问", "New question")}
            </button>
          </div>
          <div className="notebook-chat-scroll" ref={chatScroll}>
            {!activeRecord && (
              <div className="notebook-chat-empty">
                <img
                  src={
                    import.meta.env.BASE_URL +
                    "assets/images/hamster-traveler-v1.png"
                  }
                  alt=""
                />
                <p>
                  {t(
                    "选中文字、页码或音视频片段，向智能体提问。",
                    "Select text, a page or a clip to ask your agent.",
                  )}
                </p>
              </div>
            )}
            {activeRecord?.source && (
              <blockquote className="notebook-chat-source">
                {activeBlock?.title || t("本节内容", "Lesson content")}{" "}
                {sourceLabel(activeRecord.source, language)}
                {activeRecord.source.quote && (
                  <span>{activeRecord.source.quote}</span>
                )}
              </blockquote>
            )}
            {activeRecord?.messages.map((message) => (
              <div
                className={`notebook-chat-message is-${message.role}`}
                key={message.id}
              >
                <span>
                  {message.role === "user"
                    ? t("我", "You")
                    : t("智能体", "Agent")}
                </span>
                <Reply
                  text={
                    message.text ||
                    (message.status === "pending"
                      ? t("正在思考…", "Thinking…")
                      : t("回复未完成", "Incomplete reply"))
                  }
                  language={language}
                />
                {message.status === "incomplete" && (
                  <small className="notebook-muted">
                    {t("回复未完成 · 已保留", "Incomplete · retained")}
                  </small>
                )}
                {message.role === "assistant" &&
                  message.text &&
                  message.status !== "pending" && (
                    <button
                      className="notebook-inline-action"
                      onClick={() => {
                        const selected = chatScroll.current?.contains(
                          window.getSelection()?.anchorNode ?? null,
                        )
                          ? window.getSelection()?.toString()
                          : "";
                        newRecord(
                          activeBlock!.id,
                          "note",
                          activeRecord.source,
                          markdownDocument(selected || message.text),
                        );
                        setNotice(
                          t(
                            "已存为资料下方的笔记。",
                            "Saved as a note beneath the source.",
                          ),
                        );
                      }}
                    >
                      <StickyNote />
                      {t("保存为笔记", "Save as note")}
                    </button>
                  )}
              </div>
            ))}
            {working && (
              <p className="notebook-loading">
                <LoaderCircle />
                {workingStage}
              </p>
            )}
          </div>
          {chatError && (
            <p className="notebook-chat-error" role="alert">
              {chatError}
            </p>
          )}
          <form
            className="notebook-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ime.current.active()) void send();
            }}
          >
            {quote && (
              <div className="notebook-citation">
                <span>
                  {current?.blocks.find((block) => block.id === quote.blockId)
                    ?.title || t("引用内容", "Quoted content")}{" "}
                  {sourceLabel(quote.source, language)}
                  {quote.source.quote &&
                    ` · ${quote.source.quote.slice(0, 65)}`}
                </span>
                <button
                  type="button"
                  aria-label={t("移除引用", "Remove quote")}
                  onClick={() => setQuote(null)}
                >
                  <X />
                </button>
              </div>
            )}
            <textarea
              ref={input}
              value={composer}
              placeholder={t("提问，或继续追问…", "Ask or follow up…")}
              aria-label={t("向智能体提问", "Ask the agent")}
              onChange={(event) => setComposer(event.target.value)}
              onCompositionStart={() => ime.current.start()}
              onCompositionEnd={() => ime.current.end()}
              onKeyUp={(event) => ime.current.keyUp(event.nativeEvent)}
              onKeyDown={(event) => {
                if (ime.current.keyDown(event.nativeEvent)) return;
                if (event.key === "Backspace" && !composer && quote) {
                  event.preventDefault();
                  setQuote(null);
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="notebook-composer-actions">
              <span>
                {t("Shift + Enter 换行", "Shift + Enter for a new line")}
              </span>
              {working ? (
                <button type="button" onClick={() => void stop()}>
                  <Square />
                  {t("停止", "Stop")}
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label={t("发送", "Send")}
                  disabled={!composer.trim() || blocked}
                >
                  <Send />
                </button>
              )}
            </div>
          </form>
        </aside>
      </div>
      {(notice || error) && (
        <div className="notebook-toast" role="status">
          <span>{notice || error}</span>
          <button
            aria-label={t("关闭提示", "Dismiss")}
            onClick={() => setNotice("")}
          >
            <X />
          </button>
        </div>
      )}
      {resourcesOpen && (
        <ResourceDialog
          projectId={projectId}
          language={language}
          list={list}
          scope={{ routeId, nodeId: node.id }}
          inherited={inherited.map((value) => value.item)}
          onChooseLibrary={() => setPickerOpen(true)}
          onClose={() => {
            setResourcesOpen(false);
            void list.refresh();
          }}
        />
      )}
      {pickerOpen && (
        <ResourcePicker
          projectId={projectId}
          language={language}
          wholeOnly
          bindings={
            current?.blocks.flatMap((block) =>
              block.resource
                ? [
                    {
                      ...block.resource,
                      kind: "lesson" as const,
                      targetId: node.id,
                      origin: "editor" as const,
                    },
                  ]
                : [],
            ) ?? []
          }
          busy={false}
          onClose={() => setPickerOpen(false)}
          onAdd={async (item) => {
            await resourceService.attachLesson(projectId, item, {
              routeId,
              nodeId: node.id,
            });
            knownSources.current.add(resourceKey(item));
            remember();
            store.update((value) => {
              const blocks = [...value.blocks],
                existing = blocks.find(
                  (block) =>
                    block.resource &&
                    resourceKey(block.resource) === resourceKey(item),
                );
              if (existing)
                return {
                  ...value,
                  blocks: blocks.map((block) =>
                    block.id === existing.id
                      ? { ...block, collapsed: false }
                      : block,
                  ),
                };
              blocks.splice(
                insertAt.current ?? blocks.length,
                0,
                resourceBlock(item),
              );
              return { ...value, blocks };
            });
            await list.refresh();
            return true;
          }}
        />
      )}
      {remove && (
        <Modal
          title={t("移除内容块？", "Remove this block?")}
          closeLabel={t("取消", "Cancel")}
          onClose={() => setRemove(null)}
        >
          <p>
            {remove.records.length ||
            remove.kind === "resource" ||
            remove.kind === "link"
              ? t(
                  "已有笔记和问答会保留，资料预览将收起。原件不会删除。",
                  "Notes and threads stay. The source preview will be folded. The original is kept.",
                )
              : t(
                  "此操作可撤销，原件不会删除。",
                  "You can undo this action. The original is kept.",
                )}
          </p>
          <div className="confirmation-actions">
            <GameButton variant="secondary" onClick={() => setRemove(null)}>
              {t("取消", "Cancel")}
            </GameButton>
            <GameButton variant="danger" onClick={removeBlock}>
              {t("确认移除", "Remove")}
            </GameButton>
          </div>
        </Modal>
      )}
      {leave && (
        <Modal
          title={t("离开小节？", "Leave this lesson?")}
          closeLabel={t("取消", "Cancel")}
          onClose={() => setLeave(null)}
          explicitClose
        >
          <p>
            {t(
              "仍有未保存的内容或未发送的问题，请先保存或导出。",
              "There are unsaved edits or an unsent question. Save or export them first.",
            )}
          </p>
          <div className="confirmation-actions">
            <GameButton variant="secondary" onClick={() => setLeave(null)}>
              {t("继续编辑", "Keep editing")}
            </GameButton>
            <GameButton
              variant="danger"
              onClick={() => {
                const action = leave;
                setLeave(null);
                action();
              }}
            >
              {t("放弃并离开", "Discard and leave")}
            </GameButton>
          </div>
        </Modal>
      )}
      {proposal && (
        <Modal
          title={t("预览笔记修改", "Preview note changes")}
          closeLabel={t("关闭", "Close")}
          onClose={() => setProposal(null)}
          className="notebook-proposal"
        >
          <h3>{t("修改前", "Before")}</h3>
          <RichEditor readOnly value={proposal.before} language={language} />
          <h3>{t("修改后", "After")}</h3>
          <Reply text={proposal.after} language={language} />
          <div className="confirmation-actions">
            <GameButton variant="secondary" onClick={() => setProposal(null)}>
              {t("取消", "Cancel")}
            </GameButton>
            <GameButton
              onClick={() => {
                const saved = store.current.current?.blocks
                  .find((block) => block.id === proposal.blockId)
                  ?.records.find((record) => record.id === proposal.recordId);
                if (
                  !saved ||
                  JSON.stringify(saved.content ?? blank()) !==
                    JSON.stringify(proposal.before)
                ) {
                  setNotice(
                    t(
                      "笔记已改变，请重新整理。",
                      "The note changed. Ask again.",
                    ),
                  );
                  return;
                }
                remember();
                store.update((value) => ({
                  ...value,
                  blocks: value.blocks.map((block) =>
                    block.id === proposal.blockId
                      ? {
                          ...block,
                          records: block.records.map((record) =>
                            record.id === proposal.recordId
                              ? {
                                  ...record,
                                  content: markdownDocument(proposal.after),
                                }
                              : record,
                          ),
                        }
                      : block,
                  ),
                }));
                setProposal(null);
              }}
            >
              {t("采用修改", "Apply changes")}
            </GameButton>
          </div>
        </Modal>
      )}
    </section>
  );
}
