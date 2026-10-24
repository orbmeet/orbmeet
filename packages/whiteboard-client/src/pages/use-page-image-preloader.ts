import { useEffect, useRef } from "react";
import type { Editor } from "tldraw";
import type { WhiteboardPage } from "./page-manager";

const PRELOAD_WINDOW = [0, 1, -1, 2, -2];
const FAILED_PRELOAD_BASE_DELAY_MS = 30_000;
const FAILED_PRELOAD_MAX_DELAY_MS = 5 * 60_000;

export function usePageImagePreloader(
  editor: Editor | null,
  pages: WhiteboardPage[],
  currentPage: number,
  resolveAssetUrl?: (src: string) => string,
): void {
  const preloadedRef = useRef(new Set<string>());
  const failedRef = useRef(new Map<string, { attempts: number; nextRetryAt: number }>());

  useEffect(() => {
    if (!editor || pages.length === 0 || currentPage < 1) return;

    let rafId: number | null = null;
    const pendingImages = new Map<HTMLImageElement, string>();
    const preloaded = preloadedRef.current;
    const failedPreloads = failedRef.current;

    const preloadVisibleWindow = () => {
      for (const delta of PRELOAD_WINDOW) {
        const pageNum = currentPage + delta;
        if (pageNum < 1 || pageNum > pages.length) continue;

        const page = pages[pageNum - 1];
        if (!page) continue;

        const childIds = editor.getSortedChildIdsForParent(page.id);
        for (const childId of childIds) {
          const shape = editor.getShape(childId);
          if (!shape || shape.type !== "image") continue;

          const { assetId } = (shape).props;
          if (!assetId) continue;

          const asset = editor.getAsset(assetId);
          if (!asset) continue;

          let src = (asset.props as { src?: string | null }).src;
          if (!src || src.startsWith("blob:")) continue;

          if (resolveAssetUrl) {
            src = resolveAssetUrl(src);
          }

          const failed = failedPreloads.get(src);
          if (failed && failed.nextRetryAt > Date.now()) continue;
          if (preloaded.has(src)) continue;
          preloaded.add(src);

          const img = new Image();
          pendingImages.set(img, src);
          img.decoding = "async";
          img.fetchPriority = delta === 0 ? "high" : "low";
          img.onload = () => {
            pendingImages.delete(img);
            failedPreloads.delete(src);
            img.onload = null;
            img.onerror = null;
          };
          img.onerror = () => {
            pendingImages.delete(img);
            preloaded.delete(src);
            const attempts = (failedPreloads.get(src)?.attempts ?? 0) + 1;
            failedPreloads.set(src, {
              attempts,
              nextRetryAt: Date.now() + Math.min(
                FAILED_PRELOAD_MAX_DELAY_MS,
                FAILED_PRELOAD_BASE_DELAY_MS * 2 ** Math.min(attempts - 1, 4),
              ),
            });
            img.onload = null;
            img.onerror = null;
          };
          img.src = src;
        }
      }
    };

    const schedulePreload = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        preloadVisibleWindow();
      });
    };

    schedulePreload();
    const unsubscribe = editor.store.listen(schedulePreload, { scope: "document" });

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      for (const [image, src] of pendingImages) {
        image.onload = null;
        image.onerror = null;
        // Cleanup canceled an in-flight request, not a successful preload.
        // Let the next mounted window try the same source again.
        preloaded.delete(src);
      }
      pendingImages.clear();
      unsubscribe();
    };
  }, [editor, pages, currentPage, resolveAssetUrl]);
}
