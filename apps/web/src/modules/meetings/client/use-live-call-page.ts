import * as React from "react";
import type { RouterHistory } from "@tanstack/react-router";
import { logWarn } from "@/lib/logger";

/** The class that holds the page still while a call owns it (styles.css). */
export const LIVE_CALL_PAGE_CLASS = "meet-route";

/**
 * While a call is live the page belongs to it: nothing the page itself does by
 * default may end the call. Four defaults do:
 *
 * - **Going back.** The page before a meeting is another document, so Back
 *   unloads the call: Android's back gesture, an iPhone's edge swipe, a mouse's
 *   back button, a two-finger swipe on a Mac. No style stops these (Safari
 *   swipes back whatever `overscroll-behavior` says, WebKit bug 240183). The
 *   call instead puts one history entry of its own in front of that page and
 *   refuses to step off it, which a page may do within its own document. The
 *   entry is added once and stays, so after the call the first Back lands on
 *   this page again; Leave is the way out of a call.
 * - **Overscroll that navigates.** Pull-to-refresh on Android, and swipe-back
 *   in Chrome and Firefox before it reaches history at all.
 *   `overscroll-behavior` turns them off, but only on the root element:
 *   Chrome 140 stopped reading it from `body`, and Firefox and Safari never
 *   did.
 * - **Drops that navigate.** A file or link dropped anywhere nothing handles it
 *   opens in this tab. Surfaces that take drops (the board) handle them first
 *   and call `preventDefault`, and text or a link dropped into a text field is
 *   typed into it; everything else refuses the drop.
 * - **A screen that sleeps.** Browsers hold the screen awake only while video
 *   plays, so an audio-only call on a phone dims, locks, and the page is
 *   frozen out of the call. A screen wake lock is held while the page shows;
 *   the browser releases it on hide, so it is taken again on return.
 */
export function useLiveCallPage(active: boolean, history: BackHoldingHistory): void {
  const backEntryAdded = React.useRef(false);
  React.useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add(LIVE_CALL_PAGE_CLASS);

    if (!backEntryAdded.current) {
      backEntryAdded.current = true;
      history.push(history.location.href);
    }
    const allowBack = history.block({
      blockerFn: ({ action }) => action === "BACK",
      // Leaving by any other road (a reload, a typed address, Leave itself) is not held.
      enableBeforeUnload: false,
    });

    const refuseUnhandledDrag = (event: DragEvent) => {
      if (event.defaultPrevented || takesTextDrop(event)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", refuseUnhandledDrag);
    window.addEventListener("drop", refuseUnhandledDrag);

    const releaseWakeLock = holdScreenWakeLock();

    return () => {
      root.classList.remove(LIVE_CALL_PAGE_CLASS);
      allowBack();
      window.removeEventListener("dragover", refuseUnhandledDrag);
      window.removeEventListener("drop", refuseUnhandledDrag);
      releaseWakeLock();
    };
  }, [active, history]);
}

/** What holding Back needs of the router's history. */
export type BackHoldingHistory = Pick<RouterHistory, "location" | "push" | "block">;

const TEXT_FIELD = [
  "textarea",
  "input:not([type])",
  ...["text", "search", "url", "email", "tel", "password"].map((type) => `input[type="${type}"]`),
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");

/**
 * A drop the browser types into the field under it: text or a link over an
 * enabled, writable text field. A file is never typed in; dropped on a text
 * field it would still open in the tab.
 */
function takesTextDrop(event: DragEvent): boolean {
  if (event.dataTransfer?.types?.includes("Files")) return false;
  const field = event.target instanceof Element ? event.target.closest(TEXT_FIELD) : null;
  if (!field) return false;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return !field.disabled && !field.readOnly;
  }
  return true;
}

/** Keeps the screen on while the page is visible. Returns a release function. */
function holdScreenWakeLock(): () => void {
  const wakeLock = typeof navigator === "undefined" ? undefined : navigator.wakeLock;
  if (!wakeLock) return () => {};

  let disposed = false;
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;

  const acquire = async () => {
    if (disposed || requesting || document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;
    requesting = true;
    try {
      const next = await wakeLock.request("screen");
      if (disposed) void next.release().catch(() => undefined);
      else sentinel = next;
    } catch (error) {
      // Refused (battery saver, policy): the call goes on without it.
      logWarn("[Meeting] Screen wake lock unavailable:", error);
    } finally {
      requesting = false;
    }
  };

  const handleVisibilityChange = () => void acquire();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void acquire();

  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
