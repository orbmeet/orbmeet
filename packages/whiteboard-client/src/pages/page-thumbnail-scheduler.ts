import type { Editor, TLAssetId, TLShapeId } from "tldraw";
import { Box, isPageId } from "tldraw";
import type { WhiteboardPage } from "./page-manager";
import {
  forceRenderSingleFrameLikeShape,
  getDrawableShapeEntries,
  getFrameExportContent,
} from "./export-page-membership";
import { hashPageContent } from "./page-thumbnail-signature";
import {
  deleteCachedThumbnails,
  pruneCachedThumbnails,
  readCachedThumbnails,
  touchCachedThumbnail,
  writeCachedThumbnail,
} from "./page-thumbnail-cache";
import {
  WHITEBOARD_PAGE_RAIL_CARD_MAX_HEIGHT_PX,
  WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX,
} from "../camera/viewport-insets";

/**
 * A picture of every page, for the rail down the left of the board.
 *
 * A page *number* tells you a page exists and nothing else; a picture answers
 * the question people actually bring to the rail, which is "which one is the
 * one I want".
 *
 * Page membership comes from `export-page-membership`, the same module the PDF
 * export uses: "what is on page 4" has one answer, and a thumbnail that
 * disagreed with the exported PDF would be worse than no thumbnail at all.
 *
 * ## What this had to stop doing
 *
 * The first version of this module was correct about the cheap parts and wrong
 * about every part that decides whether a thumbnail actually appears. Each of
 * the following was its own reported bug, and each has a counter-measure below
 * that is easy to remove by accident:
 *
 * - **Assets were not content.** Invalidation listened for `shape` records and
 *   ignored `asset` records, so an imported PDF page whose image resolved a
 *   second after the frame did was rasterised blank — and then never again,
 *   because nothing about the page had "changed". Two devices racing the same
 *   asset load is exactly how one of them ends up with a picture of page 10
 *   and the other with a white rectangle. `assetsOf` is why that cannot recur.
 *
 * - **A failure was permanent.** A failed render set `failedUntil = now + 20s`
 *   and then returned to a pump that immediately concluded there was nothing
 *   to do — with no timer armed for when the cool-off expired. The page stayed
 *   blank until something unrelated woke the loop. Retries are now scheduled,
 *   not merely permitted.
 *
 * - **The debounce had no ceiling.** A trailing-only debounce, reset by every
 *   store change, means a collaborator drawing continuously holds the flush
 *   off forever. That is the "thumbnails lag by several seconds" report, and
 *   `MAX_SETTLE_MS` is the ceiling that ends it.
 *
 * - **A remote erase dirtied the wrong page.** A deletion was attributed to
 *   *the local viewer's* current page, on the reasoning that "an erase can only
 *   have happened where someone was looking" — true, but the someone is not
 *   necessarily you. Removed records carry their own `parentId`, so the page
 *   that actually changed is knowable without guessing.
 *
 * - **The raster was half the size of the card.** `pixelRatio` was solved to
 *   put 64 *physical* pixels into a 64 *CSS*-pixel card, so on any 2× or 3×
 *   display the rail showed an upscaled image. The raster now follows
 *   `devicePixelRatio`.
 *
 * ## Cost
 *
 * Rendering pages is not free, so nothing here is eager: one render at a time,
 * off the idle callback, ordered by a priority that puts a blank card ahead of
 * a merely outdated one. Pages near the current page are rendered even when
 * the rail has scrolled them out of view, because arriving at page 12 to find
 * an empty card is the failure this whole module exists to prevent.
 */

/**
 * Cap on the raster's device-pixel multiplier.
 *
 * A 3× phone would otherwise triple the bitmap for a difference nobody can see
 * at this size, and the bitmap is what the render loop's cost is proportional
 * to.
 */
const MAX_PIXEL_RATIO = 2;

/** Quiet time before a page that changed is re-rendered. */
const RESETTLE_MS = 700;

/**
 * The longest the settle timer may be pushed back.
 *
 * Without this, a room where somebody is drawing continuously never reaches a
 * quiet moment, and the rail silently stops updating for as long as they keep
 * going.
 */
const MAX_SETTLE_MS = 2_500;

/** How long a failed render is left alone before the page may be tried again. */
const RETRY_MS = 6_000;

/** Consecutive failures after which a page is left alone until it changes. */
const MAX_ATTEMPTS = 4;

/**
 * How far either side of the current page is rendered even when the rail has
 * those rows scrolled out of sight.
 *
 * Visibility alone is the wrong trigger on its own: the rail scrolls to follow
 * the current page, so the rows arriving next are precisely the ones an
 * intersection observer has not reported yet.
 */
const NEIGHBOUR_WINDOW = 4;

/**
 * How long to wait for a page's images before rasterising it anyway.
 *
 * This wait holds the single-render queue, so it is a ceiling on how long one
 * slow asset can keep the rest of the rail waiting. Short enough that a page
 * with a dead image does not stall the document; long enough that a normally
 * loading one is not rasterised blank, which is the failure it exists for.
 */
const ASSET_WAIT_MS = 2_500;

export interface PageThumbnail {
  /** An object URL for the rendered raster. Revoked when it is replaced. */
  url: string;
  width: number;
  height: number;
  /** True while this is a picture restored from a previous session. */
  stale: boolean;
}

interface Entry {
  thumbnail: PageThumbnail | null;
  /** The content hash this thumbnail was rendered from, or null if unknown. */
  hash: string | null;
  /** When a cooled-off page may be attempted again. */
  failedUntil: number;
  attempts: number;
}

export interface ThumbnailSchedulerInputs {
  editor: Editor | null;
  pages: WhiteboardPage[];
  currentPage: number;
  enabled: boolean;
  boardKey: string | null;
  resolveAssetUrl?: (src: string) => string;
}

function boundsOf(editor: Editor, pageId: TLShapeId): Box | null {
  const bounds = editor.getShapePageBounds(pageId);
  return bounds ? new Box(bounds.x, bounds.y, bounds.w, bounds.h) : null;
}

function rasterPixelRatio(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(MAX_PIXEL_RATIO, Math.max(1, dpr));
}

/**
 * Wait until a page's images can actually be drawn.
 *
 * `toImage` inlines whatever the browser has; an image element that has not
 * decoded yet contributes nothing and the page rasterises blank.
 */
async function waitForPageImages(
  editor: Editor,
  shapeIds: readonly TLShapeId[],
  resolveAssetUrl: ((src: string) => string) | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const sources = new Set<string>();
  for (const id of shapeIds) {
    const shape = editor.getShape(id);
    const assetId = (shape?.props as { assetId?: string | null } | undefined)?.assetId;
    if (!assetId) continue;
    const asset = editor.getAsset(assetId as TLAssetId);
    const src = (asset?.props as { src?: string | null } | undefined)?.src;
    if (!src) continue;
    sources.add(resolveAssetUrl ? resolveAssetUrl(src) : src);
  }
  if (sources.size === 0) return;

  const decodes = [...sources].map(
    (src) =>
      new Promise<void>((resolve) => {
        const image = new Image();
        image.decoding = "async";
        // A decode that fails is not a reason to hold the raster back: the page
        // may well have other content worth showing, and a broken asset is
        // permanent, so waiting again next time only repeats the delay.
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = src;
        if (image.complete) resolve();
      }),
  );

  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.all(decodes),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ASSET_WAIT_MS);
        onAbort = () => resolve();
        // A board closed mid-wait should not hold the render open until the
        // ceiling expires.
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Imperative scheduler that owns thumbnail rasterization, store invalidation,
 * viewport visibility tracking, IndexedDB cache hydration/pruning, and object
 * URL cleanup outside React effect/ref churn.
 */
export class PageThumbnailScheduler {
  private readonly entries = new Map<string, Entry>();
  /** Pages whose content is known to have moved on since their last raster. */
  private readonly dirty = new Set<string>();
  private readonly visible = new Set<string>();
  private readonly nodes = new Map<string, HTMLElement>();
  // One ref callback per page, cached. A fresh function identity on every
  // render makes React detach and re-attach the ref each time, which would
  // tear down and rebuild the observation of every visible card on every
  // keystroke elsewhere in the board.
  private readonly refCallbacks = new Map<string, (node: HTMLElement | null) => void>();

  private observer: IntersectionObserver | null = null;
  private editor: Editor | null = null;
  private pages: WhiteboardPage[] = [];
  private currentPage = 1;
  private enabled = false;
  private boardKey: string | null = null;
  private resolveAssetUrl: ((src: string) => string) | undefined;

  private loadedCacheBoardKey: string | null = null;
  private cacheLoadToken = 0;
  private prunedBoardKey: string | null = null;

  private stopStoreListener: (() => void) | null = null;
  private stopLoop: (() => void) | null = null;
  private wakeLoop: () => void = () => {};

  private readonly onPublish: (next: ReadonlyMap<string, PageThumbnail>) => void;

  constructor(onPublish: (next: ReadonlyMap<string, PageThumbnail>) => void) {
    this.onPublish = onPublish;
  }

  /** Syncs the latest React inputs into the scheduler, starting/stopping loops only on structural changes. */
  sync(inputs: ThumbnailSchedulerInputs): void {
    const prevEditor = this.editor;
    const prevEnabled = this.enabled;
    const prevBoardKey = this.boardKey;
    const prevPages = this.pages;
    const prevCurrentPage = this.currentPage;

    this.editor = inputs.editor;
    this.pages = inputs.pages;
    this.currentPage = inputs.currentPage;
    this.enabled = inputs.enabled;
    this.boardKey = inputs.boardKey;
    this.resolveAssetUrl = inputs.resolveAssetUrl;

    if (prevEnabled !== this.enabled) {
      this.syncObserver();
    }

    if (prevEditor !== this.editor || prevEnabled !== this.enabled) {
      this.restartStoreListener();
      this.restartRenderLoop();
    }

    if (prevPages !== this.pages) {
      this.evictDeletedPages();
    }

    const canHydrateCache = this.enabled && Boolean(this.boardKey) && this.pages.length > 0;
    const cacheKeyChanged = prevBoardKey !== this.boardKey || prevEnabled !== this.enabled ||
      (prevPages.length === 0 && this.pages.length > 0);
    if (!canHydrateCache) {
      // Cancels a read in flight, so it must be allowed to run again.
      this.cacheLoadToken += 1;
      this.loadedCacheBoardKey = null;
    } else if (cacheKeyChanged && this.loadedCacheBoardKey !== this.boardKey) {
      this.hydrateCache(this.boardKey!);
    }

    // Housekeeping for the persistent store, once per board once its page list
    // has settled: switching boards without remounting prunes the new one too.
    if (this.enabled && this.boardKey && this.pages.length > 0 && this.prunedBoardKey !== this.boardKey) {
      this.prunedBoardKey = this.boardKey;
      void pruneCachedThumbnails(this.boardKey, new Set(this.pages.map((page) => String(page.id))));
    }

    // A page turn or a new page changes what the loop should be working on, but
    // must not rebuild the loop. Waking it is the whole notification.
    if (prevPages !== this.pages || prevCurrentPage !== this.currentPage) {
      this.wakeLoop();
    }
  }

  /** Cached per-page ref callback so cards do not re-register on every render. */
  observe = (pageId: string): ((node: HTMLElement | null) => void) => {
    const cached = this.refCallbacks.get(pageId);
    if (cached) return cached;
    const callback = (node: HTMLElement | null) => {
      const previous = this.nodes.get(pageId);
      if (previous && previous !== node) {
        this.observer?.unobserve(previous);
        this.nodes.delete(pageId);
        this.visible.delete(pageId);
      }
      if (!node) return;
      node.dataset.pageId = pageId;
      this.nodes.set(pageId, node);
      this.observer?.observe(node);
    };
    this.refCallbacks.set(pageId, callback);
    return callback;
  };

  /**
   * Stops all timers/observers/listeners and revokes every object URL.
   *
   * The card ref callbacks survive, and the next `sync()` starts everything
   * again: when React re-runs effects without re-rendering (StrictMode,
   * `<Activity>`), it re-attaches the ref callbacks it already holds, so a
   * scheduler that forgot them would never see those cards. Every raster is
   * released here: an object URL outlives the component that made it, so a
   * board opened and closed twenty times would leak twenty sets.
   */
  dispose(): void {
    this.cacheLoadToken += 1;
    this.stopStoreListener?.();
    this.stopStoreListener = null;
    this.stopLoop?.();
    this.stopLoop = null;
    this.observer?.disconnect();
    this.observer = null;
    for (const entry of this.entries.values()) {
      if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail.url);
    }
    this.entries.clear();
    this.dirty.clear();
    this.visible.clear();
    // Inputs back to their initial values, so the next sync() is a cold start.
    this.editor = null;
    this.pages = [];
    this.enabled = false;
    this.boardKey = null;
    this.loadedCacheBoardKey = null;
    this.prunedBoardKey = null;
  }

  private publish(): void {
    const next = new Map<string, PageThumbnail>();
    for (const [id, entry] of this.entries) {
      if (entry.thumbnail) next.set(id, entry.thumbnail);
    }
    this.onPublish(next);
  }

  private syncObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (!this.enabled || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (records) => {
        let changed = false;
        for (const record of records) {
          const pageId = (record.target as HTMLElement).dataset.pageId;
          if (!pageId) continue;
          const wasVisible = this.visible.has(pageId);
          if (record.isIntersecting) {
            if (!wasVisible) {
              this.visible.add(pageId);
              changed = true;
            }
          } else if (wasVisible) {
            this.visible.delete(pageId);
          }
        }
        if (changed) this.wakeLoop();
      },
      // A generous margin: a thumbnail that only starts rendering once its row
      // is over the fold arrives after you have already scrolled past it.
      { rootMargin: "320px 0px" },
    );
    this.observer = observer;
    for (const node of this.nodes.values()) observer.observe(node);
  }

  // Restored rasters are shown immediately and marked stale. The loop still
  // checks each one's hash against the live document, so a page that really
  // did change is replaced — but the rail is never a column of empty cards
  // while that happens.
  private hydrateCache(boardKey: string): void {
    this.loadedCacheBoardKey = boardKey;
    const token = ++this.cacheLoadToken;

    void (async () => {
      const cached = await readCachedThumbnails(boardKey);
      if (token !== this.cacheLoadToken || cached.size === 0) return;

      // Only pages the document still has: this read resolves after the page
      // list may have changed, and a raster adopted for a deleted page would
      // sit in the map with nothing left to evict it.
      const live = new Set(this.pages.map((page) => String(page.id)));
      let restored = false;
      for (const [pageId, row] of cached) {
        if (!live.has(pageId)) continue;
        // A failed render leaves an entry with no thumbnail. Cached content is
        // still a better immediate fallback and must not be masked by that
        // bookkeeping-only entry.
        if (this.entries.get(pageId)?.thumbnail) continue;
        this.entries.set(pageId, {
          thumbnail: {
            url: URL.createObjectURL(row.blob),
            width: row.width,
            height: row.height,
            stale: true,
          },
          hash: row.hash,
          failedUntil: 0,
          attempts: 0,
        });
        restored = true;
      }
      if (!restored) return;
      this.publish();
      this.wakeLoop();
    })();
  }

  /** Drop thumbnails for pages that no longer exist, and release their rasters. */
  private evictDeletedPages(): void {
    // No pages means the list is not known yet (the navigator is being
    // replaced along with the editor), not that every page was deleted:
    // evicting here would wipe the board's persistent cache.
    if (this.pages.length === 0) return;
    const live = new Set(this.pages.map((page) => String(page.id)));
    const removed: string[] = [];
    for (const [pageId, entry] of this.entries) {
      if (live.has(pageId)) continue;
      if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail.url);
      this.entries.delete(pageId);
      this.dirty.delete(pageId);
      this.refCallbacks.delete(pageId);
      removed.push(pageId);
    }
    if (removed.length === 0) return;
    if (this.boardKey) {
      void deleteCachedThumbnails(this.boardKey, removed);
    }
    this.publish();
  }

  // Every committed change to the document arrives here — remote strokes as
  // well as local ones — so the work is to answer "which page did that land
  // on" cheaply, and within a bounded delay.
  private restartStoreListener(): void {
    this.stopStoreListener?.();
    this.stopStoreListener = null;
    const editor = this.editor;
    if (!editor || !this.enabled) return;

    // Reconcile every page when the rail is re-enabled.
    // Reconcile every page when the rail is re-enabled. Store changes that
    // happened while disabled were intentionally not observed.
    for (const page of this.pages) this.dirty.add(String(page.id));

    let settleTimer: number | null = null;
    let firstDirtyAt = 0;
    const touchedShapeIds = new Set<TLShapeId>();
    /**
     * Where shapes were before the change that moved or removed them: the
     * parent their old record named, and for a loose top-level shape the box
     * it moved out of. Captured as the change lands, while the old record is
     * at hand; the page a shape left needs drawing again as much as the page
     * it went to.
     */
    const removedParents = new Set<string>();
    const vacatedBoxes: Box[] = [];
    const touchedAssetIds = new Set<string>();

    /** Which pages hold a shape referencing any of the given assets. */
    const pagesUsingAssets = (assetIds: ReadonlySet<string>): string[] => {
      if (assetIds.size === 0) return [];
      const hits: string[] = [];
      const pageIds = new Set(this.pages.map((page) => String(page.id)));
      for (const shape of editor.getCurrentPageShapes()) {
        const assetId = (shape.props as { assetId?: string | null }).assetId;
        if (!assetId || !assetIds.has(assetId)) continue;
        const parent = String(shape.parentId);
        if (pageIds.has(parent)) {
          hits.push(parent);
          continue;
        }
        // A loose image: fall back to where it sits.
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) continue;
        for (const page of this.pages) {
          const pageBounds = boundsOf(editor, page.id);
          if (pageBounds?.collides(bounds)) hits.push(String(page.id));
        }
      }
      return hits;
    };

    const flush = () => {
      settleTimer = null;
      firstDirtyAt = 0;
      const shapeIds = [...touchedShapeIds];
      const parents = [...removedParents];
      const vacated = vacatedBoxes.splice(0);
      const assetIds = new Set(touchedAssetIds);
      touchedShapeIds.clear();
      removedParents.clear();
      touchedAssetIds.clear();
      if (
        shapeIds.length === 0 &&
        parents.length === 0 &&
        vacated.length === 0 &&
        assetIds.size === 0
      ) {
        return;
      }

      const pageIds = new Set(this.pages.map((page) => String(page.id)));
      const dirtyNow = new Set<string>();

      // A removed or moved shape's former parent was captured while its old
      // record existed, so the change lands on the page it left — including a
      // remote peer's on a page nobody here is looking at.
      for (const parent of parents) {
        if (pageIds.has(parent)) dirtyNow.add(parent);
      }

      // Loose shapes (top-level, not parented to a frame) still need geometry,
      // but they are the exception rather than the rule, so the page-bounds
      // lookup is deferred until one actually turns up.
      let pageBounds: { id: string; bounds: Box }[] | null = null;
      const pagesBounds = () =>
        pageBounds ??= this.pages
          .map((page) => {
            const box = boundsOf(editor, page.id);
            return box ? { id: String(page.id), bounds: box } : null;
          })
          .filter((entry): entry is { id: string; bounds: Box } => entry !== null);

      for (const box of vacated) {
        for (const page of pagesBounds()) {
          if (page.bounds.collides(box)) dirtyNow.add(page.id);
        }
      }
      for (const shapeId of shapeIds) {
        const shape = editor.getShape(shapeId);
        if (!shape) continue;
        const parent = String(shape.parentId);
        if (pageIds.has(parent)) {
          dirtyNow.add(parent);
          continue;
        }
        const bounds = editor.getShapePageBounds(shapeId);
        if (!bounds) continue;
        for (const page of pagesBounds()) {
          if (page.bounds.collides(bounds)) dirtyNow.add(page.id);
        }
      }

      for (const pageId of pagesUsingAssets(assetIds)) dirtyNow.add(pageId);

      if (dirtyNow.size === 0) return;
      for (const pageId of dirtyNow) {
        this.dirty.add(pageId);
        const entry = this.entries.get(pageId);
        if (entry) {
          // Content moved on, so an earlier failure says nothing about this
          // attempt: the cool-off is cleared rather than waited out.
          entry.failedUntil = 0;
          entry.attempts = 0;
        }
      }
      this.wakeLoop();
    };

    const arm = () => {
      const now = Date.now();
      if (firstDirtyAt === 0) firstDirtyAt = now;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      // The ceiling is what keeps a continuously-drawing room from holding the
      // trailing edge off indefinitely.
      const deadline = firstDirtyAt + MAX_SETTLE_MS;
      settleTimer = window.setTimeout(
        flush,
        Math.max(0, Math.min(RESETTLE_MS, deadline - now)),
      );
    };

    const unsubscribe = editor.store.listen(
      (change) => {
        let sawSomething = false;
        for (const record of Object.values(change.changes.added)) {
          if (record.typeName === "shape") {
            touchedShapeIds.add(record.id);
            sawSomething = true;
          } else if (record.typeName === "asset") {
            touchedAssetIds.add(record.id);
            sawSomething = true;
          }
        }
        for (const [prev, next] of Object.values(change.changes.updated)) {
          if (next.typeName === "shape" && prev.typeName === "shape") {
            touchedShapeIds.add(next.id);
            if (prev.parentId !== next.parentId) {
              removedParents.add(String(prev.parentId));
            } else if (isPageId(prev.parentId) && (prev.x !== next.x || prev.y !== next.y)) {
              // A loose shape in page space: where it was is where it is,
              // moved back by how far it went.
              const bounds = editor.getShapePageBounds(next.id);
              if (bounds) {
                vacatedBoxes.push(bounds.clone().translate({ x: prev.x - next.x, y: prev.y - next.y }));
              }
            }
            sawSomething = true;
          } else if (next.typeName === "asset") {
            // The case that made imported PDF pages render blank forever: the
            // asset's `src` resolves after the shape referencing it exists,
            // and nothing about the *shape* changes when it does.
            touchedAssetIds.add(next.id);
            sawSomething = true;
          }
        }
        for (const record of Object.values(change.changes.removed)) {
          if (record.typeName !== "shape") continue;
          // Read the parent off the record being removed: once the transaction
          // lands there is nothing left to locate the shape by, short of
          // guessing at the local current page.
          removedParents.add(String(record.parentId));
          touchedShapeIds.add(record.id);
          sawSomething = true;
        }
        if (sawSomething) arm();
      },
      { scope: "document" },
    );

    this.stopStoreListener = () => {
      unsubscribe();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }

  // Restarted only when the editor or enablement changes, never for `pages` or
  // `currentPage`: re-creating the loop on every page turn cancelled the
  // in-flight idle callback and restarted the queue from the top, which on a
  // board somebody is paging through means it never reaches the end of it.
  private restartRenderLoop(): void {
    this.stopLoop?.();
    this.stopLoop = null;
    this.wakeLoop = () => {};

    const editor = this.editor;
    if (!editor || !this.enabled) return;

    const controller = new AbortController();
    const { signal } = controller;
    let idleHandle: number | null = null;
    let retryTimer: number | null = null;
    // This belongs to this loop generation. Keeping it on the scheduler would
    // let an obsolete render block a newly started loop, then clear the flag
    // without waking that loop when it eventually finishes.
    let running = false;

    /** Membership, and the hash of what it currently draws. */
    const contentOf = (page: WhiteboardPage) => {
      const bounds = boundsOf(editor, page.id);
      if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
      const content = getFrameExportContent(
        editor,
        page.id,
        bounds,
        getDrawableShapeEntries(editor),
      );
      return {
        bounds,
        shapeIds: content.shapeIds,
        hash: hashPageContent(editor, page.id, content.shapeIds),
      };
    };

    /**
     * What to draw next, and how badly.
     *
     * Lower is more urgent. The ordering is the whole scheduling policy: the
     * page you are on, then blank cards, then out-of-date ones — and a blank
     * card two rows away beats a merely outdated card under your cursor,
     * because an empty rectangle is the state that makes the rail useless.
     */
    const priorityOf = (page: WhiteboardPage, index: number): number | null => {
      const key = String(page.id);
      const entry = this.entries.get(key);
      const now = Date.now();
      if (entry && entry.failedUntil > now) return null;
      if (entry && entry.attempts >= MAX_ATTEMPTS && !this.dirty.has(key)) {
        return null;
      }

      const isCurrent = index === this.currentPage - 1;
      const distance = Math.abs(index - (this.currentPage - 1));
      const inRange = this.visible.has(key) || distance <= NEIGHBOUR_WINDOW;
      if (!inRange) return null;

      const blank = !entry?.thumbnail;
      const outdated = this.dirty.has(key) || entry?.thumbnail?.stale === true;
      if (!blank && !outdated && entry?.hash != null) return null;

      if (isCurrent && (blank || outdated)) return 0;
      if (blank) return 100 + distance;
      return 1_000 + distance;
    };

    const nextPage = (): WhiteboardPage | null => {
      const list = this.pages;
      let best: WhiteboardPage | null = null;
      let bestPriority = Number.POSITIVE_INFINITY;
      for (let index = 0; index < list.length; index++) {
        const page = list[index];
        const priority = priorityOf(page, index);
        if (priority === null || priority >= bestPriority) continue;
        best = page;
        bestPriority = priority;
      }
      return best;
    };

    /** The soonest a cooled-off page becomes eligible again. */
    const nextRetryAt = (): number | null => {
      let soonest: number | null = null;
      for (const entry of this.entries.values()) {
        if (entry.failedUntil <= Date.now()) continue;
        if (entry.attempts >= MAX_ATTEMPTS) continue;
        soonest = soonest === null ? entry.failedUntil : Math.min(soonest, entry.failedUntil);
      }
      return soonest;
    };

    const markFailed = (key: string, keepThumbnail: boolean) => {
      const previous = this.entries.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      this.entries.set(key, {
        thumbnail: keepThumbnail ? (previous?.thumbnail ?? null) : null,
        hash: previous?.hash ?? null,
        // Backed off, so a page that is failing for a structural reason — a
        // font that will not load, a shape type that throws — stops competing
        // with pages that could still succeed.
        failedUntil: Date.now() + RETRY_MS * attempts,
        attempts,
      });
    };

    const render = async (page: WhiteboardPage) => {
      const key = String(page.id);
      this.dirty.delete(key);

      const content = contentOf(page);
      if (!content) {
        markFailed(key, true);
        return;
      }

      // A restored raster whose page has not moved on is already the answer.
      const existing = this.entries.get(key);
      if (existing?.thumbnail && existing.hash === content.hash) {
        if (existing.thumbnail.stale) {
          this.entries.set(key, {
            ...existing,
            thumbnail: { ...existing.thumbnail, stale: false },
            attempts: 0,
            failedUntil: 0,
          });
          this.publish();
          if (this.boardKey) void touchCachedThumbnail(this.boardKey, key);
        }
        return;
      }

      await waitForPageImages(editor, content.shapeIds, this.resolveAssetUrl, signal);
      if (signal.aborted) return;

      const shapeIds = forceRenderSingleFrameLikeShape([page.id, ...content.shapeIds]);
      let image: { blob: Blob; width: number; height: number } | undefined;
      try {
        image = await editor.toImage(shapeIds, {
          format: "png",
          bounds: content.bounds,
          padding: 0,
          background: true,
          // Solved, not defaulted: `pixelRatio` multiplies the bitmap's size,
          // and the number that matters is how many *device* pixels land in a
          // card that is WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX wide. Leaving it at tldraw's
          // default of 2 rasterises a 1200pt page at 2400px to be shown at 88;
          // solving it for CSS pixels alone, as this did before, produced an
          // image the display then had to upscale.
          pixelRatio: Math.min(
            (WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX * rasterPixelRatio()) / content.bounds.w,
            (WHITEBOARD_PAGE_RAIL_CARD_MAX_HEIGHT_PX * rasterPixelRatio()) /
              content.bounds.h,
          ),
        });
      } catch {
        image = undefined;
      }
      if (signal.aborted) return;

      if (!image || image.width === 0 || image.height === 0) {
        markFailed(key, true);
        return;
      }

      // The page can disappear while image decoding or toImage is awaited.
      // Never resurrect it in memory or in the persistent thumbnail cache.
      if (!this.pages.some((candidate) => String(candidate.id) === key)) return;

      const previous = this.entries.get(key)?.thumbnail;
      this.entries.set(key, {
        thumbnail: {
          url: URL.createObjectURL(image.blob),
          width: image.width,
          height: image.height,
          stale: false,
        },
        hash: content.hash,
        failedUntil: 0,
        attempts: 0,
      });
      if (previous) URL.revokeObjectURL(previous.url);
      this.publish();

      // Reused as it was stored, so the store hears of the use here.
      const boardId = this.boardKey;
      if (boardId) {
        void writeCachedThumbnail(boardId, key, {
          blob: image.blob,
          width: image.width,
          height: image.height,
          hash: content.hash,
        }).then(() => {
          if (!this.pages.some((candidate) => String(candidate.id) === key)) {
            return deleteCachedThumbnails(boardId, [key]);
          }
        });
      }
    };

    const pump = () => {
      idleHandle = null;
      if (signal.aborted || running) return;
      const page = nextPage();
      if (!page) {
        armRetry();
        return;
      }
      running = true;
      void render(page).finally(() => {
        running = false;
        if (!signal.aborted) schedule();
      });
    };

    const schedule = () => {
      if (signal.aborted || idleHandle !== null || running) return;
      // Idle time, so a thumbnail refresh never lands in the same frame as a
      // stroke. `requestIdleCallback` is still missing from Safari's stable
      // release, hence the timeout.
      idleHandle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(pump, { timeout: 1_000 })
          : window.setTimeout(pump, 120);
    };

    /**
     * Wake the loop when the earliest cool-off expires.
     *
     * The absence of this is what made a single failed render permanent: the
     * pump would decline to pick the page, return, and leave nothing behind
     * that would ever ask again.
     */
    function armRetry() {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      const at = nextRetryAt();
      if (at === null) return;
      retryTimer = window.setTimeout(
        () => {
          retryTimer = null;
          schedule();
        },
        Math.max(50, at - Date.now()),
      );
    }

    this.wakeLoop = schedule;
    schedule();

    this.stopLoop = () => {
      controller.abort();
      this.wakeLoop = () => {};
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (idleHandle !== null) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
        else window.clearTimeout(idleHandle);
      }
    };
  }
}
