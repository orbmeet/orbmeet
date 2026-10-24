import { useRef, useState, useEffect, useCallback } from "react";
import type { ImageImportPhase } from "../assets/import-image";
import { screenshotBrushAtom } from "./screenshot-tool";
import { useEditor, useValue, track } from "tldraw";
import { FileText, Loader2, PencilOff } from "lucide-react";
import { accent, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { progress } from "@orbmeet/ui/styles/animations";
import * as stylex from "@stylexjs/stylex";
import { boardAction, boardActionRow } from "../styles/board";
import { WHITEBOARD_IMAGE_ACCEPT_ATTR } from "../assets/whiteboard-image";
import {
  WHITEBOARD_ERROR_EVENT,
  type WhiteboardErrorDetail,
} from "../chrome/whiteboard-error-event";
import {
  useWhiteboardToolbarContext,
  setImageInputRef,
  setPasteHandler,
  setPdfInputRef,
  setPdfSourceOpener,
} from "./whiteboard-toolbar-context";
import type { PdfLibraryFile } from "../synced-whiteboard";
import { WhiteboardSelectionActions } from "../shapes/math/mathink-selection-action";
import { WhiteboardModal } from "../chrome/whiteboard-modal";
import { useWhiteboardToast } from "../chrome/use-whiteboard-toast";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { Input } from "@orbmeet/ui/react";
import { PDF_MAX_RENDER_PAGES } from "@orbmeet/whiteboard-core/pdf-geometry";
import { isAbortError } from "../editor/abort-signals";
import { PdfImportPartialError } from "../assets/pdf-import-partial-error";
import { countPdfPages } from "../assets/pdf-page-count";

const styles = stylex.create({
  /** The screenshot tool's per-frame brush rectangle. */
  brush: {
    position: "absolute",
    zIndex: 300,
    pointerEvents: "none",
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: accent.a500,
    borderRadius: 2,
    backgroundColor: `color-mix(in oklab, ${accent.a500} 8%, transparent)`,
  },
  brushRect: (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
  }),

  /** The pencil-only pill, warning-coloured because it blocks touch input. */
  penMode: {
    position: "absolute",
    left: "50%",
    zIndex: boardZIndex.chrome,
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w300,
    backgroundColor: `color-mix(in oklab, ${warning.w50} 90%, transparent)`,
    backdropFilter: "blur(4px)",
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: warning.w700,
    boxShadow: shadows.hairline,
    cursor: "pointer",
    transform: { default: "translateX(-50%)", ":active": "translateX(-50%) scale(0.95)" },
    transitionProperty: "transform",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  penModeCompact: { top: space.s4 },

  hiddenInput: { display: "none" },

  /** Import progress, riding the foot of the board. */
  importChip: {
    position: "absolute",
    bottom: space.s6,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: boardZIndex.panel,
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${neutral.n900} 10%, transparent)`,
    backgroundColor: glass.panel,
    backdropFilter: "blur(4px)",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    boxShadow: shadows.hairline,
  },
  importSpinner: { color: neutral.n500 },
  importLabel: { fontFamily: "inherit", fontSize: text.xs, lineHeight: leading.xs, color: neutral.n600 },

  /** The Space's PDF list. */
  libraryScroll: { marginTop: space.s4, maxHeight: "16rem", overflowY: "auto" },
  libraryLoading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s8,
    color: neutral.n400,
  },
  libraryEmpty: {
    paddingBlock: space.s6,
    textAlign: "center",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n500,
  },
  libraryList: { display: "flex", flexDirection: "column", gap: space.s1, listStyle: "none", margin: 0, padding: 0 },
  libraryRow: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    borderWidth: 0,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    textAlign: "left",
    cursor: "pointer",
  },
  libraryFileIcon: { color: neutral.n400, flexShrink: 0 },
  libraryFileNameWrap: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  libraryFileName: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n800,
  },
  libraryFileSize: { display: "block", fontSize: text.xs, lineHeight: leading.xs, color: neutral.n500 },

  /** Events must reach the dialogs even where tldraw's canvas has parked
      pointer events — the old markup said so on the dialog itself. */
  dialogSurface: { pointerEvents: "auto" },
  rangeSection: { marginTop: space.s4 },
  rangeFields: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.s3 },
  rangeHint: {
    marginTop: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: neutral.n500,
  },
});

function useAbortableImport() {
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);

  return useCallback(async <T,>(operation: (signal: AbortSignal) => Promise<T>) => {
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }, []);
}

/**
 * Renders a dashed selection rectangle while the screenshot tool is active.
 * Converts page-space brush coordinates to viewport space so the rect tracks
 * correctly at any zoom level.
 */
const ScreenshotBrushOverlay = track(function ScreenshotBrushOverlay() {
  const editor = useEditor();
  const brush = useValue("screenshot brush", () => screenshotBrushAtom.get(), []);

  if (!brush || brush.w < 1 || brush.h < 1) return null;

  const tl = editor.pageToViewport({ x: brush.x, y: brush.y });
  const br = editor.pageToViewport({ x: brush.x + brush.w, y: brush.y + brush.h });

  return (
    <div
      {...stylex.props(
        styles.brush,
        styles.brushRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y),
      )}
    />
  );
});

const PenModeIndicator = track(function PenModeIndicator() {
  const editor = useEditor();
  const { isCompactChrome } = useWhiteboardToolbarContext();
  const isPenMode = useValue("isPenMode", () => editor.getInstanceState().isPenMode, [editor]);

  // A regular board shows it in the palette (see `PenModeToggle`).
  if (!isPenMode || !isCompactChrome) return null;

  return (
    <button
      type="button"
      onClick={() => editor.updateInstanceState({ isPenMode: false })}
      {...stylex.props(styles.penMode, styles.penModeCompact)}
      title="Pencil-only mode active — tap to allow finger input"
      aria-label="Exit pencil-only mode"
    >
      <PencilOff size={14} />
      <span>Pencil Only — tap to use fingers</span>
    </button>
  );
});

export function WhiteboardCanvasOverlays() {
  return (
    <>
      <PenModeIndicator />
      <ScreenshotBrushOverlay />
      <WhiteboardSelectionActions />
      <WhiteboardClipboardPaste />
      <WhiteboardImageImport />
      <WhiteboardPdfImport />
    </>
  );
}

/**
 * Clipboard paste: reads image from clipboard and imports to current page.
 */
function WhiteboardClipboardPaste() {
  const editor = useEditor();
  const addToast = useWhiteboardToast();
  const { pageManager, onPagesChanged, currentPage, uploadFile } =
    useWhiteboardToolbarContext();
  const runImport = useAbortableImport();

  useEffect(() => {
    const handleWhiteboardError = (event: Event) => {
      const detail =
        event instanceof CustomEvent &&
        event.detail &&
        typeof event.detail === "object" &&
        typeof (event.detail as { message?: unknown }).message === "string"
          ? (event.detail as WhiteboardErrorDetail)
          : null;

      addToast({
        title: detail?.title ?? "Whiteboard error",
        description: detail?.message ?? "Something went wrong.",
        variant: "error",
      });
    };

    window.addEventListener(WHITEBOARD_ERROR_EVENT, handleWhiteboardError);
    return () => {
      window.removeEventListener(WHITEBOARD_ERROR_EVENT, handleWhiteboardError);
    };
  }, [addToast]);

  const handlePaste = useCallback(async () => {
    if (!pageManager || !uploadFile) return;

    try {
      if (!navigator.clipboard?.read) {
        addToast({
          variant: "warning",
          title: "Clipboard not available",
          description:
            "Your browser doesn't support clipboard access. Try Ctrl+V / Cmd+V instead.",
        });
        return;
      }

      await runImport(async (signal) => {
        const items = await navigator.clipboard.read();
        signal.throwIfAborted();
        let imageFile: File | null = null;

        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const ext = imageType.split("/")[1]?.split("+")[0] || "png";
            imageFile = new File([blob], `pasted-image.${ext}`, {
              type: imageType,
            });
            break;
          }
        }

        if (!imageFile) {
          addToast({
            title: "No image in clipboard",
            description: "Copy an image first, then tap the paste button.",
            variant: "info",
          });
          return;
        }

        const { importImageToWhiteboard } = await import("../assets/import-image");
        signal.throwIfAborted();
        await importImageToWhiteboard(
          editor,
          imageFile,
          pageManager,
          currentPage,
          { uploadFile, signal },
        );

        signal.throwIfAborted();
        onPagesChanged?.();
        addToast({
          title: "Image pasted",
          description: "Added clipboard image to whiteboard",
          variant: "success",
        });
      });
    } catch (err) {
      if (isAbortError(err)) return;
      const isDenied =
        err instanceof DOMException && err.name === "NotAllowedError";
      addToast({
        variant: "error",
        title: isDenied ? "Clipboard permission denied" : "Paste failed",
        description: isDenied
          ? "Allow clipboard access when prompted, then try again."
          : err instanceof Error
            ? err.message
            : "Could not read image from clipboard.",
      });
    }
  }, [editor, pageManager, onPagesChanged, runImport, addToast, currentPage, uploadFile]);

  useEffect(() => {
    setPasteHandler(editor, () => {
      void handlePaste();
    });
    return () => setPasteHandler(editor, null);
  }, [editor, handlePaste]);

  return null;
}

/**
 * Image import: file input + insert on current page.
 */
function WhiteboardImageImport() {
  const editor = useEditor();
  const addToast = useWhiteboardToast();
  const { pageManager, onPagesChanged, currentPage, uploadFile } =
    useWhiteboardToolbarContext();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<ImageImportPhase>("preparing");
  const runImport = useAbortableImport();

  useEffect(() => {
    setImageInputRef(editor, imageInputRef);
    return () => setImageInputRef(editor, { current: null });
  }, [editor]);

  const handleImageFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !pageManager) return;

      setIsImporting(true);
      setImportPhase("preparing");
      try {
        await runImport(async (signal) => {
          const { importImageToWhiteboard } = await import("../assets/import-image");
          signal.throwIfAborted();
          await importImageToWhiteboard(
            editor,
            file,
            pageManager,
            currentPage,
            { onPhaseChange: setImportPhase, uploadFile, signal }
          );

          signal.throwIfAborted();
          onPagesChanged?.();
          addToast({
            title: "Image imported",
            description: `Added ${file.name} to whiteboard`,
            variant: "success",
          });
        });
      } catch (err) {
        if (isAbortError(err)) return;
        addToast({
          variant: "error",
          title: "Import failed",
          description:
            err instanceof Error ? err.message : "Failed to import image",
        });
      } finally {
        setIsImporting(false);
      }
    },
    [currentPage, editor, onPagesChanged, pageManager, runImport, addToast, uploadFile]
  );

  if (!pageManager) return null;

  return (
    <>
      <input
        type="file"
        ref={imageInputRef}
        onChange={(event) => {
          void handleImageFileSelected(event);
        }}
        accept={WHITEBOARD_IMAGE_ACCEPT_ATTR}
        {...stylex.props(styles.hiddenInput)}
      />
      {isImporting && importPhase !== "uploading" && (
        <div {...stylex.props(styles.importChip)}>
          <Loader2 size={12} {...stylex.props(progress.spin, styles.importSpinner)} />
          <span {...stylex.props(styles.importLabel)}>
            {importPhase === "placing"
                ? "Placing image..."
                : "Preparing image..."}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * PDF import: file input + placement dialog + progress.
 */
type PendingPdfSource =
  | { type: "upload"; file: File }
  | { type: "library"; fileId: string; filename: string }
  /** Being filed in the Space while the range is chosen; resolves to its id. */
  | { type: "saving"; file: File; fileId: Promise<string> };

function WhiteboardPdfImport() {
  const editor = useEditor();
  const addToast = useWhiteboardToast();
  const {
    pageManager,
    onPagesChanged,
    currentPage,
    onPageChange,
    whiteboardUrl,
    whiteboardToken,
    canEditWhiteboard,
    canManagePages,
    pdfLibrary,
  } = useWhiteboardToolbarContext();
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [pendingPdfSource, setPendingPdfSource] = useState<PendingPdfSource | null>(null);
  const [showPlacementDialog, setShowPlacementDialog] = useState(false);
  const [showSourceDialog, setShowSourceDialog] = useState(false);
  const [pageRangeStart, setPageRangeStart] = useState("");
  const [pageRangeEnd, setPageRangeEnd] = useState("");
  /** The chosen file's page count, once known; a library file has none. */
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const countedFileRef = useRef<File | null>(null);
  const [libraryFiles, setLibraryFiles] = useState<PdfLibraryFile[] | null>(null);
  // Someone who can draw is not always someone who can read the Space's files
  // (a signed-in visitor from outside it, say). For them the library is not an
  // error to show: their PDF goes straight onto the board, unfiled.
  const [libraryUnreadable, setLibraryUnreadable] = useState(false);
  const libraryRequestGenerationRef = useRef(0);
  const runImport = useAbortableImport();

  // A response belongs to the exact permission/library generation that issued
  // it. Replacing the context or losing edit access invalidates both list and
  // save work; late promises must not reopen dialogs or install a file from the
  // previous Space.
  useEffect(() => {
    const requestGeneration = libraryRequestGenerationRef;
    libraryRequestGenerationRef.current++;
    setShowSourceDialog(false);
    setShowPlacementDialog(false);
    setPendingPdfSource(null);
    setPageRangeStart("");
    setPageRangeEnd("");
    setLibraryFiles(null);
    setLibraryUnreadable(false);
    return () => {
      requestGeneration.current++;
    };
  }, [canEditWhiteboard, pdfLibrary]);

  // The hidden input is the only entry point the toolbar knows about. With a
  // Space library wired up, opening it first would skip straight to the disk
  // picker and lose the "insert the file you already have" case, so the click
  // is intercepted into the source dialog instead.
  const formatFileSize = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  const openPdfSource = useCallback(() => {
    if (!pageManager || !canEditWhiteboard || isImporting) return;
    if (!pdfLibrary) {
      pdfInputRef.current?.click();
      return;
    }
    setLibraryFiles(null);
    setLibraryUnreadable(false);
    setShowSourceDialog(true);
    const generation = ++libraryRequestGenerationRef.current;
    void pdfLibrary
      .list()
      .then((files) => {
        if (generation === libraryRequestGenerationRef.current) setLibraryFiles(files);
      })
      .catch(() => {
        if (generation !== libraryRequestGenerationRef.current) return;
        setLibraryFiles([]);
        setLibraryUnreadable(true);
      });
  }, [canEditWhiteboard, isImporting, pageManager, pdfLibrary]);

  useEffect(() => {
    setPdfInputRef(editor, pdfInputRef);
    setPdfSourceOpener(editor, openPdfSource);
    return () => {
      setPdfInputRef(editor, { current: null });
      setPdfSourceOpener(editor, null);
    };
  }, [editor, openPdfSource]);

  const handlePdfFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !pageManager || !canEditWhiteboard) return;
      setShowSourceDialog(false);
      // Counted while the file is filed and the dialog opens; a late answer
      // for a file since replaced is dropped.
      countedFileRef.current = file;
      setPdfPageCount(null);
      void countPdfPages(file).then((count) => {
        if (countedFileRef.current === file) setPdfPageCount(count);
      });
      if (!pdfLibrary || libraryUnreadable) {
        setPendingPdfSource({ type: "upload", file });
        setShowPlacementDialog(true);
        return;
      }
      // File it in the Space before inserting it. That is what makes the source
      // document reusable next week rather than surviving only as rasters. The
      // filing runs while the range is chosen rather than before the question
      // is asked: the two waits used to come one after the other.
      const fileId = pdfLibrary.save(file).then((saved) => saved.fileId);
      // Read when the import starts; until then a failure has nobody to tell.
      fileId.catch(() => {});
      setPendingPdfSource({ type: "saving", file, fileId });
      setShowPlacementDialog(true);
    },
    [canEditWhiteboard, libraryUnreadable, pageManager, pdfLibrary]
  );

  const handleLibraryFileChosen = useCallback(
    (file: PdfLibraryFile) => {
      setShowSourceDialog(false);
      countedFileRef.current = null;
      setPdfPageCount(null);
      setPendingPdfSource({
        type: "library",
        fileId: file.id,
        filename: file.filename,
      });
      setShowPlacementDialog(true);
    },
    []
  );

  const handlePdfImportWithPlacement = useCallback(
    async (placement: "on" | "after") => {
      const startText = pageRangeStart.trim();
      const endText = pageRangeEnd.trim();
      let pageRange: { start: number; end: number } | undefined;
      if (startText || endText) {
        const start = Number(startText);
        const end = Number(endText);
        if (
          !startText ||
          !endText ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 1 ||
          end < start
        ) {
          addToast({
            variant: "error",
            title: "Invalid page range",
            description: "Enter both a starting and ending PDF page.",
          });
          return;
        }
        if (pdfPageCount !== null && end > pdfPageCount) {
          addToast({
            variant: "error",
            title: "Invalid page range",
            description: `This PDF has ${pdfPageCount} page${pdfPageCount === 1 ? "" : "s"}.`,
          });
          return;
        }
        if (end - start + 1 > PDF_MAX_RENDER_PAGES) {
          addToast({
            variant: "error",
            title: "Page range is too large",
            description: `Select at most ${PDF_MAX_RENDER_PAGES} pages at a time.`,
          });
          return;
        }
        pageRange = { start, end };
      }

      setShowPlacementDialog(false);
      const source = pendingPdfSource;
      setPendingPdfSource(null);
      setPageRangeStart("");
      setPageRangeEnd("");
      if (!source || !pageManager || !whiteboardUrl || !whiteboardToken || !canEditWhiteboard) return;

      setIsImporting(true);

      let importSource:
        | { file: File; sourceFileId?: never }
        | { sourceFileId: string; file?: never };
      if (source.type === "saving") {
        setImportProgress("Adding to this Space's files…");
        try {
          importSource = { sourceFileId: await source.fileId };
        } catch (error) {
          setIsImporting(false);
          setImportProgress("");
          addToast({
            variant: "error",
            title: "Could not save the PDF",
            description: error instanceof Error ? error.message : "Please try again.",
          });
          return;
        }
      } else {
        importSource = source.type === "upload"
          ? { file: source.file }
          : { sourceFileId: source.fileId };
      }
      setImportProgress("Preparing PDF…");

      try {
        const result = await runImport(async (signal) => {
          const { importPdfToWhiteboard } = await import("../assets/import-pdf");
          signal.throwIfAborted();
          return importPdfToWhiteboard({
            ...importSource,
            pageManager,
            whiteboardUrl,
            token: whiteboardToken,
            onProgress: (current, total) => {
              setImportProgress(`Importing page ${current}/${total}…`);
            },
            insertPosition: { type: placement, page: currentPage },
            pageRange,
            signal,
          });
        });
        onPagesChanged?.();

        const targetPage =
          placement === "on" ? currentPage : currentPage + 1;
        onPageChange?.(targetPage);

        const filename = source.type === "library" ? source.filename : source.file.name;
        const description =
          result.pagesFailed > 0
            ? `Imported ${result.pagesImported} page${result.pagesImported === 1 ? "" : "s"} from ${filename} (${result.pagesFailed} failed)`
            : `Imported ${result.pagesImported} page${result.pagesImported === 1 ? "" : "s"} from ${filename}`;
        addToast({
          variant: result.pagesFailed > 0 ? "warning" : "success",
          title: result.pagesFailed > 0 ? "PDF partially imported" : "PDF imported",
          description,
        });
      } catch (err) {
        if (isAbortError(err)) return;
        if (err instanceof PdfImportPartialError) {
          onPagesChanged?.();
          // Cancelling keeps the pages already placed; say so without calling
          // the user's own cancel a failure.
          if (isAbortError(err.cause)) {
            const { pagesImported } = err;
            addToast({
              variant: "info",
              title: "PDF import cancelled",
              description: `${pagesImported} page${pagesImported === 1 ? " was" : "s were"} already added to the whiteboard.`,
            });
            return;
          }
        }
        addToast({
          variant: "error",
          title: "Import failed",
          description:
            err instanceof Error ? err.message : "Failed to import PDF",
        });
      } finally {
        setIsImporting(false);
        setImportProgress("");
      }
    },
    [
      pageManager,
      onPagesChanged,
      onPageChange,
      addToast,
      pendingPdfSource,
      currentPage,
      whiteboardUrl,
      whiteboardToken,
      canEditWhiteboard,
      runImport,
      pageRangeStart,
      pageRangeEnd,
      pdfPageCount,
    ]
  );

  if (!pageManager || !canEditWhiteboard) return null;

  return (
    <>
      <input
        type="file"
        ref={pdfInputRef}
        onChange={handlePdfFileSelected}
        accept="application/pdf"
        {...stylex.props(styles.hiddenInput)}
      />

      {isImporting && (
        <div {...stylex.props(styles.importChip)}>
          <Loader2 size={12} {...stylex.props(progress.spin, styles.importSpinner)} />
          <span {...stylex.props(styles.importLabel)}>{importProgress}</span>
        </div>
      )}

      {showSourceDialog && (
        <WhiteboardModal
          title="Add a PDF"
          description="Choose one you’ve used before, or upload a new one."
          onDismiss={() => setShowSourceDialog(false)}
          sx={styles.dialogSurface}
        >
          <div {...stylex.props(styles.libraryScroll)}>
            {libraryFiles === null ? (
              <div {...stylex.props(styles.libraryLoading)}>
                <Loader2 size={16} {...stylex.props(progress.spin)} />
              </div>
            ) : libraryFiles.length === 0 ? (
              <p {...stylex.props(styles.libraryEmpty)}>
                {libraryUnreadable
                  ? "This Space's files aren't open to you. Upload a PDF from this device instead."
                  : "No PDFs in this Space yet."}
              </p>
            ) : (
              <ul {...stylex.props(styles.libraryList)}>
                {libraryFiles.map((file) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      onClick={() => handleLibraryFileChosen(file)}
                      {...stylex.props(styles.libraryRow)}
                    >
                      <FileText size={16} {...stylex.props(styles.libraryFileIcon)} />
                      <span {...stylex.props(styles.libraryFileNameWrap)}>
                        <span {...stylex.props(styles.libraryFileName)}>
                          {file.filename}
                        </span>
                        <span {...stylex.props(styles.libraryFileSize)}>
                          {formatFileSize(file.size)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div {...stylex.props(boardActionRow.base, boardActionRow.split, boardActionRow.ruled)}>
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              {...stylex.props(boardAction.base, boardAction.outline)}
            >
              Upload new…
            </button>
            <button
              type="button"
              onClick={() => setShowSourceDialog(false)}
              {...stylex.props(boardAction.base, boardAction.ghost)}
            >
              Cancel
            </button>
          </div>
        </WhiteboardModal>
      )}

      {showPlacementDialog && (
        <WhiteboardModal
          title="Add PDF pages"
          description={
            <>
              Each PDF page becomes a board page everyone can draw on. You&rsquo;re on page{" "}
              {currentPage}.
            </>
          }
          onDismiss={() => {
            setShowPlacementDialog(false);
            setPendingPdfSource(null);
            setPageRangeStart("");
            setPageRangeEnd("");
          }}
          sx={styles.dialogSurface}
        >
          <div {...stylex.props(styles.rangeSection)}>
            <div {...stylex.props(styles.rangeFields)}>
              <Input
                label="From page"
                type="number"
                min={1}
                max={pdfPageCount ?? undefined}
                step={1}
                inputMode="numeric"
                placeholder="1"
                value={pageRangeStart}
                onChange={(event) => setPageRangeStart(event.target.value)}
              />
              <Input
                label="To page"
                type="number"
                min={1}
                max={pdfPageCount ?? undefined}
                step={1}
                inputMode="numeric"
                placeholder={pdfPageCount === null ? "Last" : String(pdfPageCount)}
                value={pageRangeEnd}
                onChange={(event) => setPageRangeEnd(event.target.value)}
              />
            </div>
            <p {...stylex.props(styles.rangeHint)}>
              {pdfPageCount === null
                ? "Leave both blank for the whole PDF."
                : `This PDF has ${pdfPageCount} page${pdfPageCount === 1 ? "" : "s"}. Leave both blank for all of them.`}{" "}
              Select up to {PDF_MAX_RENDER_PAGES} pages per import.
            </p>
          </div>
          <div {...stylex.props(boardActionRow.base)}>
            <button
              type="button"
              onClick={() => {
                setShowPlacementDialog(false);
                setPendingPdfSource(null);
                setPageRangeStart("");
                setPageRangeEnd("");
              }}
              {...stylex.props(boardAction.base, boardAction.outline)}
            >
              Cancel
            </button>
            {/* Placing "on" the current page reuses its frame, a structural
                page-frame mutation the server reserves for managers. Editors can
                still append pages, so only offer the reuse option to managers. */}
            {canManagePages && (
              <button
                type="button"
                onClick={() => {
                  void handlePdfImportWithPlacement("on");
                }}
                {...stylex.props(boardAction.base, boardAction.outline)}
              >
                Start on this page
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void handlePdfImportWithPlacement("after");
              }}
              {...stylex.props(boardAction.base, boardAction.confirm)}
            >
              {/* Not "Next page": that is the pager's button beside it, and
                  this one adds pages rather than going anywhere. */}
              Add after page {currentPage}
            </button>
          </div>
        </WhiteboardModal>
      )}
    </>
  );
}
