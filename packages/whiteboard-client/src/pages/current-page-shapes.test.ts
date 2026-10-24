import { describe, expect, it } from "vitest";
import { currentPageHasRenderableContent, getCurrentPageDescendantShapes } from "./current-page-shapes";

function createEditor(
  shapes: Array<{
    id: string;
    parentId: string;
    type: string;
  }>,
) {
  return {
    getCurrentPageId: () => "page:page",
    getSortedChildIdsForParent: (parentId: string) =>
      shapes.filter((shape) => shape.parentId === parentId).map((shape) => shape.id),
    getShape: (id: string) => shapes.find((shape) => shape.id === id) ?? null,
  };
}

describe("current page shape traversal", () => {
  it("includes shapes nested inside the page frame", () => {
    const editor = createEditor([
      {
        id: "shape:frame",
        parentId: "page:page",
        type: "whiteboard-page",
      },
      { id: "shape:draw", parentId: "shape:frame", type: "draw" },
    ]);

    expect(getCurrentPageDescendantShapes(editor as never).map((shape) => shape.id)).toEqual([
      "shape:frame",
      "shape:draw",
    ]);
    expect(currentPageHasRenderableContent(editor as never)).toBe(true);
  });

  it("does not treat an empty page frame as renderable content", () => {
    const editor = createEditor([
      {
        id: "shape:frame",
        parentId: "page:page",
        type: "whiteboard-page",
      },
    ]);

    expect(currentPageHasRenderableContent(editor as never)).toBe(false);
  });

  it("treats an empty regular frame as renderable content", () => {
    const editor = createEditor([
      { id: "shape:regular-frame", parentId: "page:page", type: "frame" },
    ]);

    expect(currentPageHasRenderableContent(editor as never)).toBe(true);
  });
});
