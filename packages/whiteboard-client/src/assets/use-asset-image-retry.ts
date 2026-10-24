import { useEffect } from "react";
import type { Editor } from "tldraw";

/** How many times a board image that failed to load is asked for again. */
const MAX_ATTEMPTS = 5;
/** The first wait; each later one doubles it (0.5s, 1s, 2s, 4s, 8s). */
const FIRST_DELAY_MS = 500;
const ATTEMPT_PARAM = "attempt";

/** Only the board's own stored assets: anything else failing is not ours to retry. */
export function isRetryableAssetUrl(src: string): boolean {
  return src.includes("/wb-assets/");
}

/** `src` asked for again, distinguishably, so the browser does not reuse the failure. */
export function withAttempt(src: string, attempt: number): string {
  const url = new URL(src, "http://localhost");
  url.searchParams.set(ATTEMPT_PARAM, String(attempt));
  return /^[a-z]+:/i.test(src) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Board images that fail to load are asked for again, a few times, with
 * backoff.
 *
 * An `<img>` that fails never retries on its own, so an image requested in the
 * moment before its bytes were served — a pasted image whose record reached
 * the canvas a beat before its object did — stayed an empty frame until the
 * next re-render, or until a reload. The server already serves pending assets
 * for this reason; this is the same promise from the other side, for any
 * window that remains.
 */
export function useAssetImageRetry(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    const container = editor.getContainer();
    const attempts = new WeakMap<HTMLImageElement, number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onError = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      const src = image.getAttribute("src") ?? "";
      if (!isRetryableAssetUrl(src)) return;
      const attempt = (attempts.get(image) ?? 0) + 1;
      if (attempt > MAX_ATTEMPTS) return;
      attempts.set(image, attempt);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (image.isConnected) image.setAttribute("src", withAttempt(src, attempt));
      }, FIRST_DELAY_MS * 2 ** (attempt - 1));
      timers.add(timer);
    };
    // `error` does not bubble: it is caught on its way down instead.
    container.addEventListener("error", onError, true);
    return () => {
      container.removeEventListener("error", onError, true);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, [editor]);
}
