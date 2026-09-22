import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Maximize,
  Minus,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./components.css";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfViewerProps {
  data: Uint8Array | null;
  revision: number;
  dark: boolean;
  onError?: (message: string) => void;
}

function wasCancelled(error: unknown) {
  return (
    error instanceof Error &&
    ["RenderingCancelledException", "AbortException"].includes(error.name)
  );
}

export default function PdfViewer({
  data,
  revision,
  dark,
  onError,
}: PdfViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [actualZoom, setActualZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchingPages, setMatchingPages] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const [renderedVersion, setRenderedVersion] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeDocument = useRef<PDFDocumentProxy | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const textCache = useRef(
    new WeakMap<PDFDocumentProxy, Map<number, string>>(),
  );

  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError("");
    if (!data?.byteLength) {
      setPdf(null);
      setLoading(false);
      setRendering(false);
      setPage(1);
      void activeDocument.current?.loadingTask.destroy();
      activeDocument.current = null;
      return;
    }
    setLoading(true);
    // The worker transfers ownership of its buffer. Keep the React prop intact
    // so recompiles, StrictMode, and a second preview can reuse it safely.
    const task = getDocument({ data: new Uint8Array(data) });
    void task.promise
      .then((document) => {
        if (cancelled) {
          void document.loadingTask.destroy();
          return;
        }
        const previous = activeDocument.current;
        activeDocument.current = document;
        setPdf(document);
        setPage((current) => Math.max(1, Math.min(current, document.numPages)));
        setLoading(false);
        if (previous && previous !== document)
          void previous.loadingTask.destroy();
      })
      .catch((cause) => {
        if (cancelled) return;
        const message =
          cause instanceof Error
            ? cause.message
            : "The PDF could not be opened.";
        setError(message);
        setLoading(false);
        errorHandler.current?.(message);
      });
    return () => {
      cancelled = true;
      // A resolved document remains usable while its replacement is loading.
      if (
        !activeDocument.current ||
        activeDocument.current.loadingTask !== task
      )
        void task.destroy();
    };
  }, [data, revision]);

  useEffect(
    () => () => {
      void activeDocument.current?.loadingTask.destroy();
      activeDocument.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!pdf || !sheet.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setRendering(true);
    const render = async () => {
      const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages));
      if (cancelled) return;
      const normal = pdfPage.getViewport({ scale: 1 });
      const scale = zoom ?? Math.max(0.1, (width - 56) / normal.width);
      const viewport = pdfPage.getViewport({ scale });
      const density = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * density);
      canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-hidden", "true");
      const canvasContext = canvas.getContext("2d", { alpha: false });
      if (!canvasContext)
        throw new Error("PDF rendering is unavailable on this device.");
      task = pdfPage.render({
        canvas,
        canvasContext,
        viewport,
        transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
      });
      await task.promise;
      if (cancelled) return;
      const textContainer = document.createElement("div");
      textContainer.className = "textLayer";
      const totalScale = scale * viewport.userUnit;
      textContainer.style.setProperty("--scale-factor", String(scale));
      textContainer.style.setProperty(
        "--total-scale-factor",
        String(totalScale),
      );
      layer = new TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: textContainer,
        viewport,
      });
      await layer.render();
      if (cancelled || activeDocument.current !== pdf || !sheet.current) return;
      // Commit only completed renders; a cancelled older build never blanks or
      // overwrites the latest successful preview.
      sheet.current.style.width = `${viewport.width}px`;
      sheet.current.style.height = `${viewport.height}px`;
      sheet.current.style.setProperty("--scale-factor", String(scale));
      sheet.current.style.setProperty(
        "--total-scale-factor",
        String(totalScale),
      );
      sheet.current.replaceChildren(canvas, textContainer);
      setActualZoom(scale);
      setRenderedVersion((value) => value + 1);
      setRendering(false);
    };
    void render().catch((cause) => {
      if (cancelled || activeDocument.current !== pdf || wasCancelled(cause))
        return;
      const message =
        cause instanceof Error
          ? cause.message
          : "The PDF page could not be rendered.";
      setRendering(false);
      setError(message);
      errorHandler.current?.(message);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, zoom, width]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [page]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    let cancelled = false;
    setMatchingPages([]);
    const term = query.trim().toLocaleLowerCase();
    if (!pdf || !term || !searchOpen) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        let cache = textCache.current.get(pdf);
        if (!cache) {
          cache = new Map();
          textCache.current.set(pdf, cache);
        }
        const matches: number[] = [];
        for (let number = 1; number <= pdf.numPages; number++) {
          if (cancelled) return;
          let text = cache.get(number);
          if (text === undefined) {
            const documentPage = await pdf.getPage(number);
            const content = await documentPage.getTextContent();
            text = content.items
              .flatMap((item) => ("str" in item ? [item.str] : []))
              .join(" ")
              .toLocaleLowerCase();
            cache.set(number, text);
          }
          if (text.includes(term)) matches.push(number);
        }
        if (cancelled) return;
        setMatchingPages(matches);
        if (matches.length && !matches.includes(pageRef.current))
          setPage(matches[0]);
        setSearching(false);
      })().catch(() => {
        if (!cancelled) setSearching(false);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pdf, query, searchOpen]);

  useEffect(() => {
    const term = searchOpen ? query.trim().toLocaleLowerCase() : "";
    sheet.current
      ?.querySelectorAll<HTMLSpanElement>(".textLayer span")
      .forEach((span) => {
        span.classList.toggle(
          "pdf-search-match",
          Boolean(term && span.textContent?.toLocaleLowerCase().includes(term)),
        );
      });
  }, [query, searchOpen, renderedVersion]);

  function moveMatch(direction: number) {
    if (!matchingPages.length) return;
    const index = matchingPages.indexOf(page);
    setPage(
      matchingPages[
        (index + direction + matchingPages.length) % matchingPages.length
      ],
    );
  }

  function handleKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "f") {
      event.preventDefault();
      setSearchOpen(true);
      searchInput.current?.focus();
    }
    if (event.key === "Escape") setSearchOpen(false);
  }

  const ready = Boolean(pdf);
  return (
    <div
      className="pdf-viewer"
      data-theme={dark ? "dark" : "light"}
      onKeyDown={handleKey}
    >
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
        <div className="pdf-toolbar-group">
          <button
            type="button"
            title="Previous page"
            aria-label="Previous page"
            disabled={!ready || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          <div className="pdf-page-control">
            <input
              aria-label="PDF page number"
              title="Page number"
              value={ready ? page : "—"}
              disabled={!ready}
              inputMode="numeric"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (
                  Number.isInteger(next) &&
                  next >= 1 &&
                  pdf &&
                  next <= pdf.numPages
                )
                  setPage(next);
              }}
            />
            <span aria-hidden="true">/</span>
            <span aria-label={`${pdf?.numPages ?? 0} pages`}>
              {pdf?.numPages ?? "—"}
            </span>
          </div>
          <button
            type="button"
            title="Next page"
            aria-label="Next page"
            disabled={!ready || page >= (pdf?.numPages ?? 0)}
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="pdf-toolbar-group pdf-zoom-controls">
          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={!ready || actualZoom <= 0.25}
            onClick={() => setZoom(Math.max(0.25, actualZoom - 0.15))}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="pdf-zoom-label"
            title="Reset zoom to 100%"
            aria-label={`Zoom ${Math.round(actualZoom * 100)} percent. Reset to 100 percent`}
            disabled={!ready}
            onClick={() => setZoom(1)}
          >
            {ready ? `${Math.round(actualZoom * 100)}%` : "100%"}
          </button>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={!ready || actualZoom >= 3}
            onClick={() => setZoom(Math.min(3, actualZoom + 0.15))}
          >
            <Plus size={14} />
          </button>
          <span className="pdf-toolbar-divider" />
          <button
            type="button"
            title="Fit to width"
            aria-label="Fit PDF to width"
            aria-pressed={zoom === null}
            disabled={!ready}
            onClick={() => setZoom(null)}
          >
            <Maximize size={14} />
          </button>
          <button
            type="button"
            title="Find in PDF"
            aria-label="Find in PDF"
            aria-pressed={searchOpen}
            disabled={!ready}
            onClick={() => setSearchOpen((value) => !value)}
          >
            <Search size={14} />
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="pdf-search-bar">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label="Find text in PDF"
            placeholder="Find in document…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                moveMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="pdf-search-count" aria-live="polite">
            {searching
              ? "Searching…"
              : query.trim()
                ? `${matchingPages.length} ${matchingPages.length === 1 ? "page" : "pages"}`
                : ""}
          </span>
          <button
            type="button"
            title="Previous matching page"
            aria-label="Previous matching page"
            disabled={!matchingPages.length}
            onClick={() => moveMatch(-1)}
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            title="Next matching page"
            aria-label="Next matching page"
            disabled={!matchingPages.length}
            onClick={() => moveMatch(1)}
          >
            <ArrowDown size={13} />
          </button>
          <button
            type="button"
            title="Close PDF search"
            aria-label="Close PDF search"
            onClick={() => setSearchOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="pdf-error" role="alert">
          {error}
        </div>
      )}
      <div
        className="pdf-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="PDF preview"
        aria-busy={loading || rendering}
      >
        {ready ? (
          <div
            className="pdf-page"
            ref={sheet}
            role="group"
            aria-label={`PDF page ${page} of ${pdf?.numPages}`}
          />
        ) : (
          <div className="pdf-empty">
            <div className="pdf-empty-art" aria-hidden="true">
              <span className="pdf-empty-orbit" />
              <span className="pdf-empty-symbol">ƒ</span>
              <span className="pdf-empty-star">✳</span>
            </div>
            <span className="pdf-empty-eyebrow">THE PRINTED PAGE</span>
            <h3>{loading ? "Setting the page…" : "Your ideas, typeset."}</h3>
            <p>
              {loading
                ? "Opening your compiled document."
                : "Compile your project to see it take shape. Every successful build appears right here."}
            </p>
            <span className="pdf-empty-rule" />
            <span className="pdf-empty-footnote">
              A little source. A beautiful document.
            </span>
          </div>
        )}
      </div>
      {ready && (loading || rendering) && (
        <div className="pdf-rendering" role="status">
          <LoaderCircle size={12} className="pdf-spin" /> Updating preview
        </div>
      )}
    </div>
  );
}
