import { useEffect, useState } from "react";
import type { Editor } from "tldraw";
import type { WhiteboardPage } from "./page-manager";
import { boardCacheKey } from "./page-thumbnail-signature";
import {
  PageThumbnailScheduler,
  type PageThumbnail,
} from "./page-thumbnail-scheduler";

export interface PageThumbnails {
  /** Keyed by page shape id. Absent means "not rendered yet". */
  byPageId: ReadonlyMap<string, PageThumbnail>;
  /** Ref callback a card attaches so the hook can see whether it is on screen. */
  observe: (pageId: string) => (node: HTMLElement | null) => void;
}

/**
 * React adapter over `PageThumbnailScheduler`: keeps the thumbnail rail in sync
 * with editor, pages, current page, and visibility without scattering refs and
 * timers across half a dozen effects.
 */
export function useWhiteboardPageThumbnails({
  editor,
  pages,
  currentPage,
  enabled,
  whiteboardUrl,
  documentId,
  resolveAssetUrl,
}: {
  editor: Editor | null;
  pages: WhiteboardPage[];
  currentPage: number;
  enabled: boolean;
  /** Identifies the board for the cross-session raster cache. */
  whiteboardUrl?: string;
  /** Stable document identity; the sync endpoint is shared by many boards. */
  documentId?: string;
  resolveAssetUrl?: (src: string) => string;
}): PageThumbnails {
  const [byPageId, setByPageId] = useState<ReadonlyMap<string, PageThumbnail>>(
    () => new Map(),
  );

  // One scheduler for the component's life. Its ref callbacks are handed to
  // React, which can re-attach them after an effect cleanup without
  // re-rendering, so cleanup stops the scheduler rather than replacing it.
  const [scheduler] = useState(() => new PageThumbnailScheduler(setByPageId));

  const boardKey = boardCacheKey(whiteboardUrl, documentId);

  useEffect(() => {
    scheduler.sync({
      editor,
      pages,
      currentPage,
      enabled,
      boardKey,
      resolveAssetUrl,
    });
  }, [boardKey, currentPage, editor, enabled, pages, resolveAssetUrl, scheduler]);

  useEffect(() => () => scheduler.dispose(), [scheduler]);

  return { byPageId, observe: scheduler.observe };
}
