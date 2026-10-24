import { extractWhiteboardDocumentAssetIdentity } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { isSafeExternalBrowserUrl } from "@orbmeet/whiteboard-core/public-host";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { isRecord } from "@orbmeet/primitives";
import type { TLRecord } from "@tldraw/tlschema";

/**
 * What a record a client writes may hold, judged on the whole record as it
 * will be stored: tldraw applies a patch and migrates the result before the
 * room's authorizers (room-record-authorizers.ts) see it, so none of this
 * reasons about how a client encoded the change. What a record's own schema
 * bounds (a page frame's size and name, for one) the schema enforces as it
 * stores the record; these are the rules no schema expresses.
 */

const WHITEBOARD_PAGE_SHAPE_TYPE = "whiteboard-page";
const WHITEBOARD_ASSET_API_PREFIX = "/api/wb-assets/";

export function isPageFrameRecord(value: unknown): boolean {
  return isRecord(value) && value.typeName === "shape" && value.type === WHITEBOARD_PAGE_SHAPE_TYPE;
}

/**
 * Whether any `url` in the record, at any depth, is one participants'
 * browsers must not load. tldraw renders a url directly (`EmbedShapeUtil` as
 * an auto-loading iframe, image and video as a link), so this holds on every
 * record type, not only the bookmark shape the product creates them from: a
 * hand-built `embed` record could otherwise point every participant's page at
 * an internal address. Empty is allowed: tldraw seeds url-bearing shapes with
 * `""` and fills them in later, and an empty url loads nothing.
 */
export function hasUnsafeUrl(value: unknown, key?: string): boolean {
  if (key === "url") return value !== "" && !isSafeExternalBrowserUrl(value);
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeUrl(entry));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => hasUnsafeUrl(child, childKey));
}

/** A media source in this board's own storage, as the upload API names it. */
function isTrustedWhiteboardMediaSrc(value: unknown, documentId: string | undefined): boolean {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  const source = value.startsWith(WHITEBOARD_ASSET_API_PREFIX)
    ? value.slice(WHITEBOARD_ASSET_API_PREFIX.length)
    : value;
  try {
    const decodedSource = decodeURIComponent(source);
    if (decodedSource.includes("..") || decodedSource.includes("\\")) return false;
    const documentAsset = extractWhiteboardDocumentAssetIdentity(decodedSource);
    return documentAsset !== null && documentId !== undefined && documentAsset.whiteboardId === documentId;
  } catch {
    return false;
  }
}

function isEmptySource(value: unknown): boolean {
  return value === null || value === "";
}

/** A bookmark's preview fields are fetched by every participant's browser. */
function isSafeOptionalUrl(value: unknown): boolean {
  return value === undefined || value === "" || isSafeExternalBrowserUrl(value);
}

/**
 * Bookmark text comes from a third-party page (through the unfurler, which
 * clamps its own output); this bounds a record the unfurler did not produce.
 * tldraw's bookmark schema defaults both to "", so absent is fine.
 */
function isBoundedText(value: unknown, limit: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= limit);
}

/**
 * Whether an asset record only makes participants load what they may: media
 * from this board's own storage, and bookmarks to public hosts. tldraw's
 * image and video schemas allow a null source while an upload is unresolved;
 * it loads nothing, and the source it later gets is judged then.
 */
export function isAllowedAsset(record: { type?: unknown; props?: unknown }, documentId: string | undefined): boolean {
  const props = isRecord(record.props) ? record.props : {};
  if (record.type === "bookmark") {
    return (isEmptySource(props.src) || isSafeExternalBrowserUrl(props.src))
      && isSafeOptionalUrl(props.image)
      && isSafeOptionalUrl(props.favicon)
      && isBoundedText(props.title, WHITEBOARD_CONFIG.MAX_BOOKMARK_TITLE_LENGTH)
      && isBoundedText(props.description, WHITEBOARD_CONFIG.MAX_BOOKMARK_DESCRIPTION_LENGTH);
  }
  return props.src === undefined || isEmptySource(props.src) || isTrustedWhiteboardMediaSrc(props.src, documentId);
}

function sourceKind(value: unknown, documentId: string | undefined): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (value === "") return "empty";
  if (typeof value !== "string") return `non-string:${typeof value}`;
  if (isTrustedWhiteboardMediaSrc(value, documentId)) return "whiteboard-storage";
  if (value.startsWith("data:")) return "data-url";
  if (value.startsWith("blob:")) return "blob-url";
  if (value.startsWith("http://") || value.startsWith("https://")) return "external-http";
  if (value.startsWith(WHITEBOARD_ASSET_API_PREFIX)) return "invalid-whiteboard-path";
  return "other-string";
}

/**
 * What kinds of source an asset carries, for a log line: categories only,
 * never the URLs, filenames or query strings themselves.
 */
export function describeAssetSources(record: { props?: unknown }, documentId: string | undefined): string {
  const props = isRecord(record.props) ? record.props : {};
  return (["src", "image", "favicon"] as const)
    .filter((key) => key in props)
    .map((key) => `${key}:${sourceKind(props[key], documentId)}`)
    .join(",") || "none";
}

/**
 * Hold a record the room writes itself to the schema a client's is held to.
 *
 * tldraw validates what a client pushes, but a host's own storage writes go
 * straight in. One the schema refuses would be sent to every client, each of
 * which fails to apply it and reconnects, to be sent it again: the board stays
 * unusable for everyone until the record is repaired by hand. Refusing it here
 * throws inside the write's transaction, which then stores nothing.
 */
export function assertValidRoomRecord(record: TLRecord): void {
  const recordType = (whiteboardTLSchema.types as Record<string, { scope: string; validate(record: unknown): unknown }>)[
    record.typeName
  ];
  if (!recordType || recordType.scope !== "document") {
    throw new Error(`The room may not write a ${record.typeName} record`);
  }
  recordType.validate(record);
}

/** Whether the schema accepts `record`, for a write that may leave a refused record untouched. */
export function isValidRoomRecord(record: TLRecord): boolean {
  try {
    assertValidRoomRecord(record);
    return true;
  } catch {
    return false;
  }
}
