const WHITEBOARD_ASSET_API_PREFIX = "/api/wb-assets/";
// Deployed objects keep the historical namespace. Whiteboard is the domain name;
// changing this prefix would orphan existing R2 objects.
const WHITEBOARD_DOCUMENT_PREFIX = "whiteboards";

export function buildWhiteboardAssetApiPath(r2Key: string): string {
  const normalizedKey = r2Key.replace(/^\/+/, "");
  return `${WHITEBOARD_ASSET_API_PREFIX}${normalizedKey}`;
}

/**
 * Anything a browser would resolve against another origin. Leading C0 bytes are
 * stripped first because a browser strips them too, so `"\n//evil.test/x"` is a
 * protocol-relative URL no matter how the string is spelled.
 */
function namesAnotherOrigin(src: string): boolean {
  const candidate = src.replace(/^[\u0000-\u0020]+/, "");
  return (
    // Any scheme: `https:`, `data:`, `javascript:`, or one invented later.
    /^[a-z][a-z0-9+.-]*:/i.test(candidate)
    // Protocol-relative, including the backslash form browsers also accept.
    || candidate.startsWith("//")
    || candidate.startsWith("\\\\")
    || candidate.startsWith("/\\\\")
  );
}

function hasUnsafeAssetPath(path: string): boolean {
  let candidate = path;
  for (let pass = 0; pass < 2; pass += 1) {
    if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return true;
    if (candidate.split("/").some((segment) => segment === "." || segment === "..")) {
      return true;
    }
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return candidate.split("/").some((segment) => segment === "." || segment === "..");
}

export function buildWhiteboardAssetViewerUrl(
  src: string,
  whiteboardId?: string | null,
): string {
  if (src.startsWith("blob:") || src.startsWith("data:image/")) {
    return src;
  }
  // Old snapshots predate the sync-side source policy. Never let a persisted,
  // peer-controlled source become a credentialed browser fetch. The check used
  // to name only `http://`, `https://` and `data:`, so `//example.invalid/pixel`
  // took the same-origin path branch below and came back unchanged — a
  // protocol-relative URL the browser resolves against another host.
  if (namesAnotherOrigin(src)) {
    return "";
  }
  const sourcePath = src.split(/[?#]/, 1)[0];
  if (!sourcePath || hasUnsafeAssetPath(sourcePath)) return "";

  const assetUrl = src.startsWith("/") ? src : buildWhiteboardAssetApiPath(src);
  if (!whiteboardId || !assetUrl.startsWith(WHITEBOARD_ASSET_API_PREFIX)) {
    return assetUrl;
  }
  const separator = assetUrl.includes("?") ? "&" : "?";
  return `${assetUrl}${separator}whiteboardId=${encodeURIComponent(whiteboardId)}`;
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

export function extractWhiteboardAssetKeyFromViewerUrl(src: string): string | null {
  let rawPath = "";

  if (src.startsWith(WHITEBOARD_ASSET_API_PREFIX)) {
    rawPath = src.split(/[?#]/, 1)[0];
  } else if (src.startsWith("http://") || src.startsWith("https://")) {
    try {
      const url = new URL(src);
      const authorityEnd = src.indexOf("/", src.indexOf("//") + 2);
      rawPath = authorityEnd === -1
        ? "/"
        : src.slice(authorityEnd).split(/[?#]/, 1)[0];
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!rawPath.startsWith(WHITEBOARD_ASSET_API_PREFIX)) return null;
  const encodedKey = rawPath.slice(WHITEBOARD_ASSET_API_PREFIX.length);
  if (!encodedKey || hasUnsafeAssetPath(encodedKey)) return null;

  try {
    const key = decodeURIComponent(encodedKey);
    if (!key || hasUnsafeAssetPath(key)) return null;
    return key;
  } catch {
    return null;
  }
}
