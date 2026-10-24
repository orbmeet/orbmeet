import { blur } from "@orbmeet/ui/styles/surfaces";
import { neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { safeArea } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { isMeetingDocumentPath } from "@/modules/meetings/contract/paths";
import { glass, scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { captureInstallPrompt } from "./install-offer";

const styles = stylex.create({
  banner: {
    position: "fixed",
    // Centred by `inset-inline: 0` + `margin-inline: auto`, not by the usual
    // `left: 50%` + `translateX(-50%)`. A fixed shrink-to-fit box resolves its
    // width against the space between its `left` edge and the container edge,
    // so anchoring that edge at the centre leaves it half the viewport to lay
    // out in and the transform only re-centres the result. On a phone that
    // collapsed this message to the width of its longest word — 221px of an
    // allowed 366px, six lines tall.
    insetInline: 0,
    marginInline: "auto",
    width: "fit-content",
    maxWidth: "calc(100vw - 1.5rem)",
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: glass.opaque,
    paddingInline: space.s4,
    paddingBlock: space.s3,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n700,
    boxShadow: `0 20px 25px -5px ${scrim.edge}, 0 8px 10px -6px ${scrim.edge}`,
  },
  /**
   * Connectivity. The app's only voice when the network is gone, so it sits
   * above everything — and below the notch rather than under it, so the camera
   * housing is never the thing that covers it.
   */
  alert: {
    top: `calc(${safeArea.top} + 0.75rem)`,
    zIndex: zIndex.toast,
  },
});

// A page loaded within this window is already running the deploy the update
// check just discovered (documents are network-first), so reloading it after
// the silent activation below would be a visible no-op.
const FRESH_PAGE_WINDOW_MS = 30_000;

export function PwaStatus() {
  // Server runtimes (Node, workerd) define `navigator` without `onLine`, so a
  // plain `navigator.onLine` read is `undefined` there and SSR'd the offline
  // banner into every document. Treat only an explicit `false` as offline.
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false
  );
  // The install prompt fires once, early, wherever the visit began; capture it
  // here at the root so the shell's offer can use it whenever it mounts.
  useEffect(() => captureInstallPrompt(), []);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let disposed = false;
    let updateTimer: number | undefined;
    let checkForUpdate: (() => void) | undefined;

    // Updates apply silently. Documents are network-first and assets are
    // content-hashed, so a freshly loaded page already runs the newest deploy;
    // there is never a user-meaningful "new version" to announce. The one
    // exception is a live meeting: activating an update purges the previous
    // version's caches, which a long-running meeting tab may still need for
    // lazy chunks — so meeting tabs leave the worker waiting (it activates via
    // a non-meeting tab, a later check, or when the last tab closes).
    const activateWaitingWorker = (registration: ServiceWorkerRegistration) => {
      if (!registration.waiting) return;
      if (isMeetingDocumentPath(window.location.pathname)) return;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    };

    const observeInstallingWorker = (
      registration: ServiceWorkerRegistration,
      worker: ServiceWorker | null,
    ) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (!disposed && worker.state === "installed" && navigator.serviceWorker.controller) {
          activateWaitingWorker(registration);
        }
      }, { once: true });
    };

    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
      if (disposed) return;
      activateWaitingWorker(registration);
      observeInstallingWorker(registration, registration.installing);
      registration.addEventListener("updatefound", () => {
        observeInstallingWorker(registration, registration.installing);
      });
      checkForUpdate = () => {
        if (document.visibilityState !== "visible") return;
        // A worker left waiting by a meeting tab gets another chance once
        // this tab has navigated off the meeting.
        activateWaitingWorker(registration);
        void registration.update();
      };
      document.addEventListener("visibilitychange", checkForUpdate);
      updateTimer = window.setInterval(checkForUpdate, 60 * 60 * 1_000);
    }).catch(() => {
      // The app remains usable as a normal web app when registration is blocked.
    });

    // Distinguishes an update taking over from the first install claiming the
    // page (clients.claim() also fires controllerchange).
    let hadController = navigator.serviceWorker.controller !== null;
    const handleControllerChange = () => {
      const isUpdate = hadController;
      hadController = true;
      if (!isUpdate) return;
      // The activated update has deleted the previous version's caches, so a
      // tab still running old code can no longer lazy-load its chunks. Reload
      // stale tabs; spare fresh pages (already on the new version) and live
      // meetings (which keep running already-loaded code).
      if (performance.now() < FRESH_PAGE_WINDOW_MS) return;
      if (isMeetingDocumentPath(window.location.pathname)) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    return () => {
      disposed = true;
      if (updateTimer !== undefined) window.clearInterval(updateTimer);
      if (checkForUpdate) document.removeEventListener("visibilitychange", checkForUpdate);
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  // Vite emits `vite:preloadError` when a dynamic import — a lazy route or vendor
  // chunk — fails to load, which after a deploy usually means the content-hashed
  // chunk this still-open tab is requesting was replaced. Documents are
  // network-first, so a reload fetches fresh HTML that points at the current
  // chunks. This is the same recovery the service-worker `controllerchange` path
  // performs, but it also covers tabs where the worker never activated (SW
  // registration blocked, or the deploy landed before the worker updated). The
  // exemptions mirror that path exactly: never yank a live meeting, and never
  // reload a page that only just loaded — there the miss is transient, so let
  // Vite's own retry run instead of risking a reload loop. Not gated on the
  // service worker: the event only fires from a built client, and it can precede
  // any `controllerchange`.
  useEffect(() => {
    const handlePreloadError = (event: Event) => {
      if (isMeetingDocumentPath(window.location.pathname)) return;
      if (performance.now() < FRESH_PAGE_WINDOW_MS) return;
      // We are reloading, so suppress the otherwise-uncaught import error. On the
      // exempt paths above we return without preventing default, letting the
      // error surface to the nearest route/query error boundary as usual.
      event.preventDefault();
      window.location.reload();
    };
    window.addEventListener("vite:preloadError", handlePreloadError);
    return () => window.removeEventListener("vite:preloadError", handlePreloadError);
  }, []);

  // Only connectivity is announced from here. The install offer lives in the
  // authed shell's own layout (`InstallOffer`), where it cannot cover content.
  if (!online) {
    return (
      <aside
        role="status"
        aria-live="polite"
        {...stylex.props(styles.banner, styles.alert, blur.md)}
      >
        <span>You’re offline. Live meetings need an internet connection.</span>
      </aside>
    );
  }

  return null;
}
