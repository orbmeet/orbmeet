import { describe, expect, it, vi } from "vitest";
import { Box, type Editor, type TLShapeId } from "tldraw";
import { buildWhiteboardPdfBlob } from "./export-pdf";

type FakeShape = {
  id: TLShapeId;
  type: string;
  parentId: TLShapeId;
  x: number;
  y: number;
  props: { w?: number; h?: number; name?: string };
};

class FailingExportEditor {
  private readonly shapes: FakeShape[];

  constructor(shapes: FakeShape[]) {
    this.shapes = shapes;
  }

  getCurrentPageShapesSorted() {
    return this.shapes;
  }

  getCurrentPageShapes() {
    return this.shapes;
  }

  getShape(id: TLShapeId) {
    return this.shapes.find((entry) => entry.id === id) ?? null;
  }

  getAsset() {
    return null;
  }

  getShapePageBounds(shapeOrId: TLShapeId | FakeShape) {
    const shape =
      typeof shapeOrId === "string"
        ? this.shapes.find((entry) => entry.id === shapeOrId)
        : shapeOrId;
    if (!shape) return null;
    return new Box(
      shape.x,
      shape.y,
      shape.props.w ?? 100,
      shape.props.h ?? 100,
    );
  }

  async toImage() {
    throw new Error("renderer unavailable");
  }
}

describe("buildWhiteboardPdfBlob", () => {
  it("fails the export instead of inserting a silent blank page", async () => {
    const pageId = "shape:page-1" as TLShapeId;
    const editor = new FailingExportEditor([
      {
        id: pageId,
        type: "whiteboard-page",
        parentId: "page:page" as TLShapeId,
        x: 0,
        y: 0,
        props: { w: 1200, h: 900, name: "Page 1" },
      },
    ]);

    await expect(
      buildWhiteboardPdfBlob(editor as unknown as Editor, [pageId], {
        capabilities: {
          reduceRasterMemory: false,
          disableCoalescedPointerEvents: false,
        },
      }),
    ).rejects.toThrow("renderer unavailable");
  });

  it("prefetches peer-authored image assets without sending credentials cross-origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 502 }));

    const pageId = "shape:page-1" as TLShapeId;
    const imageId = "shape:image-1" as TLShapeId;
    const assetId = "asset:planted";
    const imageShape = {
      id: imageId,
      type: "image",
      parentId: "page:page" as TLShapeId,
      x: 0,
      y: 0,
      props: { assetId },
    };
    const editor = {
      getCurrentPageShapesSorted: () => [imageShape],
      getShape: (id: TLShapeId) => (id === imageId ? imageShape : null),
      getAsset: () => ({ props: { src: "https://evil.example/beacon.png" } }),
      getShapePageBounds: () => new Box(0, 0, 100, 100),
      toImage: async () => {
        throw new Error("renderer unavailable");
      },
    };

    await buildWhiteboardPdfBlob(editor as unknown as Editor, [pageId], {
      capabilities: { reduceRasterMemory: false, disableCoalescedPointerEvents: false },
    }).catch(() => undefined);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://evil.example/beacon.png",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    fetchSpy.mockRestore();
  });
});
