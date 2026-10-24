import type { Editor, TLShape } from "tldraw";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";

type ShapeParentId = Parameters<Editor["getSortedChildIdsForParent"]>[0];

type ShapeEditor = Pick<
  Editor,
  "getCurrentPageId" | "getShape" | "getSortedChildIdsForParent"
>;

/**
 * Depth-first walk of the current page's shape tree. Returns as soon as
 * `predicate` is satisfied, so existence checks never pay for materializing the
 * whole tree — this runs on the store-change path, where the document can hold
 * thousands of shapes.
 */
function someCurrentPageDescendantShape(
  editor: ShapeEditor,
  predicate: (shape: TLShape) => boolean,
): boolean {
  const visited = new Set<string>();

  const visitChildren = (parentId: ShapeParentId): boolean => {
    for (const childId of editor.getSortedChildIdsForParent(parentId)) {
      if (visited.has(childId)) continue;
      visited.add(childId);

      const shape = editor.getShape(childId);
      if (!shape) continue;

      if (predicate(shape)) return true;
      if (visitChildren(shape.id)) return true;
    }
    return false;
  };

  return visitChildren(editor.getCurrentPageId());
}

export function getCurrentPageDescendantShapes(editor: ShapeEditor): TLShape[] {
  const shapes: TLShape[] = [];
  someCurrentPageDescendantShape(editor, (shape) => {
    shapes.push(shape);
    return false;
  });
  return shapes;
}

export function currentPageHasRenderableContent(editor: ShapeEditor): boolean {
  return someCurrentPageDescendantShape(editor, (shape) => !isPageFrameShape(shape));
}
