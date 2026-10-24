import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { DragEvent } from "react";
import {
  defaultHandleExternalUrlContent,
  type Editor,
  type TldrawOptions,
} from "tldraw";
import { isSafeExternalBrowserUrl } from "@orbmeet/whiteboard-core/public-host";
import {
  filterSupportedImageFiles,
  looksLikeWhiteboardImageUrl,
} from "./whiteboard-image";
import { emitWhiteboardError } from "../chrome/whiteboard-error-event";
import { WHITEBOARD_TLDRAW_OPTIONS } from "../editor/tldraw-options";
import type { PageNavigator } from "../pages/page-navigator";
import type { UploadFileFn } from "../synced-whiteboard";
import { useCommittedRef } from "@orbmeet/ui/react";
import { isAbortError } from "../editor/abort-signals";

type ClipboardPasteInfo = {
  content: {
    type: string;
    files?: File[];
  };
};
type BeforePasteInfo = Parameters<
  NonNullable<TldrawOptions["onBeforePasteFromClipboard"]>
>[0];

// Stable — no state depends on runtime values; hoisted to avoid recreating every render.
const DEFAULT_URL_HANDLER_OPTS = {
  toasts: {
    addToast: () => "orbmeet-url-fallback" as string,
    removeToast: () => "orbmeet-url-fallback" as string,
    clearToasts: () => undefined,
    toasts: [],
  },
  msg: (id?: string) => id ?? "",
} as unknown as Parameters<typeof defaultHandleExternalUrlContent>[2];

interface UseWhiteboardImageImportOptions {
  editor: Editor | null;
  canEditWhiteboard: boolean;
  uploadFile?: UploadFileFn;
  /** Read at import time: the page the viewer is on once the file has arrived. */
  navigator: PageNavigator | null;
  onPagesChanged: () => void;
}

export function useWhiteboardImageImport({
  editor,
  canEditWhiteboard,
  uploadFile,
  navigator,
  onPagesChanged,
}: UseWhiteboardImageImportOptions) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const activeImportControllersRef = useRef(new Set<AbortController>());

  const abortActiveImports = useCallback(() => {
    for (const controller of activeImportControllersRef.current) {
      controller.abort();
    }
    activeImportControllersRef.current.clear();
  }, []);

  const emitImportError = useCallback((message: string) => {
    emitWhiteboardError(message, { title: "Import failed" });
  }, []);

  const runImport = useCallback(
    async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      activeImportControllersRef.current.add(controller);
      try {
        return await operation(controller.signal);
      } finally {
        activeImportControllersRef.current.delete(controller);
      }
    },
    [],
  );

  useEffect(() => {
    return abortActiveImports;
  }, [abortActiveImports]);

  useEffect(() => {
    if (!canEditWhiteboard) abortActiveImports();
  }, [abortActiveImports, canEditWhiteboard]);

  const importImageFilesToCurrentPage = useCallback(
    (files: File[]) => runImport(async (signal) => {
      if (!canEditWhiteboard || !editor || !uploadFile) return false;

      if (!navigator) return false;
      const { pageManager } = navigator;

      const { supported: imageFiles, unsupportedImages } =
        filterSupportedImageFiles(files);
      if (imageFiles.length === 0) {
        if (unsupportedImages.length > 0) {
          throw new Error("Supported image formats: PNG, JPEG, GIF, WEBP");
        }
        return false;
      }

      const { importImageToWhiteboard } = await import("./import-image");
      const pageNumber = navigator.currentPage.get();
      const failedFiles: string[] = [];
      let importedCount = 0;
      for (let index = 0; index < imageFiles.length; index += 1) {
        try {
          await importImageToWhiteboard(editor, imageFiles[index], pageManager, pageNumber, {
            uploadFile,
            placementIndex: importedCount,
            signal,
          });
          importedCount += 1;
        } catch (error) {
          if (isAbortError(error)) throw error;
          failedFiles.push(imageFiles[index].name || `image ${index + 1}`);
        }
      }

      signal.throwIfAborted();
      if (importedCount > 0) onPagesChanged();
      if (failedFiles.length > 0) {
        const importedSummary = importedCount > 0
          ? `${importedCount} image${importedCount === 1 ? " was" : "s were"} imported. `
          : "";
        throw new Error(
          `${importedSummary}Could not import: ${failedFiles.join(", ")}`,
        );
      }
      return true;
    }),
    [
      canEditWhiteboard,
      editor,
      uploadFile,
      navigator,
      onPagesChanged,
      runImport,
    ],
  );

  const importExternalImageUrl = useCallback(
    (url: string) => runImport(async (signal) => {
      if (!canEditWhiteboard) {
        throw new Error("Write access is required to add images");
      }
      if (!editor || !uploadFile) {
        throw new Error("Whiteboard image uploads are unavailable");
      }

      if (!navigator) {
        throw new Error("Whiteboard page manager unavailable");
      }
      const { pageManager } = navigator;

      const {
        fetchExternalImage,
        importImageToWhiteboard,
      } = await import("./import-image");

      signal.throwIfAborted();
      if (!looksLikeWhiteboardImageUrl(url)) {
        throw new Error("URL does not point to an image");
      }

      const imageFile = await fetchExternalImage(url, signal);
      await importImageToWhiteboard(
        editor,
        imageFile,
        pageManager,
        navigator.currentPage.get(),
        { uploadFile, signal },
      );

      signal.throwIfAborted();
      onPagesChanged();
    }),
    [
      canEditWhiteboard,
      editor,
      uploadFile,
      navigator,
      onPagesChanged,
      runImport,
    ],
  );

  const handleBeforePasteFromClipboard = useCallback(
    async ({ content }: ClipboardPasteInfo) => {
      if (content.type !== "files" || !content.files?.length) return;

      try {
        const imported = await importImageFilesToCurrentPage(content.files);
        if (imported) {
          return false;
        }
      } catch (err) {
        if (isAbortError(err)) return false;
        console.error("[WB] Failed to import pasted image:", err);
        emitImportError(
          err instanceof Error ? err.message : "Could not import pasted image",
        );
        return false;
      }
    },
    [emitImportError, importImageFilesToCurrentPage],
  );

  const beforePasteHandlerRef = useCommittedRef(handleBeforePasteFromClipboard);

  const tldrawOptions = useMemo(
    () =>
      ({
        ...WHITEBOARD_TLDRAW_OPTIONS,
        onBeforePasteFromClipboard: (info: BeforePasteInfo) =>
          beforePasteHandlerRef.current(info),
      }) satisfies Partial<TldrawOptions>,
    [beforePasteHandlerRef],
  );

  const handleDragOver = useCallback((e: DragEvent<Element>) => {
    const dragTypes = Array.from(e.dataTransfer.types);
    const hasImagePayload =
      dragTypes.includes("Files") ||
      dragTypes.includes("text/uri-list");

    if (!hasImagePayload) return;
    e.preventDefault();
    setIsDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<Element>) => {
    if (e.currentTarget === e.target) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    setIsDraggingOver(false);
  }, []);

  useEffect(() => {
    if (!editor) return;
    if (!uploadFile) {
      editor.registerExternalContentHandler("files", null);
      return;
    }

    // re-registering the same content type replaces the previous handler in tldraw
    const handleFiles = async (files: File[]) => {
      if (!canEditWhiteboard) return;
      setIsDraggingOver(false);
      try {
        await importImageFilesToCurrentPage(files);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("[WB] Failed to import dropped image:", err);
        emitImportError(
          err instanceof Error ? err.message : "Could not import dropped image",
        );
      }
    };
    editor.registerExternalContentHandler("files", ({ files }) => {
      void handleFiles(files);
    });
    return () => {
      editor.registerExternalContentHandler("files", null);
    };
  }, [
    editor,
    canEditWhiteboard,
    emitImportError,
    uploadFile,
    importImageFilesToCurrentPage,
  ]);

  useEffect(() => {
    if (!editor) return;

    // re-registering the same content type replaces the previous handler in tldraw
    const handleUrl = async (
      externalContent: Parameters<typeof defaultHandleExternalUrlContent>[1],
    ) => {
      if (!canEditWhiteboard || !uploadFile) return;

      // Whatever this URL becomes — a bookmark, an imported image — it lands on
      // a synced record carrying the URL verbatim, and the sync server applies
      // exactly this rule to a record's `url` prop before accepting it (see
      // rooms/page-frame-guard.ts). A record it refuses is not a refused edit:
      // it closes the session with FORBIDDEN and the socket stops reconnecting,
      // so pasting a `mailto:` link or a private address ended the participant's
      // sync session. tldraw's own URL parsing is looser than the server's, so
      // the client has to agree with the server *before* creating the shape —
      // once it exists there is no longer a way to decline it politely.
      if (!isSafeExternalBrowserUrl(externalContent.url)) {
        emitImportError(
          "That link cannot be added to the whiteboard. Only public http(s) links are supported.",
        );
        return;
      }

      if (!looksLikeWhiteboardImageUrl(externalContent.url)) {
        await defaultHandleExternalUrlContent(
          editor,
          externalContent,
          DEFAULT_URL_HANDLER_OPTS,
        );
        return;
      }

      try {
        setIsDraggingOver(false);
        await importExternalImageUrl(externalContent.url);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("[WB] Failed to import dropped image URL:", err);
        emitImportError(
          err instanceof Error ? err.message : "Could not import dropped image",
        );
        await defaultHandleExternalUrlContent(
          editor,
          externalContent,
          DEFAULT_URL_HANDLER_OPTS,
        );
      }
    };
    editor.registerExternalContentHandler("url", (externalContent) => {
      void handleUrl(externalContent);
    });
    return () => {
      editor.registerExternalContentHandler("url", null);
    };
  }, [
    editor,
    canEditWhiteboard,
    uploadFile,
    emitImportError,
    importExternalImageUrl,
  ]);

  return {
    isDraggingOver,
    handleDragOver,
    handleDragLeave,
    handleDragEnd,
    tldrawOptions,
  };
}
