import { atom, type Atom } from "@tldraw/state";
import type { Editor, TLEventInfo } from "tldraw";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { PageBand } from "./page-band";
import type { WhiteboardPage } from "../pages/page-manager";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";
import { calculateCameraPadding } from "../chrome/responsive-config";
import type { CameraConstraints } from "./camera-constraints";
import {
  isWhiteboardCameraInteractionActive,
  isWhiteboardCameraInteractionEndEvent,
} from "./whiteboard-camera-interaction";

const { ZOOM_STEPS } = WHITEBOARD_CONFIG;

/**
 * What the board is showing, as an intent rather than a camera.
 *
 * - `page`    a page from its top: where navigation lands.
 * - `follow`  the page the room's presenter is on (the room's navigation).
 *             A follower is shown that page whole, wherever on it the
 *             presenter is looking or writing: the presenter's scrolling and
 *             pen never move a follower's screen, only their page turns do.
 * - `own`     where the reader took the board themselves: the band they were
 *             looking at and their zoom relative to the page filling the
 *             board's width, or null while it is the page's own fit.
 *
 * Each is anchored to the document (a page and a place on it), never to
 * screen pixels, so it survives a resize, a panel opening and a page being
 * inserted above it: the camera is worked out again from the same intent.
 */
export type BoardView =
  | { kind: "page"; pageId: string }
  | { kind: "follow"; pageId: string }
  | { kind: "own"; pageId: string; rect: PageBand; relativeZoom: number | null };

/** A camera, as the page-space point at the middle of the visible band and the zoom. */
export interface FollowView {
  x: number;
  y: number;
  z: number;
}

type CameraPoint = { x: number; y: number; z: number };

/**
 * How quickly the camera closes on where it is going: the time it takes to
 * cover about two-thirds of the remaining distance. Short enough to read as
 * moving with a leader, long enough that the steps between their presence
 * updates are smoothed into one motion.
 */
const GLIDE_TIME_CONSTANT_MS = 90;

/** Under half a screen pixel away is there. */
const ARRIVED_SCREEN_PX = 0.5;

/** Zooms within this ratio of each other (as a log) are the same zoom. */
const ARRIVED_ZOOM_LOG = 1e-3;

/** A camera change whose zoom moved by more than this ratio (as a log) was a zoom, not a pan. */
const ZOOMED_LOG = 1e-4;

/**
 * How recently the reader must have pinched, scrolled or pressed a key for a
 * zoom the director did not write to be theirs.
 */
const ZOOM_INPUT_MS = 1_000;

/** Zooms within this ratio of each other are the same zoom, for saying whether the reader is at the page's fit. */
const SAME_ZOOM = 0.01;

/**
 * A reader's zoom this close to the fit is the fit: it stays fitted when the
 * board changes size rather than keeping a ratio nobody chose.
 */
const RESTING_ZOOM_TOLERANCE = 0.1;

/**
 * How long a view may sit in the pull room past the last page before it
 * springs back: past `usePullToAddPage`'s wheel idle delay (320ms), so a pull
 * that means to add a page does so first.
 */
const PULL_ROOM_RETURN_MS = 500;

/**
 * Where a view goes this frame, given where it is and where it is heading, or
 * null once it is there.
 *
 * The middle moves in a straight line and the zoom eases in proportion
 * (through its log), so zooming from 1× to 4× and back takes the same time,
 * and the point being looked at never swings off to the side on the way.
 */
export function stepTowards(current: FollowView, target: FollowView, elapsedMs: number): FollowView | null {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dLogZ = Math.log(target.z / current.z);
  if (
    Math.abs(dx) * current.z < ARRIVED_SCREEN_PX &&
    Math.abs(dy) * current.z < ARRIVED_SCREEN_PX &&
    Math.abs(dLogZ) < ARRIVED_ZOOM_LOG
  ) {
    return null;
  }
  const t = 1 - Math.exp(-Math.max(0, elapsedMs) / GLIDE_TIME_CONSTANT_MS);
  return { x: current.x + dx * t, y: current.y + dy * t, z: current.z * Math.exp(dLogZ * t) };
}

/** The reader is at the fit, or near enough that it is the fit. */
export function isRestingZoom(relativeZoom: number): boolean {
  if (!Number.isFinite(relativeZoom) || relativeZoom <= 0) return true;
  return Math.abs(relativeZoom - 1) <= RESTING_ZOOM_TOLERANCE;
}

/**
 * Everything the fit depends on, as one comparable value: the board's size
 * and the chrome that sets its insets. A camera change that comes with a new
 * geometry is the layout's; one that does not is the reader's.
 */
export function boardGeometryKey(
  viewport: { width: number; height: number },
  chrome: Pick<WhiteboardChromeConfig, "mode" | "toolbarVisible" | "isMeetingPhonePortrait" | "sideways" | "controlsHeightPx">,
): string {
  return [
    Math.round(viewport.width),
    Math.round(viewport.height),
    chrome.mode,
    chrome.toolbarVisible ? "tools" : "reader",
    chrome.isMeetingPhonePortrait ? "portrait" : "",
    chrome.sideways ? "sideways" : "",
    chrome.controlsHeightPx ?? "",
  ].join("|");
}

/** The next zoom step past `relative` in `direction`, as a zoom relative to the fit. */
export function nextZoomStep(relative: number, direction: 1 | -1): number {
  const steps = [...ZOOM_STEPS];
  if (direction > 0) return steps.find((step) => step > relative * 1.001) ?? steps[steps.length - 1];
  return [...steps].reverse().find((step) => step < relative * 0.999) ?? steps[0];
}

export interface CameraDirectorOptions {
  getPages: () => readonly WhiteboardPage[];
  getChrome: () => WhiteboardChromeConfig;
  /** The page shown when the view's page is gone and nothing else says where to be. */
  fallbackPageNumber?: () => number;
}

/**
 * The one thing that moves the board's camera on the board's behalf.
 *
 * It holds a `BoardView` and, whenever anything the camera depends on
 * changes — the board's size, the chrome, the pages, the view itself — works
 * the camera out again from it and moves there: at once, or gliding a little
 * each frame towards wherever the view is *now*, so a resize or a remote
 * insert in the middle of a move bends the move instead of fighting it.
 *
 * Zoom is the reader's own, and nobody else's zoom ever changes it. Until
 * they zoom, every page they go to is fitted (a wide page whole, a tall one
 * across its width: `CameraConstraints.getPageFitZoom`); scrolling from one
 * page onto another never changes the zoom. Once they pinch or use the zoom
 * buttons, their zoom is one number against the page filling the board's
 * width — the same on every page, since every page is as wide — and stays
 * with them from page to page, until "Fit". A follower is always shown the
 * leader's page whole, whatever their zoom.
 *
 * Every camera change it did not write is the reader's own: a scroll, a pinch,
 * a drag, tldraw's own zoom shortcuts. Each turns the view into `own`,
 * anchored where the reader left it, and is announced (`onOwnMove`) so that a
 * follower stops following. A change that arrives with a new board
 * geometry is the layout's, not the reader's (tldraw re-applies the camera
 * itself when the board is measured), and only re-places the view.
 */
export class CameraDirector {
  /** What the board is showing. */
  readonly view: Atom<BoardView | null> = atom("whiteboard view", null);
  /** The page the board is on: the page its view names, wherever the camera is on the way there. */
  readonly currentPage: Atom<number>;
  /** True while the director is gliding the camera somewhere. */
  readonly moving: Atom<boolean> = atom("whiteboard camera moving", false);
  /**
   * The reader's zoom: a number against the page filling the board's width,
   * or null for each page's own fit.
   */
  readonly zoomChoice: Atom<number | null> = atom("whiteboard zoom choice", null);

  private following = false;
  /**
   * The reader took the board while following. The leader's views are not
   * applied again until following starts afresh: the host learns of the move
   * a render later, and a frame of being carried back would undo it.
   */
  private followSuspended = false;
  /** The leader's page last followed: the same page handed in again changes nothing. */
  private followedPageId: string | null = null;
  /**
   * The view names a page that has not reached this document yet (a page
   * just added on the server, or a presenter's new page still syncing). The
   * board waits for it rather than standing in another page for it.
   */
  private awaiting = false;
  private writing = false;
  private foreignPending = false;
  /** A camera change the director did not write moved the zoom, since the last one it looked at. */
  private foreignZoomed = false;
  /** When the reader last pinched, scrolled or pressed a key: what a zoom of theirs comes from. */
  private zoomInputAt = Number.NEGATIVE_INFINITY;
  private appliedGeometry: string | null = null;
  /** The board changed size under a hand; re-place the view once it lifts. */
  private stale = false;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ownMoveListeners = new Set<() => void>();

  constructor(
    private readonly editor: Editor,
    private readonly constraints: CameraConstraints,
    private readonly options: CameraDirectorOptions,
    startPage = 1,
  ) {
    this.currentPage = atom("whiteboard current page", startPage);
  }

  // ─── Lifetime ──────────────────────────────────────────────────────────

  start(): () => void {
    const { editor } = this;
    const container = editor.getContainer();
    const onTick = (elapsed: number) => this.step(elapsed);
    const onEvent = (event: TLEventInfo) => {
      if (event.type === "pinch" || event.type === "wheel" || event.type === "keyboard") this.zoomInputAt = Date.now();
      if (this.stale && isWhiteboardCameraInteractionEndEvent(editor, event)) this.syncGeometry();
    };
    // Synchronous, unlike a store listener (batched to the next frame), so
    // whether a change is the director's own is known as it happens. The
    // response waits for the microtask after it: never a camera write from
    // inside tldraw's own camera update.
    const stopCamera = editor.sideEffects.registerAfterChangeHandler("camera", (prev, next) => {
      if (this.writing) return;
      if (Math.abs(Math.log(next.z / prev.z)) > ZOOMED_LOG) this.foreignZoomed = true;
      if (this.foreignPending) return;
      this.foreignPending = true;
      queueMicrotask(() => {
        this.foreignPending = false;
        const zoomed = this.foreignZoomed;
        this.foreignZoomed = false;
        this.onForeignCameraChange(zoomed);
      });
    });
    editor.on("tick", onTick);
    editor.on("event", onEvent);

    // The board's size: the container, the window, the visual viewport
    // (mobile browser bars), and the end of any transition or animation in
    // the meeting shell that moves the board without resizing it.
    const syncGeometry = () => this.syncGeometry();
    const doc = container.ownerDocument;
    const win = doc.defaultView ?? window;
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncGeometry) : null;
    resizeObserver?.observe(container);
    win.addEventListener("resize", syncGeometry);
    win.addEventListener("orientationchange", syncGeometry);
    win.visualViewport?.addEventListener("resize", syncGeometry);
    win.visualViewport?.addEventListener("scroll", syncGeometry);
    doc.addEventListener("transitionend", syncGeometry, { capture: true });
    doc.addEventListener("animationend", syncGeometry, { capture: true });
    this.syncGeometry();

    return () => {
      stopCamera();
      editor.off("tick", onTick);
      editor.off("event", onEvent);
      resizeObserver?.disconnect();
      win.removeEventListener("resize", syncGeometry);
      win.removeEventListener("orientationchange", syncGeometry);
      win.visualViewport?.removeEventListener("resize", syncGeometry);
      win.visualViewport?.removeEventListener("scroll", syncGeometry);
      doc.removeEventListener("transitionend", syncGeometry, { capture: true });
      doc.removeEventListener("animationend", syncGeometry, { capture: true });
      this.clearPullTimer();
      this.moving.set(false);
    };
  }

  /** Called when the reader takes the board themselves. Returns the unsubscriber. */
  onOwnMove(listener: () => void): () => void {
    this.ownMoveListeners.add(listener);
    return () => this.ownMoveListeners.delete(listener);
  }

  /**
   * Whether this reader is following a leader.
   *
   * Letting go moves nothing. The view is already where the leader is going,
   * so a follower let go mid-glide finishes it; one at rest keeps exactly
   * what is on their screen, as a place of their own, at the zoom they had.
   */
  setFollowing(following: boolean): void {
    if (following === this.following) return;
    this.following = following;
    this.followSuspended = false;
    this.followedPageId = null;
    if (following || this.moving.get()) return;
    const view = this.view.get();
    if (view?.kind === "follow") {
      const own = this.ownViewFor(this.editor.getCamera());
      if (own) this.view.set(own);
    }
  }

  /** Whether this reader is following a leader, and has not taken the board from them. */
  isFollowingLive(): boolean {
    return this.following && !this.followSuspended;
  }

  // ─── Views ─────────────────────────────────────────────────────────────

  /**
   * Show `view`: gliding there, or at once. A view whose page has not arrived
   * yet is shown as soon as it does; `pageNumber` is the page it will be, so
   * the board is on it from now — the next "add a page after this one" must
   * already count from it.
   */
  go(view: BoardView, { animate = true, pageNumber }: { animate?: boolean; pageNumber?: number } = {}): void {
    this.clearPullTimer();
    this.view.set(view);
    this.awaiting = !this.options.getPages().some((page) => page.id === view.pageId);
    if (this.awaiting && pageNumber !== undefined) this.currentPage.set(pageNumber);
    else this.updateCurrentPage();
    if (animate) {
      this.moving.set(true);
      return;
    }
    this.moving.set(false);
    this.place();
  }

  /**
   * Go to the presenter's page, while following them. The same page handed in
   * again changes nothing, so it can be handed in whenever the room's
   * navigation changes for any reason.
   */
  follow(pageId: string, options: { animate?: boolean; pageNumber?: number } = {}): void {
    if (!this.isFollowingLive() || pageId === this.followedPageId) return;
    this.followedPageId = pageId;
    this.go({ kind: "follow", pageId }, options);
  }

  /** The pages changed: re-place the view over the new document. */
  pagesChanged(): void {
    this.writeOptions();
    const view = this.view.get();
    if (this.awaiting && view) {
      if (!this.options.getPages().some((page) => page.id === view.pageId)) return;
      this.awaiting = false;
    }
    this.updateCurrentPage();
    if (!this.moving.get()) this.place();
  }

  /**
   * The board's size or chrome may have changed: measure it, and re-place the
   * view if it did. Not under a hand — shifting the coordinate space
   * mid-stroke draws a segment where the pen never went — but straight after.
   */
  syncGeometry(): void {
    if (isWhiteboardCameraInteractionActive(this.editor)) {
      this.stale = true;
      return;
    }
    this.stale = false;
    this.write(() => this.editor.updateViewportScreenBounds(this.editor.getContainer(), false));
    const geometry = this.geometryKey();
    if (geometry === this.appliedGeometry) return;
    this.appliedGeometry = geometry;
    const bounds = this.editor.getViewportScreenBounds();
    this.constraints.setCameraPadding(calculateCameraPadding({ width: bounds.width, height: bounds.height }));
    this.constraints.updateChrome(this.options.getChrome());
    this.writeOptions();
    if (!this.moving.get()) this.place();
  }

  // ─── Zoom ──────────────────────────────────────────────────────────────

  zoomIn(): void {
    this.zoomStep(1);
  }

  zoomOut(): void {
    this.zoomStep(-1);
  }

  /** Back to the page's fit, around what is in the middle now. */
  fit(): void {
    this.chooseZoom(null);
  }

  /**
   * The reader's zoom as the zoom control says it: null while they have not
   * zoomed (each page is fitted), otherwise a percentage of the page filling
   * the board's width.
   */
  zoomPercent(): number | null {
    const choice = this.zoomChoice.get();
    return typeof choice === "number" ? Math.round(choice * 100) : null;
  }

  /** How much of the page the board shows now, in page units. */
  visibleSize(): { w: number; h: number } {
    const bounds = this.constraints.getVisibleViewportBounds();
    return bounds ? { w: bounds.w, h: bounds.h } : { w: this.editor.getViewportPageBounds().w, h: this.editor.getViewportPageBounds().h };
  }

  /** The zoom now, against the page filling the board's width. */
  getRelativeZoom(): number {
    const width = this.constraints.getFitZoom();
    return width > 0 ? this.editor.getCamera().z / width : 1;
  }

  /** Take the reader to a camera of their own: they asked for it (a fit, a zoom step, Orb's shapes). */
  goOwnAt(camera: CameraPoint, { animate = true }: { animate?: boolean } = {}): void {
    const own = this.ownViewFor(this.constraints.constrain(camera, { pullRoom: false }));
    if (!own) return;
    if (this.following) this.followSuspended = true;
    this.go(own, { animate });
  }

  private zoomStep(direction: 1 | -1): void {
    // From the zoom last chosen, not the camera, which may still be gliding to
    // it: two quick presses are two steps.
    const chosen = this.zoomChoice.get();
    this.chooseZoom(nextZoomStep(typeof chosen === "number" ? chosen : this.getRelativeZoom(), direction));
  }

  /**
   * Read at `zoom` from now on, here and on every page (see `zoomChoice`).
   * A follower who zooms in has taken the board to look closer: they stop
   * being carried along, and the follow pill offers the way back.
   */
  private chooseZoom(zoom: number | null): void {
    this.zoomChoice.set(zoom);
    if (this.isFollowView() && zoom === null) {
      this.moving.set(true);
      return;
    }
    const camera = this.editor.getCamera();
    const centre = this.constraints.visibleCentreFor(camera);
    const page = this.viewPage();
    const reading = typeof zoom === "number" ? this.constraints.getFitZoom() * zoom : this.pageFitZoom(page);
    this.goOwnAt(this.constraints.cameraCentring(centre, reading));
  }

  /**
   * The zoom this reader reads `page` at: a follower sees it whole; anyone
   * else at their own choice, or the page's fit.
   */
  private readingZoom(page: WhiteboardPage | null): number {
    if (this.isFollowingLive()) return this.constraints.getWholePageZoom(page);
    const chosen = this.zoomChoice.get();
    return typeof chosen === "number" ? this.constraints.getFitZoom() * chosen : this.pageFitZoom(page);
  }

  private isFollowView(): boolean {
    const kind = this.view.get()?.kind;
    return this.isFollowingLive() && (kind === "follow" || kind === "page");
  }

  private pageFitZoom(page: WhiteboardPage | null): number {
    return this.constraints.getPageFitZoom(page);
  }

  /** The page the view is on, as the document has it now. */
  private viewPage(): WhiteboardPage | null {
    const view = this.view.get();
    return view ? this.findPage(view.pageId) : null;
  }

  // ─── Resolution ────────────────────────────────────────────────────────

  /** Where `view` puts the camera on this board now, or null when its page is not here. */
  resolve(view: BoardView | null = this.view.get()): CameraPoint | null {
    if (!view) return null;
    const { constraints } = this;
    const page = this.findPage(view.pageId);
    if (!page) return null;
    switch (view.kind) {
      case "page":
        return constraints.cameraAtPageTop(page, this.readingZoom(page));
      case "follow":
        // The leader's page, whole: where on it they are is theirs.
        return constraints.cameraAtPageTop(page, constraints.getWholePageZoom(page));
      case "own": {
        const width = constraints.getFitZoom();
        const zoom = view.relativeZoom === null
          ? this.pageFitZoom(page)
          : isRestingZoom(view.relativeZoom) ? width : width * view.relativeZoom;
        return constraints.cameraKeepingBand(page, view.rect, zoom);
      }
    }
  }

  /**
   * The reader's own view of `camera`: the band it shows, and its zoom
   * against the page filling the board's width — or null, the page's own fit,
   * while the reader has not zoomed and the camera is at it, so it stays
   * fitted when the board changes size.
   */
  private ownViewFor(camera: CameraPoint): BoardView | null {
    const band = this.constraints.getVisibleBandFor(camera, this.options.getPages());
    if (!band) return null;
    const fitted = typeof this.zoomChoice.get() !== "number"
      && Math.abs(camera.z / this.pageFitZoom(band.page) - 1) < SAME_ZOOM;
    const width = this.constraints.getFitZoom();
    return {
      kind: "own",
      pageId: band.page.id,
      rect: band.rect,
      relativeZoom: fitted ? null : width > 0 ? camera.z / width : 1,
    };
  }

  /**
   * The view's page; nothing while it is still on its way; and — when it has
   * been deleted — whichever page took its place: the one now at the number
   * it last had.
   */
  private findPage(pageId: string): WhiteboardPage | null {
    const pages = this.options.getPages();
    if (pages.length === 0) return null;
    const found = pages.find((page) => page.id === pageId);
    if (found) return found;
    if (this.awaiting) return null;
    const number = this.options.fallbackPageNumber?.() ?? this.currentPage.get();
    return pages[Math.min(Math.max(1, number), pages.length) - 1] ?? null;
  }

  // ─── The camera ────────────────────────────────────────────────────────

  private place(): void {
    const target = this.resolve();
    if (target) this.write(() => this.editor.setCamera(target, { immediate: true, force: true }));
  }

  private step(elapsedMs: number): void {
    if (!this.moving.get()) return;
    // A move never slides the board under a hand: it carries on once the hand lifts.
    if (isWhiteboardCameraInteractionActive(this.editor)) return;
    const target = this.resolve();
    if (!target) {
      // Still waiting for the page: keep the move, it starts when the page arrives.
      if (!this.awaiting) this.moving.set(false);
      return;
    }
    const { constraints } = this;
    const camera = this.editor.getCamera();
    const next = stepTowards(
      { ...constraints.visibleCentreFor(camera), z: camera.z },
      { ...constraints.visibleCentreFor(target), z: target.z },
      elapsedMs,
    );
    if (!next) {
      this.moving.set(false);
      this.write(() => this.editor.setCamera(target, { immediate: true, force: true }));
      return;
    }
    const camera_ = constraints.constrain(constraints.cameraCentring(next, next.z));
    this.write(() => this.editor.setCamera(camera_, { immediate: true, force: true }));
  }

  /** Run a camera write of the director's own; the camera listener ignores it. */
  private write(run: () => void): void {
    this.writing = true;
    try {
      run();
    } finally {
      this.writing = false;
    }
  }

  private writeOptions(): void {
    this.write(() => this.constraints.update(this.options.getPages()));
  }

  private geometryKey(): string {
    const bounds = this.editor.getViewportScreenBounds();
    return boardGeometryKey({ width: bounds.width, height: bounds.height }, this.options.getChrome());
  }

  /**
   * A camera change the director did not write: the layout's when it came
   * with a new geometry (tldraw re-applies the camera when it measures the
   * board), the reader's otherwise.
   *
   * A zoom is the reader's only when they have just pinched, scrolled or
   * pressed a key; any other is tldraw putting the camera back as the layout
   * settles, and the view is put back where it was. A reader's zoom sets
   * their zoom, and a follower who zooms is still following: they are moved
   * back to the leader at their new zoom once their hand is off the board.
   * Anything else is the reader looking around on their own.
   */
  private onForeignCameraChange(zoomed: boolean): void {
    if (this.geometryKey() !== this.appliedGeometry) {
      this.syncGeometry();
      return;
    }
    const camera = this.editor.getCamera();
    if (zoomed && Date.now() - this.zoomInputAt > ZOOM_INPUT_MS) {
      if (!this.moving.get()) this.place();
      return;
    }
    if (zoomed) {
      const width = this.constraints.getFitZoom();
      if (width > 0) this.zoomChoice.set(camera.z / width);
    }
    const own = this.ownViewFor(camera);
    if (!own) return;
    this.moving.set(false);
    this.awaiting = false;
    if (this.following) this.followSuspended = true;
    this.view.set(own);
    this.updateCurrentPage();
    this.schedulePullReturn();
    for (const listener of this.ownMoveListeners) listener();
  }

  /**
   * The page the board is on: the page its view names, read off the pages as
   * they are now. Never the camera: mid-glide the camera is on the way, not
   * there, and when pages are inserted or deleted above, it has not been
   * re-placed yet. A reader's own view names the page under its middle.
   */
  private updateCurrentPage(): void {
    const view = this.view.get();
    const pages = this.options.getPages();
    if (!view || pages.length === 0 || this.awaiting) return;
    // A page deleted under the view: the one now at its number takes its place (`findPage`).
    const number = pages.find((page) => page.id === view.pageId)?.number
      ?? Math.min(Math.max(1, this.currentPage.get()), pages.length);
    if (number !== this.currentPage.get()) this.currentPage.set(number);
  }

  /**
   * A view left in the pull room past the last page springs back onto it once
   * the hand is off the board: the room is for pulling, not for resting.
   */
  private schedulePullReturn(): void {
    this.clearPullTimer();
    if (!this.constraints.isInPullRoom(this.editor.getCamera())) return;
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      if (isWhiteboardCameraInteractionActive(this.editor)) {
        this.schedulePullReturn();
        return;
      }
      const camera = this.editor.getCamera();
      if (this.constraints.isInPullRoom(camera)) this.goOwnAt(camera);
    }, PULL_ROOM_RETURN_MS);
  }

  private clearPullTimer(): void {
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.pullTimer = null;
  }
}
