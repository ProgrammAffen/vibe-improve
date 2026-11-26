import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  LoaderCircle,
  Quote,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { lessonService } from "./service";
import type { LessonIdentity, LessonSource } from "./types";
import type { ResourceItem } from "../resources/service";
import { resourceService, timecode } from "../resources/service";
import { translate, type Language } from "../i18n";
import LessonWebPage from "./LessonWebPage";
import type { WebAnnotations } from "./web-notes";

GlobalWorkerOptions.workerSrc = pdfWorker;

function PDFPage({
  url,
  language,
  onQuote,
}: {
  url: string;
  language: Language;
  onQuote: (source: LessonSource) => void;
}) {
  const [pdf, setPDF] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1),
    [error, setError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null);
  const t = (zh: string, en: string) => translate(language, zh, en);
  useEffect(() => {
    const task = getDocument({url, useSystemFonts: true, cMapUrl: import.meta.env.BASE_URL + "pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: import.meta.env.BASE_URL + "pdfjs/standard_fonts/", wasmUrl: import.meta.env.BASE_URL + "pdfjs/wasm/", iccUrl: import.meta.env.BASE_URL + "pdfjs/iccs/"});
    let active = true;
    void task.promise.then(
      (value) => {
        if (active) setPDF(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf) return;
    let active = true,
      cancel: (() => void) | undefined;
    const render = async () => {
      const source = await pdf.getPage(page);
      if (!active || !canvas.current || !text.current || !shell.current) return;
      const viewport = source.getViewport({
        scale: Math.min(
          1.5,
          Math.max(320, shell.current.clientWidth) /
            source.getViewport({ scale: 1 }).width,
        ),
      });
      const target = canvas.current,
        layer = text.current;
      target.width = viewport.width;
      target.height = viewport.height;
      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", String(viewport.scale));
      const drawing = source.render({ canvas: target, viewport });
      const overlay = new TextLayer({
        textContentSource: await source.getTextContent(),
        container: layer,
        viewport,
      });
      cancel = () => {
        drawing.cancel();
        overlay.cancel();
      };
      await Promise.all([drawing.promise, overlay.render()]);
    };
    void render().catch((cause) => {
      if (active && !String(cause).includes("cancel")) setError(true);
    });
    return () => {
      active = false;
      cancel?.();
    };
  }, [pdf, page]);
  return (
    <div className="notebook-pdf">
      <div className="notebook-source-tools">
        <button
          disabled={!pdf || page <= 1}
          aria-label={t("上一页", "Previous page")}
          onClick={() => setPage((value) => value - 1)}
        >
          <ArrowLeft />
        </button>
        <label>
          {t("第", "Page")}{" "}
          <input
            aria-label={t("PDF 页码", "PDF page")}
            type="number"
            min={1}
            max={pdf?.numPages ?? 1}
            value={page}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isInteger(value) &&
                value > 0 &&
                value <= (pdf?.numPages ?? 1)
              )
                setPage(value);
            }}
          />{" "}
          / {pdf?.numPages ?? "…"}
        </label>
        <button
          disabled={!pdf || page >= pdf.numPages}
          aria-label={t("下一页", "Next page")}
          onClick={() => setPage((value) => value + 1)}
        >
          <ArrowRight />
        </button>
        <button
          onClick={() =>
            onQuote({
              page,
              quote: shell.current?.contains(
                window.getSelection()?.anchorNode ?? null,
              )
                ? (window.getSelection()?.toString() ?? "")
                : "",
            })
          }
        >
          <Quote />
          {t("引用本页", "Quote page")}
        </button>
      </div>
      {error ? (
        <p role="alert">
          {t(
            "无法预览 PDF，可以打开原件继续阅读。",
            "PDF preview is unavailable. Open the original to read it.",
          )}
        </p>
      ) : (
        <div className="notebook-pdf-scroll" ref={shell}>
          <div className="notebook-pdf-page">
            <canvas ref={canvas} />
            <div className="textLayer" ref={text} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function LessonResource({
  identity,
  item,
  language,
  onQuote,
  workspaceRevision,
  webAnnotations,
}: {
  identity: LessonIdentity;
  item: ResourceItem;
  language: Language;
  onQuote: (source: LessonSource) => void;
  workspaceRevision?: number;
  webAnnotations?: WebAnnotations;
}) {
  const [preview, setPreview] = useState<{
    url: string;
    mimeType: string;
    name: string;
  }>();
  const [previewFailed, setPreviewFailed] = useState(false),
    [openFailed, setOpenFailed] = useState(false),
    [plain, setPlain] = useState("");
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(workspaceRevision ?? 0), requestedAt = useRef(0);
  revision.current = workspaceRevision ?? 0;
  const [start, setStart] = useState<number>(),
    [end, setEnd] = useState<number>();
  const media = useRef<HTMLMediaElement>(null),
    copy = useRef<HTMLPreElement>(null);
  const t = (zh: string, en: string) => translate(language, zh, en);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    requestedAt.current = revision.current;
    setPreviewFailed(false);
    void lessonService
      .preview(identity, item)
      .then(async (value) => {
        if (!active) return;
        setPreview(value);
        if (
          value.mimeType.startsWith("text/") &&
          value.mimeType !== "text/uri-list"
        ) {
          const response = await fetch(value.url, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("READ_FAILED");
          const text = await response.text();
          if (active) setPlain(text);
        }
      })
      .catch(() => { if (active) setPreviewFailed(true); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    identity.projectId,
    identity.routeId,
    identity.nodeId,
    item.id,
    item.version,
    attempt,
  ]);
  useEffect(() => {
    // A newly inserted link may first be eligible for preview after workspace autosave.
    if (item.format === 'web' && previewFailed && revision.current > requestedAt.current)
      setAttempt(value => value + 1);
  }, [item.format, previewFailed, workspaceRevision]);
  const openOriginal = () => {
    setOpenFailed(false);
    void resourceService
      .open(identity.projectId, item)
      .catch(() => setOpenFailed(true));
  };
  const isMedia = preview && /^(audio|video)\//.test(preview.mimeType);
  return (
    <div className="notebook-resource-preview">
      {!preview && !previewFailed && (
        <p className="notebook-loading">
          <LoaderCircle />
          {t("正在打开资料…", "Opening resource…")}
        </p>
      )}
      {preview?.mimeType === "application/pdf" && (
        <PDFPage url={preview.url} language={language} onQuote={onQuote} />
      )}
      {preview?.mimeType.startsWith("image/") && (
        <img src={preview.url} alt={item.name} className="notebook-image" />
      )}
      {preview?.mimeType.startsWith("video/") && (
        <video
          ref={(element) => {
            media.current = element;
          }}
          src={preview.url}
          controls
          preload="metadata"
        />
      )}
      {preview?.mimeType.startsWith("audio/") && (
        <audio
          ref={(element) => {
            media.current = element;
          }}
          src={preview.url}
          controls
          preload="metadata"
        />
      )}
      {preview?.mimeType === "text/uri-list" && (
        <LessonWebPage url={preview.url} title={item.name} language={language} showOpenOriginal={false} annotations={webAnnotations} />
      )}
      {plain && (
        <pre className="notebook-plain" ref={copy}>
          {plain}
        </pre>
      )}
      {isMedia && (
        <div className="notebook-source-tools">
          <button
            onClick={() => {
              setStart(Math.round((media.current?.currentTime ?? 0) * 1000));
              setEnd(undefined);
            }}
          >
            {start === undefined
              ? t("标记起点", "Mark start")
              : timecode(start)}
          </button>
          <button
            disabled={start === undefined}
            onClick={() =>
              setEnd(
                Math.max(
                  start ?? 0,
                  Math.round((media.current?.currentTime ?? 0) * 1000),
                ),
              )
            }
          >
            {end === undefined ? t("标记终点", "Mark end") : timecode(end)}
          </button>
          <button
            disabled={start === undefined}
            onClick={() =>
              onQuote({
                quote: "",
                startMs: start,
                ...(end === undefined ? {} : { endMs: end }),
              })
            }
          >
            <Quote />
            {t("引用片段", "Quote clip")}
          </button>
        </div>
      )}
      {plain && (
        <button
          className="notebook-inline-action"
          onClick={() =>
            onQuote({
              quote: copy.current?.contains(
                window.getSelection()?.anchorNode ?? null,
              )
                ? (window.getSelection()?.toString() ?? "")
                : "",
            })
          }
        >
          <Quote />
          {t("引用所选文字", "Quote selection")}
        </button>
      )}
      {(openFailed || previewFailed) && (
        <p className="notebook-muted" role="status">
          {openFailed
            ? t("原件不可用，请重新添加资料。", "The original is unavailable. Add the resource again.")
            : t("此资料可通过原件查看。", "Open the original to view this resource.")}
        </p>
      )}
      <button className="notebook-inline-action" onClick={openOriginal}>
        <ExternalLink />
        {t("打开原件", "Open original")}
      </button>
    </div>
  );
}
