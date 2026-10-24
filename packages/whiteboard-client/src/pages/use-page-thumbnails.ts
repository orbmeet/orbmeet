import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor, TLAssetId, TLShapeId } from "tldraw";
import { Box } from "tldraw";
import type { WhiteboardPage } from "./page-manager";
import {
  forceRenderSingleFrameLikeShape,
  getDrawableShapeEntries,
  getFrameExportContent,
} from "./export-page-membership";
import { boardCacheKey, hashPageContent } from "./page-thumbnail-signature";
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
 * The first version of this hook was correct about the cheap parts and wrong
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

interface PageThumbnail {
  /** An object URL for the rendered raster. Revoked when it is replaced. */
  url: string;
  width: number;
  height: number;
  /** True while this is a picture restored from a previous session. */
  stale: boolean;
}

export interface PageThumbnails {
  /** Keyed by page shape id. Absent means "not rendered yet". */
  byPageId: ReadonlyMap<string, PageThumbnail>;
  /** Ref callback a card attaches so the hook can see whether it is on screen. */
  observe: (pageId: string) => (node: HTMLElement | null) => void;
}

interface Entry {
  thumbnail: PageThumbnail | null;
  /** The content hash this thumbnail was rendered from, or null if unknown. */
  hash: string | null;
  /** When a cooled-off page may be attempted again. */
  failedUntil: number;
  attempts: number;
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
 * decoded yet contributes nothing and the page rasterises blank. Decoding is
 * idempotent and usually already done — the preloader has normally been
 * through this window — so on the common path this settles in a microtask.
 */
async function waitForPageImages(
  editor: Editor,
  shapeIds: readonly TLShapeId[],
  resolveAssetUrl: ((src: string) => string) | undefined,
  signal: { disposed: boolean },
): Promise<void> {
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

  // Both timers are cleared on *every* exit, not only the one that fires them.
  // A race whose losing branch keeps a 250ms interval alive leaks one per
  // render, and this runs once per page per refresh.
  let timer: number | undefined;
  let poll: number | undefined;
  try {
    await Promise.race([
      Promise.all(decodes),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ASSET_WAIT_MS);
        // A board closed mid-wait should not hold the render open until the
        // ceiling expires.
        poll = window.setInterval(() => {
          if (signal.disposed) resolve();
        }, 250);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (poll !== undefined) window.clearInterval(poll);
  }
}

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

  const entriesRef = useRef(new Map<string, Entry>());
  /** Pages whose content is known to have moved on since their last raster. */
  const dirtyRef = useRef(new Set<string>());
  const visibleRef = useRef(new Set<string>());
  const nodesRef = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // The render loop reads all four of these, and reads them from an idle
  // callback rather than from a render — so an effect is soon enough to keep
  // them fresh, and assigning during render would buy nothing but a lint
  // error.
  const boardKey = boardCacheKey(whiteboardUrl, documentId);
  const pagesRef = useRef(pages);
  const currentPageRef = useRef(currentPage);
  const resolveAssetUrlRef = useRef(resolveAssetUrl);
  const boardKeyRef = useRef(boardKey);
  useEffect(() => {
    pagesRef.current = pages;
    currentPageRef.current = currentPage;
    resolveAssetUrlRef.current = resolveAssetUrl;
    boardKeyRef.current = boardKey;
  }, [boardKey, currentPage, pages, resolveAssetUrl]);

  const wakeRef = useRef<() => void>(() => {});

  const publish = useCallback(() => {
    setByPageId(() => {
      const next = new Map<string, PageThumbnail>();
      for (const [id, entry] of entriesRef.current) {
        if (entry.thumbnail) next.set(id, entry.thumbnail);
      }
      return next;
    });
  }, []);

  // ── Visibility ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        let changed = false;
        for (const record of records) {
          const pageId = (record.target as HTMLElement).dataset.pageId;
          if (!pageId) continue;
          const wasVisible = visibleRef.current.has(pageId);
          if (record.isIntersecting) {
            if (!wasVisible) {
              visibleRef.current.add(pageId);
              changed = true;
            }
          } else if (wasVisible) {
            visibleRef.current.delete(pageId);
          }
        }
        if (changed) wakeRef.current();
      },
      // A generous margin: a thumbnail that only starts rendering once its row
      // is over the fold arrives after you have already scrolled past it.
      { rootMargin: "320px 0px" },
    );
    observerRef.current = observer;
    for (const node of nodesRef.current.values()) observer.observe(node);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [enabled]);

  // One ref callback per page, cached. A fresh function identity on every
  // render makes React detach and re-attach the ref each time, which would
  // tear down and rebuild the observation of every visible card on every
  // keystroke elsewhere in the board.
  const refCallbacksRef = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const observe = useCallback((pageId: string) => {
    const cached = refCallbacksRef.current.get(pageId);
    if (cached) return cached;
    const callback = (node: HTMLElement | null) => {
      const previous = nodesRef.current.get(pageId);
      if (previous && previous !== node) {
        observerRef.current?.unobserve(previous);
        nodesRef.current.delete(pageId);
        visibleRef.current.delete(pageId);
      }
      if (!node) return;
      node.dataset.pageId = pageId;
      nodesRef.current.set(pageId, node);
      observerRef.current?.observe(node);
    };
    refCallbacksRef.current.set(pageId, callback);
    return callback;
  }, []);

  // ── The cache ──────────────────────────────────────────────────────────────
  //
  // Restored rasters are shown immediately and marked stale. The loop still
  // checks each one's hash against the live document, so a page that really
  // did change is replaced — but the rail is never a column of empty cards
  // while that happens.
  const hasPages = pages.length > 0;
  useEffect(() => {
    if (!enabled || !boardKey || !hasPages) return;
    let disposed = false;

    void (async () => {
      const cached = await readCachedThumbnails(boardKey);
      if (disposed || cached.size === 0) return;

      // Only pages the document still has. This read resolves after the page
      // list has been through at least one render, and the cleanup effect that
      // drops dead entries fires on `pages` changing — so a raster adopted for
      // a deleted page would sit in the map until unmount with nothing left to
      // evict it.
      const live = new Set(pagesRef.current.map((page) => String(page.id)));
      let restored = false;
      for (const [pageId, row] of cached) {
        if (!live.has(pageId)) continue;
        // A failed render leaves an entry with no thumbnail. Cached content is
        // still a better immediate fallback and must not be masked by that
        // bookkeeping-only entry.
        if (entriesRef.current.get(pageId)?.thumbnail) continue;
        entriesRef.current.set(pageId, {
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
      publish();
      wakeRef.current();
    })();

    return () => {
      disposed = true;
    };
  }, [boardKey, enabled, hasPages, publish]);

  // ── Invalidation ───────────────────────────────────────────────────────────
  //
  // Every committed change to the document arrives here — remote strokes as
  // well as local ones — so the work is to answer "which page did that land
  // on" cheaply, and within a bounded delay.
  useEffect(() => {
    if (!editor || !enabled) return;

    // Reconcile every page when the rail is re-enabled. Store changes that
    // happened while disabled were intentionally not observed.
    for (const page of pagesRef.current) dirtyRef.current.add(String(page.id));
    let settleTimer: number | null = null;
    let firstDirtyAt = 0;
    const touchedShapeIds = new Set<TLShapeId>();
    /** Parent ids captured at removal time, when the record still had one. */
    const removedParents = new Set<string>();
    const touchedAssetIds = new Set<string>();

    /** Which pages hold a shape referencing any of the given assets. */
    const pagesUsingAssets = (assetIds: ReadonlySet<string>): string[] => {
      if (assetIds.size === 0) return [];
      const hits: string[] = [];
      const pageIds = new Set(pagesRef.current.map((page) => String(page.id)));
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
        for (const page of pagesRef.current) {
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
      const assetIds = new Set(touchedAssetIds);
      touchedShapeIds.clear();
      removedParents.clear();
      touchedAssetIds.clear();
      if (shapeIds.length === 0 && parents.length === 0 && assetIds.size === 0) return;

      const pageIds = new Set(pagesRef.current.map((page) => String(page.id)));
      const dirty = new Set<string>();

      // A removed shape's parent was captured while the record still existed,
      // so a delete lands on the page it was deleted from — including a remote
      // peer's delete on a page nobody here is looking at.
      for (const parent of parents) {
        if (pageIds.has(parent)) dirty.add(parent);
      }

      // Loose shapes (top-level, not parented to a frame) still need geometry,
      // but they are the exception rather than the rule, so the page-bounds
      // lookup is deferred until one actually turns up.
      let pageBounds: { id: string; bounds: Box }[] | null = null;
      for (const shapeId of shapeIds) {
        const shape = editor.getShape(shapeId);
        if (!shape) continue;
        const parent = String(shape.parentId);
        if (pageIds.has(parent)) {
          dirty.add(parent);
          continue;
        }
        const bounds = editor.getShapePageBounds(shapeId);
        if (!bounds) continue;
        if (pageBounds === null) {
          pageBounds = pagesRef.current
            .map((page) => {
              const box = boundsOf(editor, page.id);
              return box ? { id: String(page.id), bounds: box } : null;
            })
            .filter((entry): entry is { id: string; bounds: Box } => entry !== null);
        }
        for (const page of pageBounds) {
          if (page.bounds.collides(bounds)) dirty.add(page.id);
        }
      }

      for (const pageId of pagesUsingAssets(assetIds)) dirty.add(pageId);

      if (dirty.size === 0) return;
      for (const pageId of dirty) {
        dirtyRef.current.add(pageId);
        const entry = entriesRef.current.get(pageId);
        if (entry) {
          // Content moved on, so an earlier failure says nothing about this
          // attempt: the cool-off is cleared rather than waited out.
          entry.failedUntil = 0;
          entry.attempts = 0;
        }
      }
      wakeRef.current();
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
        for (const [, next] of Object.values(change.changes.updated)) {
          if (next.typeName === "shape") {
            touchedShapeIds.add(next.id);
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

    return () => {
      unsubscribe();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [editor, enabled]);

  // ── The render loop ────────────────────────────────────────────────────────
  //
  // Deliberately does not depend on `pages` or `currentPage`: both are read
  // through refs. Re-creating this effect on every page turn cancelled the
  // in-flight idle callback and restarted the queue from the top, which on a
  // board somebody is paging through means it never reaches the end of it.
  useEffect(() => {
    if (!editor || !enabled) return;

    const signal = { disposed: false };
    let idleHandle: number | null = null;
    let retryTimer: number | null = null;
    // This belongs to this effect generation. Keeping it in a component-wide
    // ref lets an obsolete render block a newly enabled scheduler, then clear
    // the flag without waking that scheduler when it eventually finishes.
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
      const entry = entriesRef.current.get(key);
      const now = Date.now();
      if (entry && entry.failedUntil > now) return null;
      if (entry && entry.attempts >= MAX_ATTEMPTS && !dirtyRef.current.has(key)) {
        return null;
      }

      const isCurrent = index === currentPageRef.current - 1;
      const distance = Math.abs(index - (currentPageRef.current - 1));
      const inRange = visibleRef.current.has(key) || distance <= NEIGHBOUR_WINDOW;
      if (!inRange) return null;

      const blank = !entry?.thumbnail;
      const outdated = dirtyRef.current.has(key) || entry?.thumbnail?.stale === true;
      if (!blank && !outdated && entry?.hash != null) return null;

      if (isCurrent && (blank || outdated)) return 0;
      if (blank) return 100 + distance;
      return 1_000 + distance;
    };

    const nextPage = (): WhiteboardPage | null => {
      const list = pagesRef.current;
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
      for (const entry of entriesRef.current.values()) {
        if (entry.failedUntil <= Date.now()) continue;
        if (entry.attempts >= MAX_ATTEMPTS) continue;
        soonest = soonest === null ? entry.failedUntil : Math.min(soonest, entry.failedUntil);
      }
      return soonest;
    };

    const markFailed = (key: string, keepThumbnail: boolean) => {
      const previous = entriesRef.current.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      entriesRef.current.set(key, {
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
      dirtyRef.current.delete(key);

      const content = contentOf(page);
      if (!content) {
        markFailed(key, true);
        return;
      }

      // A restored raster whose page has not moved on is already the answer.
      const existing = entriesRef.current.get(key);
      if (existing?.thumbnail && existing.hash === content.hash) {
        if (existing.thumbnail.stale) {
          entriesRef.current.set(key, {
            ...existing,
            thumbnail: { ...existing.thumbnail, stale: false },
            attempts: 0,
            failedUntil: 0,
          });
          publish();
          // Reused as it was stored, so the store hears of the use here.
          const boardId = boardKeyRef.current;
          if (boardId) void touchCachedThumbnail(boardId, key);
        }
        return;
      }

      await waitForPageImages(editor, content.shapeIds, resolveAssetUrlRef.current, signal);
      if (signal.disposed) return;

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
      if (signal.disposed) return;

      if (!image || image.width === 0 || image.height === 0) {
        markFailed(key, true);
        return;
      }

      // The page can disappear while image decoding or toImage is awaited.
      // Never resurrect it in memory or in the persistent thumbnail cache.
      if (!pagesRef.current.some((candidate) => String(candidate.id) === key)) return;

      const previous = entriesRef.current.get(key)?.thumbnail;
      entriesRef.current.set(key, {
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
      publish();

      const boardId = boardKeyRef.current;
      if (boardId) {
        void writeCachedThumbnail(boardId, key, {
          blob: image.blob,
          width: image.width,
          height: image.height,
          hash: content.hash,
        }).then(() => {
          if (!pagesRef.current.some((candidate) => String(candidate.id) === key)) {
            return deleteCachedThumbnails(boardId, [key]);
          }
        });
      }
    };

    const pump = () => {
      idleHandle = null;
      if (signal.disposed || running) return;
      const page = nextPage();
      if (!page) {
        armRetry();
        return;
      }
      running = true;
      void render(page).finally(() => {
        running = false;
        if (!signal.disposed) schedule();
      });
    };

    const schedule = () => {
      if (signal.disposed || idleHandle !== null || running) return;
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

    wakeRef.current = schedule;
    schedule();

    return () => {
      signal.disposed = true;
      wakeRef.current = () => {};
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (idleHandle !== null) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
        else window.clearTimeout(idleHandle);
      }
    };
  }, [editor, enabled, publish]);

  // A page turn or a new page changes what the loop should be working on, but
  // must not rebuild the loop. Waking it is the whole notification.
  useEffect(() => {
    wakeRef.current();
  }, [currentPage, pages]);

  // Drop thumbnails for pages that no longer exist, and release their rasters.
  useEffect(() => {
    const live = new Set(pages.map((page) => String(page.id)));
    const removed: string[] = [];
    for (const [pageId, entry] of entriesRef.current) {
      if (live.has(pageId)) continue;
      if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail.url);
      entriesRef.current.delete(pageId);
      dirtyRef.current.delete(pageId);
      refCallbacksRef.current.delete(pageId);
      removed.push(pageId);
    }
    if (removed.length === 0) return;
    if (boardKeyRef.current) {
      void deleteCachedThumbnails(boardKeyRef.current, removed);
    }
    publish();
  }, [pages, publish]);

  // Housekeeping for the persistent store, once per board once its page list
  // has settled: switching boards without remounting prunes the new one too.
  const prunedBoardRef = useRef<string | null>(null);
  useEffect(() => {
    if (prunedBoardRef.current === boardKey || !enabled || !boardKey || pages.length === 0) return;
    prunedBoardRef.current = boardKey;
    void pruneCachedThumbnails(boardKey, new Set(pages.map((page) => String(page.id))));
  }, [boardKey, enabled, pages]);

  // Release every raster on unmount. An object URL outlives the component that
  // made it, so a board opened and closed twenty times leaks twenty sets.
  useEffect(() => {
    const entries = entriesRef.current;
    return () => {
      for (const entry of entries.values()) {
        if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail.url);
      }
      entries.clear();
    };
  }, []);

  return { byPageId, observe };
}
