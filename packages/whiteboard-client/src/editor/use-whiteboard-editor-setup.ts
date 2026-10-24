import { useEffect, type RefObject } from "react";
import {
  AssetRecordType,
  getHashForString,
  type Editor,
} from "tldraw";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  WHITEBOARD_SYNC_ROUTES,
} from "@orbmeet/whiteboard-core/protocol";
import { isSafeExternalBrowserUrl } from "@orbmeet/whiteboard-core/public-host";
import { whiteboardSyncUrl } from "../sync/service-endpoints";
import { registerPageFrameProtection } from "../shapes/page/protect-page-frames";
import { registerMathTextPaste } from "../shapes/math/math-text-shapes";
import { configureCoalescedPointerEvents } from "./disable-coalesced-pointer-events";
import { registerStrayPenStrokeFilter } from "./filter-stray-pen-strokes";
import { registerShapeAuthorStamp } from "./shape-author-stamp";
import type { ShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";
import {
  registerShapeParentingSideEffect,
  reparentOrphanedShapes,
} from "./shape-parenting";
import { setScreenshotUploadFile } from "../toolbar/screenshot-tool";
import type { PageManager } from "../pages/page-manager";
import type { UploadFileFn } from "../assets/use-whiteboard-asset-store";

interface WhiteboardEditorSetupOptions {
  editor: Editor | null;
  uploadFile?: UploadFileFn;
  disableCoalescedPointerEvents: boolean;
  whiteboardUrl: string;
  tokenRef: RefObject<string>;
  canEdit: boolean;
  syncReady: boolean;
  pageManagerRef: RefObject<PageManager | null>;
  onActionError: (message: string) => void;
  /** Who new shapes are stamped as; null until the token names a user. */
  author: ShapeAuthor | null;
}

/** Install editor integrations whose lifetime is scoped to one tldraw editor. */
export function useWhiteboardEditorSetup({
  editor,
  uploadFile,
  disableCoalescedPointerEvents,
  whiteboardUrl,
  tokenRef,
  canEdit,
  syncReady,
  pageManagerRef,
  onActionError,
  author,
}: WhiteboardEditorSetupOptions): void {
  useEffect(() => {
    if (!editor) return;
    setScreenshotUploadFile(editor, uploadFile ?? null);
    return () => setScreenshotUploadFile(editor, null);
  }, [editor, uploadFile]);

  useEffect(() => {
    if (!editor) return;
    const isCoarsePointer =
      typeof window !== "undefined"
        ? window.matchMedia("(pointer: coarse)").matches
        : false;
    editor.updateInstanceState({
      isDebugMode: false,
      isChatting: false,
      isCoarsePointer,
      isPenMode: false,
    });
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    return registerPageFrameProtection(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    return registerMathTextPaste(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    configureCoalescedPointerEvents(editor, disableCoalescedPointerEvents);
  }, [editor, disableCoalescedPointerEvents]);

  useEffect(() => {
    if (!editor) return;
    return registerStrayPenStrokeFilter(editor);
  }, [editor]);

  const authorId = author?.id;
  const authorName = author?.name;
  useEffect(() => {
    if (!editor || authorId === undefined || authorName === undefined) return;
    return registerShapeAuthorStamp(editor, { id: authorId, name: authorName });
  }, [editor, authorId, authorName]);

  useEffect(() => {
    if (!editor || !whiteboardUrl) return;
    const unfurlAborter = new AbortController();

    editor.registerExternalAssetHandler("url", async ({ url }) => {
      let title = "";
      let description = "";
      let image = "";
      const canPreview = isSafeExternalBrowserUrl(url);

      if (!canPreview) {
        onActionError(
          "Link previews are unavailable for private or local addresses.",
        );
      } else {
        try {
          const response = await fetch(
            whiteboardSyncUrl(whiteboardUrl, WHITEBOARD_SYNC_ROUTES.unfurl),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${tokenRef.current}`,
              },
              body: JSON.stringify({ url }),
              signal: unfurlAborter.signal,
            },
          );
          if (response.ok) {
            const data: unknown = await response.json();
            if (data && typeof data === "object") {
              const record = data as Record<string, unknown>;
              title = typeof record.title === "string"
                ? record.title.slice(
                    0,
                    WHITEBOARD_CONFIG.MAX_BOOKMARK_TITLE_LENGTH,
                  )
                : "";
              description = typeof record.description === "string"
                ? record.description.slice(
                    0,
                    WHITEBOARD_CONFIG.MAX_BOOKMARK_DESCRIPTION_LENGTH,
                  )
                : "";
              image = isSafeExternalBrowserUrl(record.image)
                ? record.image
                : "";
            }
          }
        } catch {
          // A preview is optional; the hostname fallback below remains useful.
        }
      }

      if (!title) {
        try {
          title = new URL(url).hostname;
        } catch {
          title = url;
        }
        title = title.slice(0, WHITEBOARD_CONFIG.MAX_BOOKMARK_TITLE_LENGTH);
      }

      return {
        id: AssetRecordType.createId(getHashForString(url)),
        typeName: "asset" as const,
        type: "bookmark" as const,
        props: {
          src: canPreview ? url : "",
          title,
          description,
          image,
          favicon: "",
        },
        meta: {},
      };
    });

    return () => {
      unfurlAborter.abort();
      editor.registerExternalAssetHandler("url", null);
    };
  }, [editor, onActionError, tokenRef, whiteboardUrl]);

  useEffect(() => {
    import("../assets/import-image").catch(() => {});
  }, []);

  useEffect(() => {
    if (!editor) return;
    editor.setCurrentTool(canEdit ? "draw" : "hand");
  }, [editor, canEdit]);

  useEffect(() => {
    if (!editor) return;
    const cleanup = registerShapeParentingSideEffect(
      editor,
      () => pageManagerRef.current,
    );
    if (syncReady) {
      reparentOrphanedShapes(editor, () => pageManagerRef.current);
    }
    return cleanup;
  }, [editor, pageManagerRef, syncReady]);
}
