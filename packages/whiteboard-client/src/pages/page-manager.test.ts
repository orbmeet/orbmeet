import { describe, expect, it } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { DEFAULT_PAGE_BACKGROUND } from "@orbmeet/whiteboard-core/page-background";
import { PageManager } from "./page-manager";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";

type FakeShape = {
  id: TLShapeId;
  type: TLShape["type"];
  parentId: TLShapeId;
  x: number;
  y: number;
  index?: string;
  props?: {
    name?: string;
    h?: number;
    w?: number;
    background?: string;
  };
  meta?: Record<string, unknown>;
  isLocked?: boolean;
};

class FakeEditor {
  private readonly pageId = "page:page" as unknown as TLShapeId;
  private readonly shapes = new Map<TLShapeId, FakeShape>();
  readonly runOptions: unknown[] = [];

  getCurrentPageId() {
    return this.pageId;
  }

  getCurrentPageShapes() {
    return Array.from(this.shapes.values());
  }

  getCurrentPageShapesSorted() {
    return Array.from(this.shapes.values());
  }

  getShape(id: TLShapeId) {
    return this.shapes.get(id) ?? null;
  }

  createShape(shape: FakeShape) {
    this.shapes.set(shape.id, shape);
  }

  run<T>(fn: () => T, opts?: unknown): this {
    this.runOptions.push(opts);
    fn();
    return this;
  }

  updateShapes(updates: Array<Partial<FakeShape> & Pick<FakeShape, "id" | "type">>) {
    for (const update of updates) {
      const current = this.shapes.get(update.id);
      if (!current) continue;
      this.shapes.set(update.id, {
        ...current,
        ...update,
        props: update.props
          ? {
              ...current.props,
              ...update.props,
            }
          : current.props,
        meta: update.meta
          ? {
              ...current.meta,
              ...update.meta,
            }
          : current.meta,
      });
    }
  }

  deleteShapes(ids: TLShapeId[]) {
    const pending = [...ids];
    for (const id of pending) {
      this.shapes.delete(id);
      for (const shape of this.shapes.values()) {
        if (shape.parentId === id) pending.push(shape.id);
      }
    }
  }

  getShapePageBounds(shapeOrId: TLShapeId | FakeShape) {
    const shape =
      typeof shapeOrId === "string"
        ? this.shapes.get(shapeOrId)
        : shapeOrId;
    if (!shape) return null;

    const isPageLike =
      shape.type === "frame" || shape.type === WHITEBOARD_PAGE_SHAPE_TYPE;
    const width = isPageLike ? (shape.props?.w ?? 800) : 100;
    const height = isPageLike ? (shape.props?.h ?? 1000) : 100;

    return {
      x: shape.x,
      y: shape.y,
      w: width,
      h: height,
      width,
      height,
      center: {
        x: shape.x + width / 2,
        y: shape.y + height / 2,
      },
    };
  }

  getShapeMaskedPageBounds(shapeOrId: TLShapeId | FakeShape) {
    return this.getShapePageBounds(shapeOrId);
  }
}

describe("PageManager.insertPagesAt", () => {
  it("inserts at index 0 relative to the first page, not absolute y=0", () => {
    const editor = new FakeEditor();
    const driftedPageId = "shape:page-drifted" as TLShapeId;

    // A document whose first page does not sit at y=0 (drift from older
    // content or a divergent peer). The insert must use the measured top.
    editor.createShape({
      id: driftedPageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 120,
      props: { name: "Page 1", w: 800, h: 1000 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    const [insertedId] = manager.insertPagesAt(0, 1);

    const pages = manager.getPages();
    expect(pages[0]?.id).toBe(insertedId);
    expect(pages[0]?.y).toBe(120);
    // The old first page shifted down by exactly one page slot.
    expect(pages[1]?.id).toBe(driftedPageId);
    expect(pages[1]?.y).toBe(120 + 1000 + 100);
  });

  it("appends after a custom-height page using its measured height", () => {
    const editor = new FakeEditor();
    const tallPageId = "shape:page-tall" as TLShapeId;

    editor.createShape({
      id: tallPageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page 1", w: 800, h: 1700 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    const [insertedId] = manager.insertPagesAt(1, 1);

    const pages = manager.getPages();
    expect(pages[1]?.id).toBe(insertedId);
    expect(pages[1]?.y).toBe(1700 + 100);
  });
});

describe("PageManager page recognition", () => {
  it("selects the current page from the canonical visible viewport", () => {
    const editor = new FakeEditor();
    editor.createShape({
      id: "shape:page-1" as TLShapeId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page 1", w: 800, h: 1000 },
    });
    editor.createShape({
      id: "shape:page-2" as TLShapeId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 1100,
      props: { name: "Page 2", w: 800, h: 1000 },
    });
    const visibleBounds = { x: 0, y: 1120, w: 800, h: 300 };
    const manager = new PageManager(
      editor as unknown as Editor,
      { width: 800, height: 1000, spacing: 100 },
      () => visibleBounds,
    );

    expect(manager.getViewportBounds()).toBe(visibleBounds);
    expect(manager.getCurrentPage()).toBe(2);
  });

  it.each([
    // The view's middle sits in the gap between the pages, page 1 fills most of it.
    { view: { x: 0, y: 500, w: 800, h: 1100 }, page: 1 },
    { view: { x: 0, y: 1000, w: 800, h: 900 }, page: 2 },
  ])("names the page filling most of the view (%#)", ({ view, page }) => {
    const editor = new FakeEditor();
    for (const [index, y] of [0, 1100].entries()) {
      editor.createShape({
        id: `shape:page-${index + 1}` as TLShapeId,
        type: "whiteboard-page",
        parentId: editor.getCurrentPageId(),
        x: 0,
        y,
        props: { name: `Page ${index + 1}`, w: 800, h: 1000 },
      });
    }
    const manager = new PageManager(
      editor as unknown as Editor,
      { width: 800, height: 1000, spacing: 100 },
      () => view,
    );
    expect(manager.getCurrentPage()).toBe(page);
  });

  it("identifies whiteboard page shapes", () => {
    const editor = new FakeEditor();
    editor.createShape({
      id: "shape:pf-1" as TLShapeId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page 1", w: 800, h: 1000 },
    });
    editor.createShape({
      id: "shape:regular" as TLShapeId,
      type: "frame",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 1100,
      props: { name: "My Frame", w: 400, h: 300 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    expect(manager.getPages().length).toBe(1);
    expect(manager.getPages()[0].id).toBe("shape:pf-1" as TLShapeId);
  });

  it("does not match regular frames named 'Page ...'", () => {
    const editor = new FakeEditor();
    editor.createShape({
      id: "shape:fake-page" as TLShapeId,
      type: "frame",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page created by user", w: 500, h: 400 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    expect(manager.getPages().length).toBe(0);
  });
});

describe("PageManager page lookup", () => {
  it("orders equal-y page frames deterministically", () => {
    const editor = new FakeEditor();
    const pageAId = "shape:page-a" as TLShapeId;
    const pageBId = "shape:page-b" as TLShapeId;

    editor.createShape({
      id: pageBId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      index: "b",
      x: 0,
      y: 0,
      props: { name: "Page B", w: 800, h: 1000 },
    });
    editor.createShape({
      id: pageAId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      index: "a",
      x: 0,
      y: 0,
      props: { name: "Page A", w: 800, h: 1000 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    expect(manager.getPages().map((page) => page.id)).toEqual([
      pageAId,
      pageBId,
    ]);
  });

  it("finds page frames by stable id and derived page number", () => {
    const editor = new FakeEditor();
    const page1Id = "shape:page-1" as TLShapeId;
    const page2Id = "shape:page-2" as TLShapeId;

    editor.createShape({
      id: page1Id,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page 1", w: 800, h: 1000 },
    });
    editor.createShape({
      id: page2Id,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 1100,
      props: { name: "Page 2", w: 800, h: 1000 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    expect(manager.getPageById(page2Id)?.number).toBe(2);
    expect(manager.getPageByNumber(1)?.id).toBe(page1Id);
  });
});

describe("PageManager.createPage", () => {
  it("creates whiteboard page shapes", () => {
    const editor = new FakeEditor();
    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    const id = manager.createPage();
    expect(id).not.toBeNull();

    const shape = editor.getShape(id!);
    expect(shape?.type).toBe(WHITEBOARD_PAGE_SHAPE_TYPE);
    expect(shape?.props).toMatchObject({
      name: "Page 1",
      w: 800,
      h: 1000,
      background: DEFAULT_PAGE_BACKGROUND,
    });
    expect(shape?.meta?.isPageFrame).toBeUndefined();

    // Now it should appear in getPages
    expect(manager.getPages().length).toBe(1);
  });

  it("keeps page-frame structure changes out of tldraw history", () => {
    const editor = new FakeEditor();
    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    manager.createPage();

    expect(editor.runOptions).toEqual([{ history: "ignore" }]);
  });

  it("does not retag an existing non-page frame that uses the reserved initial page id", () => {
    const editor = new FakeEditor();
    const existingPageId = "shape:page-1" as TLShapeId;
    editor.createShape({
      id: existingPageId,
      type: "frame",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { name: "Page 1", w: 800, h: 1000 },
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    const id = manager.createPage();

    expect(id).not.toBeNull();
    const createdId = id!;
    expect(id).not.toBe(existingPageId);
    expect(editor.getShape(existingPageId)?.meta).toBeUndefined();
    expect(manager.getPages()).toEqual([
      {
        id: createdId,
        number: 1,
        y: 0,
        height: 1000,
        width: 800,
      },
    ]);
  });
});

describe("PageManager.compactPages", () => {
  it("keeps the layout cursor advancing past a frame that can no longer be read", () => {
    const editor = new FakeEditor();
    const pageIds = ["shape:page-1", "shape:page-2", "shape:page-3"] as TLShapeId[];
    pageIds.forEach((id, index) => {
      editor.createShape({
        id,
        type: "whiteboard-page",
        parentId: editor.getCurrentPageId(),
        x: 0,
        y: index * 2200,
        props: { name: `Page ${index + 1}`, w: 800, h: 1000 },
      });
    });

    // Page 2 disappears between the getPages() listing and the per-frame read
    // (a concurrent remote delete). It cannot be moved, but the pages after it
    // must still land on their own slots rather than stacking onto page 1.
    const realGetShape = editor.getShape.bind(editor);
    editor.getShape = ((id: TLShapeId) =>
      id === pageIds[1] ? null : realGetShape(id));

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    manager.compactPages();

    editor.getShape = realGetShape;
    expect(editor.getShape(pageIds[0])?.y).toBe(0);
    expect(editor.getShape(pageIds[2])?.y).toBe(2200);
  });
});

describe("PageManager.deletePage", () => {
  it("removes the target page and compacts the remaining page count", () => {
    const editor = new FakeEditor();
    const pageIds = Array.from(
      { length: 5 },
      (_, index) => `shape:page-${index + 1}` as TLShapeId
    );

    pageIds.forEach((id, index) => {
      editor.createShape({
        id,
        type: "whiteboard-page",
        parentId: editor.getCurrentPageId(),
        x: 0,
        y: index * 1100,
        props: { name: `Page ${index + 1}`, w: 800, h: 1000 },
      });
    });

    const manager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });

    expect(manager.deletePage(pageIds[2])).toBe(true);

    const pages = manager.getPages();
    expect(pages).toHaveLength(4);
    expect(pages.map((page) => page.id)).toEqual([
      pageIds[0],
      pageIds[1],
      pageIds[3],
      pageIds[4],
    ]);
    expect(pages.map((page) => page.number)).toEqual([1, 2, 3, 4]);
    expect(editor.getShape(pageIds[3])?.y).toBe(2200);
    expect(editor.getShape(pageIds[4])?.y).toBe(3300);
    expect(editor.getShape(pageIds[3])?.props?.name).toBe("Page 3");
    expect(editor.getShape(pageIds[4])?.props?.name).toBe("Page 4");
  });

});

describe("PageManager: everything on a page belongs to it", () => {
  function twoPages() {
    const editor = new FakeEditor();
    const page1Id = "shape:page-1" as TLShapeId;
    const page2Id = "shape:page-2" as TLShapeId;
    for (const [id, y] of [[page1Id, 0], [page2Id, 1300]] as const) {
      editor.createShape({
        id,
        type: "whiteboard-page",
        parentId: editor.getCurrentPageId(),
        x: 0,
        y,
        props: { name: id, w: 800, h: 1000 },
      });
    }
    editor.createShape({ id: "shape:on-1" as TLShapeId, type: "geo", parentId: page1Id, x: 100, y: 200, props: {} });
    editor.createShape({ id: "shape:on-2" as TLShapeId, type: "geo", parentId: page2Id, x: 100, y: 200, props: {} });
    const manager = new PageManager(editor as unknown as Editor, { width: 800, height: 1000, spacing: 100 });
    return { editor, manager, page1Id, page2Id };
  }

  it("moves only the pages when a page is inserted: their content rides with them", () => {
    const { editor, manager, page2Id } = twoPages();
    manager.insertPagesAt(1, 1);
    expect(editor.getShape(page2Id)?.y).toBe(2400);
    expect(editor.getShape("shape:on-2" as TLShapeId)).toMatchObject({ parentId: page2Id, x: 100, y: 200 });
  });

  it("moves only the pages when the gaps between them are closed", () => {
    const { editor, manager, page2Id } = twoPages();
    manager.compactPages();
    expect(editor.getShape(page2Id)?.y).toBe(1100);
    expect(editor.getShape("shape:on-2" as TLShapeId)).toMatchObject({ x: 100, y: 200 });
  });

  it("takes a deleted page's content with it, and leaves every other page's alone", () => {
    const { editor, manager, page1Id, page2Id } = twoPages();
    expect(manager.deletePage(page1Id)).toBe(true);
    expect(editor.getShape("shape:on-1" as TLShapeId)).toBeNull();
    expect(editor.getShape("shape:on-2" as TLShapeId)).toMatchObject({ parentId: page2Id, x: 100, y: 200 });
    expect(editor.getShape(page2Id)?.y).toBe(0);
  });
});
