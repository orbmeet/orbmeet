// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, TLShapeId } from "tldraw";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { useWhiteboardPageThumbnails } from "./use-page-thumbnails";
import type { WhiteboardPage } from "./page-manager";

const thumbnailCache = vi.hoisted(() => ({
  read: vi.fn(async () => new Map()),
  write: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  prune: vi.fn(async () => {}),
}));

vi.mock("./page-thumbnail-cache", () => ({
  readCachedThumbnails: thumbnailCache.read,
  writeCachedThumbnail: thumbnailCache.write,
  deleteCachedThumbnails: thumbnailCache.remove,
  pruneCachedThumbnails: thumbnailCache.prune,
}));

/**
 * The reported failures, as tests.
 *
 * Every case here is one of "the thumbnail never appeared", "it appeared on one
 * device and not the other", or "it lagged by seconds" — and every one of them
 * came from the scheduler rather than from the rasteriser. They are written
 * against the fake editor below because the interesting behaviour is entirely
 * about *when* `toImage` is called and for which page; what it returns is
 * beside the point.
 */

const PAGE_WIDTH = 1200;
const PAGE_HEIGHT = 1600;

interface FakeShape {
  id: TLShapeId;
  type: string;
  x: number;
  y: number;
  rotation: number;
  index: string;
  parentId: string;
  props: Record<string, unknown>;
}

type StoreListener = (change: {
  changes: {
    added: Record<string, unknown>;
    updated: Record<string, [unknown, unknown]>;
    removed: Record<string, unknown>;
  };
}) => void;

function makePages(count: number): WhiteboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape:page-${index + 1}` as TLShapeId,
    number: index + 1,
    y: index * (PAGE_HEIGHT + 40),
    height: PAGE_HEIGHT,
    width: PAGE_WIDTH,
  }));
}

function createFakeEditor(pages: WhiteboardPage[]) {
  const listeners = new Set<StoreListener>();
  const shapes = new Map<string, FakeShape>();
  const assets = new Map<string, { props: { src: string | null } }>();

  for (const page of pages) {
    shapes.set(String(page.id), {
      id: page.id,
      type: WHITEBOARD_PAGE_SHAPE_TYPE,
      x: 0,
      y: page.y,
      rotation: 0,
      index: "a1",
      parentId: "page:main",
      props: { w: page.width, h: page.height },
    });
  }

  const toImage = vi.fn(async (ids: TLShapeId[], options?: { pixelRatio: number }) => {
    void ids;
    void options;
    return { blob: new Blob(["png"]), width: 176, height: 235 };
  });

  const editor = {
    store: {
      listen: (listener: StoreListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    getShape: (id: unknown) => shapes.get(String(id)),
    getAsset: (id: unknown) => assets.get(String(id)),
    getShapePageBounds: (id: unknown) => {
      const shape = shapes.get(String(id));
      if (!shape) return undefined;
      const w = (shape.props.w as number) ?? 10;
      const h = (shape.props.h as number) ?? 10;
      return { x: shape.x, y: shape.y, w, h };
    },
    getCurrentPageShapes: () => [...shapes.values()],
    getCurrentPageShapesSorted: () => [...shapes.values()],
    toImage,
  } as unknown as Editor;

  const emit = (changes: {
    added?: Record<string, unknown>;
    updated?: Record<string, [unknown, unknown]>;
    removed?: Record<string, unknown>;
  }) => {
    for (const listener of listeners) {
      listener({
        changes: {
          added: changes.added ?? {},
          updated: changes.updated ?? {},
          removed: changes.removed ?? {},
        },
      });
    }
  };

  return { editor, emit, shapes, assets, toImage };
}

function Probe({
  editor,
  pages,
  currentPage,
  enabled = true,
  whiteboardUrl,
  documentId,
}: {
  editor: Editor;
  pages: WhiteboardPage[];
  currentPage: number;
  enabled?: boolean;
  whiteboardUrl?: string;
  documentId?: string;
}) {
  const thumbnails = useWhiteboardPageThumbnails({
    editor,
    pages,
    currentPage,
    enabled,
    whiteboardUrl,
    documentId,
  });
  // Every card reports itself visible: the intersection observer is stubbed
  // out below, so this stands in for a rail scrolled to show everything.
  return (
    <div>
      {pages.map((page) => (
        <div key={page.id} ref={thumbnails.observe(String(page.id))} />
      ))}
    </div>
  );
}

/** Which pages `toImage` was asked for, in order, as page shape ids. */
function renderedPages(toImage: ReturnType<typeof vi.fn>): string[] {
  return toImage.mock.calls.map((call) => String((call[0] as TLShapeId[])[0]));
}

/** Let the idle-callback pump and any awaited render settle. */
async function settle(times = 12) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(200);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  thumbnailCache.read.mockReset().mockResolvedValue(new Map());
  thumbnailCache.write.mockReset().mockResolvedValue(undefined);
  thumbnailCache.remove.mockReset().mockResolvedValue(undefined);
  thumbnailCache.prune.mockReset().mockResolvedValue(undefined);
  // Every observed card counts as on screen. The scheduling policy is what is
  // under test, not the rail's scroll position.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(node: Element) {
        this.callback(
          [{ target: node, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("cancelIdleCallback", undefined);
  URL.createObjectURL = vi.fn(() => "blob:thumb");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWhiteboardPageThumbnails", () => {
  it("draws the page you are on before the rest of the document", async () => {
    const pages = makePages(5);
    const { editor, toImage } = createFakeEditor(pages);
    render(<Probe editor={editor} pages={pages} currentPage={3} />);
    await settle();
    expect(renderedPages(toImage)[0]).toBe("shape:page-3");
  });

  it("re-renders a page when its image asset resolves, not only when a shape changes", async () => {
    // The bug: invalidation listened for `shape` records and ignored `asset`
    // records. An imported PDF page's image resolves a moment *after* the
    // shape referencing it exists, and nothing about the shape changes when it
    // does — so the blank first render was the last one, permanently. Two
    // devices racing that load is exactly how one shows page 4 and the other
    // shows a white rectangle.
    const pages = makePages(2);
    const { editor, emit, shapes, assets, toImage } = createFakeEditor(pages);
    shapes.set("shape:img", {
      id: "shape:img" as TLShapeId,
      type: "image",
      x: 0,
      y: pages[1].y,
      rotation: 0,
      index: "a1",
      parentId: "shape:page-2",
      props: { assetId: "asset:pdf", w: 100, h: 100 },
    });
    assets.set("asset:pdf", { props: { src: null } });

    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();
    const before = toImage.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    // The asset resolves. No shape record moves.
    assets.set("asset:pdf", { props: { src: "https://cdn.example/page.png" } });
    emit({ updated: { "asset:pdf": [{ typeName: "asset", id: "asset:pdf" }, { typeName: "asset", id: "asset:pdf" }] } });
    // Long enough to cover the render's own wait for the image to decode.
    await settle(40);

    expect(renderedPages(toImage).slice(before)).toContain("shape:page-2");
  });

  it("attributes a deletion to the page it was deleted from, not the viewer's page", async () => {
    // The old code dirtied *the local viewer's current page* on any deletion,
    // reasoning that an erase can only have happened where someone was
    // looking — true, but the someone is not necessarily you. A collaborator
    // erasing on page 4 refreshed page 1 here and never page 4.
    const pages = makePages(4);
    const { editor, emit, shapes, toImage } = createFakeEditor(pages);
    shapes.set("shape:gone", {
      id: "shape:gone" as TLShapeId,
      type: "draw",
      x: 0,
      y: pages[3].y,
      rotation: 0,
      index: "a1",
      parentId: "shape:page-4",
      props: {},
    });
    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();
    const before = toImage.mock.calls.length;

    // A collaborator erases it on page 4. Nobody here is looking at page 4.
    shapes.delete("shape:gone");
    emit({
      removed: {
        "shape:gone": {
          typeName: "shape",
          id: "shape:gone",
          parentId: "shape:page-4",
        },
      },
    });
    await settle();

    expect(renderedPages(toImage).slice(before)).toContain("shape:page-4");
  });

  it("retries a page whose render failed instead of leaving it blank forever", async () => {
    // A failed render set a cool-off and returned to a pump that then found
    // nothing to do — with no timer armed for when the cool-off expired. The
    // page stayed blank until something unrelated woke the loop, which on a
    // quiet board is never.
    const pages = makePages(1);
    const { editor, toImage } = createFakeEditor(pages);
    toImage.mockRejectedValueOnce(new Error("canvas tainted"));

    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();
    expect(toImage).toHaveBeenCalledTimes(1);

    // Nothing else happens on the board. The retry has to come from the hook.
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(toImage.mock.calls.length).toBeGreaterThan(1);
  });

  it("gives up on a page that keeps failing rather than spinning on it", async () => {
    const pages = makePages(1);
    const { editor, toImage } = createFakeEditor(pages);
    toImage.mockRejectedValue(new Error("canvas tainted"));

    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    // Backed off and stopped, so a structurally broken page does not occupy
    // the queue that the other pages are waiting in.
    expect(toImage.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("refreshes on a ceiling even while the room keeps drawing", async () => {
    // A trailing-only debounce, reset by every store change, never fires while
    // somebody is drawing continuously — which is the "thumbnails lag by
    // several seconds" report. The settle timer now has a ceiling.
    const pages = makePages(2);
    const { editor, emit, shapes, toImage } = createFakeEditor(pages);
    shapes.set("shape:ink", {
      id: "shape:ink" as TLShapeId,
      type: "draw",
      x: 0,
      y: pages[1].y,
      rotation: 0,
      index: "a1",
      parentId: "shape:page-2",
      props: {},
    });

    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();
    const before = toImage.mock.calls.length;

    // A stroke every 300ms — closer together than the 700ms quiet window, so
    // the trailing edge alone would never arrive.
    for (let i = 0; i < 20; i++) {
      const ink = shapes.get("shape:ink")!;
      ink.x += 5;
      emit({ updated: { "shape:ink": [{ typeName: "shape", id: "shape:ink" }, { typeName: "shape", id: "shape:ink" }] } });
      await vi.advanceTimersByTimeAsync(300);
    }
    await settle();

    expect(renderedPages(toImage).slice(before)).toContain("shape:page-2");
  });

  it("rasterises at the card's device pixels, not its CSS pixels", async () => {
    // The blur: `pixelRatio` was solved to put 64 *physical* pixels into a 64
    // *CSS*-pixel card, so on any 2x display the rail upscaled every image.
    vi.stubGlobal("devicePixelRatio", 2);
    const pages = makePages(1);
    const { editor, toImage } = createFakeEditor(pages);
    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();

    const options = toImage.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    // 88px card x 2 device pixels, across a 1200pt page.
    expect(options!.pixelRatio).toBeCloseTo((88 * 2) / PAGE_WIDTH, 6);
  });

  it("caps the raster so a 3x phone does not triple the bitmap for nothing", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    const pages = makePages(1);
    const { editor, toImage } = createFakeEditor(pages);
    render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();

    const options = toImage.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    expect(options!.pixelRatio).toBeCloseTo((88 * 2) / PAGE_WIDTH, 6);
  });

  it("does not restart the queue from the top on every page turn", async () => {
    // The render loop used to depend on `currentPage`, so turning a page tore
    // the effect down, cancelled the in-flight idle callback and started the
    // queue again — on a board somebody is paging through, it never reached
    // the end of the document.
    const pages = makePages(6);
    const { editor, toImage } = createFakeEditor(pages);
    const { rerender } = render(<Probe editor={editor} pages={pages} currentPage={1} />);
    await settle();

    for (let page = 2; page <= 6; page++) {
      rerender(<Probe editor={editor} pages={pages} currentPage={page} />);
      await settle(2);
    }
    await settle();

    // Every page drawn, and none of them drawn twice: nothing was invalidated,
    // so a second render of the same page could only be a restart.
    const drawn = renderedPages(toImage);
    expect(new Set(drawn).size).toBe(6);
    expect(drawn).toHaveLength(6);
  });

  it("loads cached thumbnails when pages arrive after the cache effect starts", async () => {
    const pages = makePages(1);
    const { editor } = createFakeEditor(pages);
    thumbnailCache.read.mockResolvedValue(new Map([
      [
        String(pages[0].id),
        { blob: new Blob(["cached"]), width: 88, height: 117, hash: "cached-hash" },
      ],
    ]));
    const { rerender } = render(
      <Probe
        editor={editor}
        pages={[]}
        currentPage={1}
        whiteboardUrl="https://board.test/one"
        documentId="doc-one"
      />,
    );
    await settle(2);
    expect(thumbnailCache.read).not.toHaveBeenCalled();

    rerender(
      <Probe
        editor={editor}
        pages={pages}
        currentPage={1}
        whiteboardUrl="https://board.test/one"
        documentId="doc-one"
      />,
    );
    await settle(2);

    expect(thumbnailCache.read).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("starts a new render scheduler when re-enabled during an obsolete render", async () => {
    const pages = makePages(2);
    const { editor, toImage } = createFakeEditor(pages);
    let finishFirst!: (value: { blob: Blob; width: number; height: number }) => void;
    toImage.mockImplementationOnce(
      () => new Promise((resolve) => { finishFirst = resolve; }),
    );
    const { rerender } = render(
      <Probe editor={editor} pages={pages} currentPage={1} enabled />,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(toImage).toHaveBeenCalledOnce();

    rerender(<Probe editor={editor} pages={pages} currentPage={1} enabled={false} />);
    rerender(<Probe editor={editor} pages={pages} currentPage={1} enabled />);
    await vi.advanceTimersByTimeAsync(200);

    expect(toImage.mock.calls.length).toBeGreaterThan(1);
    finishFirst({ blob: new Blob(["late"]), width: 176, height: 235 });
    await settle(2);
  });

  it("does not resurrect a page deleted while its raster is rendering", async () => {
    const pages = makePages(1);
    const { editor, toImage } = createFakeEditor(pages);
    let finish!: (value: { blob: Blob; width: number; height: number }) => void;
    toImage.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const { rerender } = render(
      <Probe editor={editor} pages={pages} currentPage={1} whiteboardUrl="https://board.test/one" />,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(toImage).toHaveBeenCalledOnce();

    rerender(
      <Probe editor={editor} pages={[]} currentPage={1} whiteboardUrl="https://board.test/one" />,
    );
    finish({ blob: new Blob(["late"]), width: 176, height: 235 });
    await settle(2);

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(thumbnailCache.write).not.toHaveBeenCalled();
  });
});
