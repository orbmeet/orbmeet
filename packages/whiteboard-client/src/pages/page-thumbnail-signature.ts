import type { Editor, TLAssetId, TLShape, TLShapeId } from "tldraw";

/**
 * "Has this page changed since the raster we have?"
 *
 * The render loop tracks dirt with a counter, which is exact but dies with the
 * tab. A thumbnail restored from the cache on the next open has no counter to
 * compare against — only a picture and the claim that it was current once — so
 * something has to stand in for "the page still looks like that".
 *
 * A hash of the page's own shape records is that stand-in. It is computed for
 * one page at a time, inside the render loop's idle slot, so the cost of
 * checking twenty-four pages is spread across twenty-four idle callbacks
 * rather than charged to the first frame.
 *
 * What goes in is what a raster can actually show: position, rotation, the
 * shape's props, and its index among its siblings. What stays out is anything
 * that changes without changing the picture — `meta`, and the record's own
 * bookkeeping — because a hash that moves when the image does not is a hash
 * that re-renders the whole document every time somebody's cursor moves.
 */

/** FNV-1a, 32-bit. Not a security hash: this only has to notice a difference. */
function fold(hash: number, text: string): number {
  let value = hash;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function describe(shape: TLShape): string {
  // `props` carries the pen path, the text, the image's asset id — everything
  // that decides what the page looks like. `index` is in because reordering
  // two overlapping shapes changes the picture without changing either one.
  return `${shape.id}|${shape.type}|${shape.x}|${shape.y}|${shape.rotation}|${shape.opacity}|${shape.index}|${JSON.stringify(shape.props)}`;
}

/**
 * A hash of everything drawn on one page, including the asset bytes' identity.
 *
 * Assets are folded in by src rather than by id: an image whose asset record
 * exists but whose `src` has not resolved yet must not hash the same as the
 * one that has, or the first blank render of an imported PDF page would be
 * cached and then believed.
 */
export function hashPageContent(
  editor: Editor,
  pageId: TLShapeId,
  memberShapeIds: readonly TLShapeId[],
): string {
  let hash = 0x811c9dc5;

  const frame = editor.getShape(pageId);
  if (frame) hash = fold(hash, describe(frame));

  // Sorted so two clients that learned about the same shapes in a different
  // order still agree, and so a hash is stable across a reload.
  const ids = [...memberShapeIds].sort();
  for (const id of ids) {
    const shape = editor.getShape(id);
    if (!shape) continue;
    hash = fold(hash, describe(shape));

    const assetId = (shape.props as { assetId?: string | null }).assetId;
    if (!assetId) continue;
    const asset = editor.getAsset(assetId as TLAssetId);
    const src = (asset?.props as { src?: string | null } | undefined)?.src;
    hash = fold(hash, `asset:${assetId}:${src ?? "pending"}`);
  }

  return hash.toString(36);
}

/**
 * A stable cache key for a board, from the sync URL it was opened with.
 *
 * The URL carries a token in its query string on some deployments, and a token
 * rotates — keying on the raw string would give the same board a new cache
 * every session, which is the same as having no cache at all.
 */
export function boardCacheKey(
  whiteboardUrl: string | undefined,
  documentId?: string,
): string {
  if (!whiteboardUrl || !documentId) return "";
  try {
    const url = new URL(whiteboardUrl, "https://whiteboard.invalid");
    return `${url.host}${url.pathname}#${documentId}`;
  } catch {
    return `${whiteboardUrl.split("?")[0] ?? ""}#${documentId}`;
  }
}
