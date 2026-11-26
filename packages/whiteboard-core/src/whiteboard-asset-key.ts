export const WHITEBOARD_ASSET_API_PREFIX = "/api/wb-assets/";
// Deployed objects keep the historical namespace. Whiteboard is the domain name;
// changing this prefix would orphan existing R2 objects.
const WHITEBOARD_DOCUMENT_PREFIX = "whiteboards";

export function buildWhiteboardAssetApiPath(r2Key: string): string {
  const normalizedKey = r2Key.replace(/^\/+/, "");
  return `${WHITEBOARD_ASSET_API_PREFIX}${normalizedKey}`;
}

/**
 * The URL a viewer loads an asset record's `src` from: the canvas's own local
 * sources as they are, and an object in the board's storage through the asset
 * API. Anything else loads nothing: a persisted source is peer-controlled, and
 * must never become a credentialed fetch of whatever it names, on this origin
 * or another.
 */
export function buildWhiteboardAssetViewerUrl(
  src: string,
  whiteboardId?: string | null,
): string {
  if (src.startsWith("blob:") || src.startsWith("data:image/")) {
    return src;
  }
  const key = whiteboardAssetKeyOfSrc(src);
  if (!key) return "";
  const assetUrl = buildWhiteboardAssetApiPath(key);
  return whiteboardId ? `${assetUrl}?whiteboardId=${encodeURIComponent(whiteboardId)}` : assetUrl;
}

export function whiteboardDocumentAssetPrefix(whiteboardId: string): string {
  return `${WHITEBOARD_DOCUMENT_PREFIX}/${whiteboardId}/assets/`;
}

/**
 * One path segment: no separators, no traversal, no empty string.
 *
 * The key builders below concatenate their arguments into an R2 key that then
 * decides which board's prefix an object lands under. A `/` or a `..` in any of
 * them silently rewrites that decision, so an id that cannot be a segment is a
 * programming error worth failing on rather than a key worth writing.
 */
function isAssetKeySegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function assertAssetKeySegment(name: string, value: string): string {
  if (!isAssetKeySegment(value)) {
    throw new Error(`Invalid whiteboard asset key ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function buildWhiteboardDocumentAssetKey(
  whiteboardId: string,
  assetId: string,
  extension: string,
): string {
  assertAssetKeySegment("whiteboardId", whiteboardId);
  assertAssetKeySegment("assetId", assetId);
  assertAssetKeySegment("extension", extension);
  return `${whiteboardDocumentAssetPrefix(whiteboardId)}${assetId}.${extension}`;
}

/**
 * The single owner of where one PDF import's page objects live: the grant
 * names it as the import's `uploadPrefix`, the sync server appends each page's
 * file name, and the grant checks every key it is handed against it.
 */
export function whiteboardPdfImportPrefix(
  whiteboardId: string,
  importId: string,
): string {
  assertAssetKeySegment("importId", importId);
  return `${whiteboardDocumentAssetPrefix(whiteboardId)}imports/${importId}/`;
}

export function buildWhiteboardPdfImportAssetKey(
  whiteboardId: string,
  importId: string,
  pageNumber: number,
): string {
  return `${whiteboardPdfImportPrefix(whiteboardId, importId)}page-${pageNumber}.png`;
}

export function extractWhiteboardDocumentAssetIdentity(
  key: string,
): { whiteboardId: string } | null {
  const match = key.match(/^whiteboards\/([^/]+)\/assets\/.+/);
  return match?.[1]
    ? { whiteboardId: match[1] }
    : null;
}

/**
 * The stored object an asset record's `src` names, or null when it names none
 * of a board's own: the one reading of a `src`. The sync server admits a
 * source by it, a revision pins and authorizes the objects it returns, and the
 * viewer loads what it returns, so the three cannot disagree about which
 * object a source is.
 *
 * Only the forms the app writes name an object: the asset API path followed
 * by the key, as `buildWhiteboardAssetApiPath` writes it, or the bare key.
 * Every segment of the key is a plain segment, so a query, a fragment, a
 * percent-encoding or a traversal never names one.
 */
export function whiteboardAssetKeyOfSrc(src: string): string | null {
  const key = src.startsWith(WHITEBOARD_ASSET_API_PREFIX) ? src.slice(WHITEBOARD_ASSET_API_PREFIX.length) : src;
  const segments = key.split("/");
  return segments.length >= 4
    && segments[0] === WHITEBOARD_DOCUMENT_PREFIX
    && segments[2] === "assets"
    && segments.every((segment, index) => index === 0 || index === 2 || isAssetKeySegment(segment))
    ? key
    : null;
}
