import { buildWhiteboardAssetViewerUrl } from "@orbmeet/whiteboard-core/whiteboard-asset-key";

/**
 * Which stored version an asset is read for: a revision, as shown by one
 * board. A copied board shows assets another board owns, which it may read
 * only through its own reference to them, so the board travels with the
 * revision.
 */
export interface RevisionAssetScope {
  whiteboardId: string;
  revisionId: string;
}

/**
 * Resolve a captured asset for viewing or exporting a revision.
 *
 * Anything that is not one of ours is refused rather than handed back: a
 * snapshot predating the sync-side source policy can carry an absolute or
 * protocol-relative URL, and returning it unchanged would make rendering an
 * old capture fetch another origin. The live canvas helper already draws that
 * line; this path has to draw the same one.
 */
export function revisionAssetUrl(src: string | null, scope: RevisionAssetScope | null): string | null {
  if (!src) return null;
  const sameOrigin = buildWhiteboardAssetViewerUrl(src, scope?.whiteboardId);
  if (!sameOrigin) return null;
  if (!scope || !sameOrigin.includes("/api/wb-assets/")) return sameOrigin;
  const separator = sameOrigin.includes("?") ? "&" : "?";
  return `${sameOrigin}${separator}revisionId=${encodeURIComponent(scope.revisionId)}`;
}
