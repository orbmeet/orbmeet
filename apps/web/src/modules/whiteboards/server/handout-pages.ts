import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { isRecord } from "@orbmeet/primitives";

/**
 * Reconcile historical Meeting page markers with the immutable Snapshot that
 * will actually be shown or exported. A page may have been deleted after its
 * first edit/presentation, so referential integrity can only be established at
 * the capture boundary, not when the marker is first written.
 */
export function filterCapturedHandoutPageIds(
  snapshot: unknown,
  requestedPageIds: readonly string[],
): string[] {
  const pageFrameIds = new Set<string>();
  if (!isRecord(snapshot) || !Array.isArray(snapshot.documents)) return [];
  for (const document of snapshot.documents) {
    if (!isRecord(document)) continue;
    if (!isRecord(document.state)) continue;
    if (
      document.state.typeName === "shape" &&
      document.state.type === WHITEBOARD_PAGE_SHAPE_TYPE &&
      typeof document.state.id === "string"
    ) {
      pageFrameIds.add(document.state.id);
    }
  }
  return requestedPageIds.filter((pageId) => pageFrameIds.has(pageId));
}
