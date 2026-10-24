import { Box, type Editor, type TLParentId, type TLShapeId } from "tldraw";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";

export interface DrawableShapeEntry {
  id: TLShapeId;
  bounds: Box;
  parentId: TLParentId;
}

export interface ExportFrameContent {
  shapeIds: TLShapeId[];
}

export function getDrawableShapeEntries(editor: Editor): DrawableShapeEntry[] {
  return editor
    .getCurrentPageShapesSorted()
    .filter((shape) => !isPageFrameShape(shape))
    .map((shape) => {
      const bounds = editor.getShapePageBounds(shape.id);
      return bounds
        ? { id: shape.id, bounds, parentId: shape.parentId }
        : null;
    })
    .filter((entry): entry is DrawableShapeEntry => Boolean(entry));
}

function boundsIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function getFrameExportContent(
  editor: Editor,
  frameId: TLShapeId,
  frameBounds: Box,
  entries: DrawableShapeEntry[],
): ExportFrameContent {
  const shapeIds: TLShapeId[] = [];

  for (const entry of entries) {
    if (entry.parentId === frameId) {
      shapeIds.push(entry.id);
      continue;
    }

    // Descendants render with their top-level parent. Including them again by
    // page overlap duplicates grouped/frame content in multi-page exports.
    if (editor.getShape(entry.parentId)) continue;

    if (boundsIntersect(entry.bounds, frameBounds)) {
      shapeIds.push(entry.id);
    }
  }

  return { shapeIds };
}

export function forceRenderSingleFrameLikeShape(shapeIds: TLShapeId[]): TLShapeId[] {
  // tldraw treats an export of exactly one frame-like shape as "use this frame
  // only as bounds" and skips the frame's own SVG. Passing the id twice keeps
  // the exported shape set identical while ensuring custom page paper renders.
  return shapeIds.length === 1 ? [shapeIds[0], shapeIds[0]] : shapeIds;
}
