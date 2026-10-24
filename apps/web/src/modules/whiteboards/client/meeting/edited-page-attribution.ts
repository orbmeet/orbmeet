import type { Editor, TLRecord, TLShape, TLShapeId } from "tldraw";
import {
  getApproximateShapeCenterY,
  isPageFrameShape,
  type RecordChanges,
} from "@orbmeet/whiteboard-core/page-frame-model";
import { findLooseShapeOwnerIndex } from "@orbmeet/whiteboard-core/page-geometry";
import type { WhiteboardPage } from "@orbmeet/whiteboard-client/react";

function isShape(record: TLRecord | undefined): record is TLShape {
  return record?.typeName === "shape";
}

/** Resolve a changed shape through groups/frames to its owning page frame. */
function resolveChangedShapePageId(
  editor: Editor,
  pages: readonly WhiteboardPage[],
  changedRecords: ReadonlyMap<string, TLShape>,
  original: TLShape,
): TLShapeId | null {
  let shape = original;
  const visited = new Set<string>();
  while (true) {
    if (isPageFrameShape(shape)) return shape.id;
    if (visited.has(shape.id)) return null;
    visited.add(shape.id);

    if (typeof shape.parentId !== "string" || !shape.parentId.startsWith("shape:")) {
      const ownerIndex = findLooseShapeOwnerIndex(
        pages,
        getApproximateShapeCenterY(shape),
      );
      return ownerIndex >= 0 ? pages[ownerIndex]?.id ?? null : null;
    }

    const parent = changedRecords.get(shape.parentId) ?? editor.getShape(shape.parentId);
    if (!parent) return null;
    shape = parent;
  }
}

/**
 * Attribute a local document diff to the page records it actually changed.
 * Updated records contribute both their old and new ownership, so moving a
 * shape between pages marks both pages and deleting a nested group still works
 * from the records carried by the diff.
 */
export function getEditedPageIdsFromChanges(
  editor: Editor,
  pages: readonly WhiteboardPage[],
  changes: RecordChanges,
): TLShapeId[] {
  const versions: TLShape[] = [];
  const changedRecords = new Map<string, TLShape>();
  for (const record of Object.values(changes.added)) {
    if (!isShape(record)) continue;
    versions.push(record);
    changedRecords.set(record.id, record);
  }
  for (const [before, after] of Object.values(changes.updated)) {
    if (isShape(before)) versions.push(before);
    if (isShape(after)) {
      versions.push(after);
      changedRecords.set(after.id, after);
    }
  }
  for (const record of Object.values(changes.removed)) {
    if (!isShape(record)) continue;
    versions.push(record);
    if (!changedRecords.has(record.id)) changedRecords.set(record.id, record);
  }

  const pageIds = new Set<TLShapeId>();
  for (const shape of versions) {
    const pageId = resolveChangedShapePageId(editor, pages, changedRecords, shape);
    if (pageId) pageIds.add(pageId);
  }
  return [...pageIds];
}
