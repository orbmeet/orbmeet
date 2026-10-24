import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { PageManager } from "../pages/page-manager";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { registerShapeParentingSideEffect } from "./shape-parenting";

type FakeShape = {
  id: TLShapeId;
  type: TLShape["type"];
  parentId: TLShapeId;
  x: number;
  y: number;
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

class FakeEditor {
  private readonly pageId = "page:page" as TLShapeId;
  private readonly shapes = new Map<TLShapeId, FakeShape>();
  afterCreateHandler:
    | ((shape: FakeShape, source: "user" | "remote" | "system") => void)
    | null = null;

  readonly inputs = {
    getIsPointing: () => false,
    getIsDragging: () => false,
  };

  readonly sideEffects = {
    registerAfterCreateHandler: (
      _type: "shape",
      handler: (shape: FakeShape, source: "user" | "remote" | "system") => void,
    ) => {
      this.afterCreateHandler = handler;
      return vi.fn();
    },
    registerAfterChangeHandler: () => vi.fn(),
  };

  getCurrentPageId() {
    return this.pageId;
  }

  getCurrentPageShapes() {
    return Array.from(this.shapes.values());
  }

  getShape(id: TLShapeId) {
    return this.shapes.get(id) ?? null;
  }

  createShape(shape: FakeShape) {
    this.shapes.set(shape.id, shape);
    this.afterCreateHandler?.(shape, "user");
  }

  getShapePageBounds(shapeOrId: TLShapeId | FakeShape) {
    const shape =
      typeof shapeOrId === "string"
        ? this.shapes.get(shapeOrId)
        : shapeOrId;
    if (!shape) return null;

    const isPageLike =
      shape.type === "frame" || shape.type === WHITEBOARD_PAGE_SHAPE_TYPE;
    const width = isPageLike ? Number(shape.props.w ?? 800) : 100;
    const height = isPageLike ? Number(shape.props.h ?? 1000) : 100;

    return {
      center: {
        x: shape.x + width / 2,
        y: shape.y + height / 2,
      },
    };
  }

  reparentShapes(ids: TLShapeId[], frameId: TLShapeId) {
    for (const id of ids) {
      const current = this.shapes.get(id);
      if (!current) continue;
      this.shapes.set(id, { ...current, parentId: frameId });
    }
  }

  deleteShapes(ids: TLShapeId[]) {
    for (const id of ids) {
      this.shapes.delete(id);
    }
  }
}

describe("registerShapeParentingSideEffect", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes user-created shapes whose center is outside every page frame", () => {
    const editor = new FakeEditor();
    const pageId = "shape:page-1" as TLShapeId;
    const shapeId = "shape:outside" as TLShapeId;

    editor.createShape({
      id: pageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { w: 800, h: 1000, name: "Page 1" },
    });

    const pageManager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });
    const cleanup = registerShapeParentingSideEffect(
      editor as unknown as Editor,
      () => pageManager,
    );

    editor.createShape({
      id: shapeId,
      type: "draw",
      parentId: editor.getCurrentPageId(),
      x: 900,
      y: 1100,
      props: {},
    });

    expect(editor.getShape(shapeId)).toBeNull();
    cleanup();
  });

  it("reparents user-created shapes whose center lands inside a page frame", () => {
    const editor = new FakeEditor();
    const pageId = "shape:page-1" as TLShapeId;
    const shapeId = "shape:inside" as TLShapeId;

    editor.createShape({
      id: pageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { w: 800, h: 1000, name: "Page 1" },
    });

    const pageManager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });
    const cleanup = registerShapeParentingSideEffect(
      editor as unknown as Editor,
      () => pageManager,
    );

    editor.createShape({
      id: shapeId,
      type: "geo",
      parentId: editor.getCurrentPageId(),
      x: 200,
      y: 200,
      props: {},
    });

    expect(editor.getShape(shapeId)?.parentId).toBe(pageId);
    cleanup();
  });

  describe("between and around stacked pages", () => {
    const firstPageId = "shape:page-1" as TLShapeId;
    const secondPageId = "shape:page-2" as TLShapeId;

    function twoPageBoard() {
      const editor = new FakeEditor();
      for (const [id, y, name] of [[firstPageId, 0, "Page 1"], [secondPageId, 1100, "Page 2"]] as const) {
        editor.createShape({
          id,
          type: "whiteboard-page",
          parentId: editor.getCurrentPageId(),
          x: 0,
          y,
          props: { w: 800, h: 1000, name },
        });
      }
      const pageManager = new PageManager(editor as unknown as Editor, {
        width: 800,
        height: 1000,
        spacing: 100,
      });
      const cleanup = registerShapeParentingSideEffect(
        editor as unknown as Editor,
        () => pageManager,
      );
      return { editor, cleanup };
    }

    function drawCentredAt(editor: FakeEditor, id: TLShapeId, x: number, y: number) {
      // FakeEditor gives drawn shapes a 100x100 box.
      editor.createShape({ id, type: "draw", parentId: editor.getCurrentPageId(), x: x - 50, y: y - 50, props: {} });
    }

    it("keeps a shape centred in the gap between two pages on the page above", () => {
      const { editor, cleanup } = twoPageBoard();
      const shapeId = "shape:straddling" as TLShapeId;

      drawCentredAt(editor, shapeId, 400, 1050);

      expect(editor.getShape(shapeId)?.parentId).toBe(firstPageId);
      cleanup();
    });

    it("deletes a shape centred above the first page", () => {
      const { editor, cleanup } = twoPageBoard();
      const shapeId = "shape:above" as TLShapeId;

      drawCentredAt(editor, shapeId, 400, -20);

      expect(editor.getShape(shapeId)).toBeNull();
      cleanup();
    });

    it("deletes a shape centred past the bottom of the last page", () => {
      const { editor, cleanup } = twoPageBoard();
      const shapeId = "shape:below" as TLShapeId;

      drawCentredAt(editor, shapeId, 400, 2150);

      expect(editor.getShape(shapeId)).toBeNull();
      cleanup();
    });

    it("deletes a shape centred beside the pages", () => {
      const { editor, cleanup } = twoPageBoard();
      const shapeId = "shape:beside" as TLShapeId;

      drawCentredAt(editor, shapeId, 900, 500);

      expect(editor.getShape(shapeId)).toBeNull();
      cleanup();
    });
  });

  it("reparents user-created regular frames inside a page frame", () => {
    const editor = new FakeEditor();
    const pageId = "shape:page-1" as TLShapeId;
    const frameId = "shape:regular-frame" as TLShapeId;

    editor.createShape({
      id: pageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { w: 800, h: 1000, name: "Page 1" },
    });

    const pageManager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });
    const cleanup = registerShapeParentingSideEffect(
      editor as unknown as Editor,
      () => pageManager,
    );

    editor.createShape({
      id: frameId,
      type: "frame",
      parentId: editor.getCurrentPageId(),
      x: 100,
      y: 100,
      props: { w: 300, h: 200, name: "Regular frame" },
    });

    expect(editor.getShape(frameId)?.parentId).toBe(pageId);
    cleanup();
  });

  it("deletes user-created regular frames outside every page frame", () => {
    const editor = new FakeEditor();
    const pageId = "shape:page-1" as TLShapeId;
    const frameId = "shape:regular-frame" as TLShapeId;

    editor.createShape({
      id: pageId,
      type: "whiteboard-page",
      parentId: editor.getCurrentPageId(),
      x: 0,
      y: 0,
      props: { w: 800, h: 1000, name: "Page 1" },
    });

    const pageManager = new PageManager(editor as unknown as Editor, {
      width: 800,
      height: 1000,
      spacing: 100,
    });
    const cleanup = registerShapeParentingSideEffect(
      editor as unknown as Editor,
      () => pageManager,
    );

    editor.createShape({
      id: frameId,
      type: "frame",
      parentId: editor.getCurrentPageId(),
      x: 900,
      y: 1100,
      props: { w: 300, h: 200, name: "Regular frame" },
    });

    expect(editor.getShape(frameId)).toBeNull();
    cleanup();
  });
});
