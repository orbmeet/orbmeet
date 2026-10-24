// R2 keys for stored whiteboard snapshots, shared by the two services that
// touch them: the sync server writes captures, revisions and restore points,
// and the app Worker names them. A board's live state is the room's SQLite
// file on the node that holds it, saved to R2 as it changes
// (`whiteboardRoomCopyKey`), so any node can take it over. The web's `platform/storage`
// layer re-exports these so the D1 CHECK constraints and bucket lifecycle
// rules keep one source.

/** Ids must not introduce path structure or wildcards into a key. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function segment(value: string, label: string): string {
  if (value === "." || value === ".." || !SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid R2 key segment for ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function isSafeKeySegment(value: string): boolean {
  return value !== "." && value !== ".." && SAFE_SEGMENT.test(value);
}

/** Every object a whiteboard owns: assets and immutable revisions. */
export function whiteboardPrefix(whiteboardId: string): string {
  return `whiteboards/${segment(whiteboardId, "whiteboardId")}/`;
}

export function whiteboardRevisionsPrefix(whiteboardId: string): string {
  return `${whiteboardPrefix(whiteboardId)}revisions/`;
}

export function whiteboardRevisionKey(whiteboardId: string, revisionId: string): string {
  return `${whiteboardRevisionsPrefix(whiteboardId)}${segment(revisionId, "revisionId")}.json`;
}

/** Every saved copy of one room's database. */
export function whiteboardRoomCopiesPrefix(whiteboardRoomId: string): string {
  return `internal/whiteboard-rooms/${segment(whiteboardRoomId, "whiteboardRoomId")}/`;
}

/**
 * The room's database as the node holding `generation` last saved it,
 * gzipped. Each generation writes only its own key, so a node the board has
 * moved on from can never overwrite a newer copy.
 */
export function whiteboardRoomCopyKey(whiteboardRoomId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`invalid room copy generation: ${generation}`);
  }
  return `${whiteboardRoomCopiesPrefix(whiteboardRoomId)}${generation}.db.gz`;
}

/** The generation a room copy key was saved under, or null for any other key. */
export function generationOfRoomCopyKey(whiteboardRoomId: string, key: string): number | null {
  const prefix = whiteboardRoomCopiesPrefix(whiteboardRoomId);
  if (!key.startsWith(prefix)) return null;
  const match = /^(0|[1-9][0-9]{0,15})\.db\.gz$/.exec(key.slice(prefix.length));
  const generation = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(generation) ? generation : null;
}

/** A Whiteboard's last shared state, pinned while a Meeting shows it. */
export function internalMeetingWhiteboardCaptureKey(
  meetingId: string,
  whiteboardId: string,
  captureId: string,
): string {
  return `internal/meetings/${segment(meetingId, "meetingId")}/canvases/${segment(whiteboardId, "whiteboardId")}/${segment(captureId, "captureId")}.json`;
}

/** Whether `key` names one revision object of `whiteboardId`. */
export function isWhiteboardRevisionKey(whiteboardId: string, key: string): boolean {
  if (!isSafeKeySegment(whiteboardId)) return false;
  const prefix = whiteboardRevisionsPrefix(whiteboardId);
  if (!key.startsWith(prefix) || !key.endsWith(".json")) return false;
  return isSafeKeySegment(key.slice(prefix.length, -".json".length));
}

/**
 * The whiteboard a stored snapshot key belongs to: a revision, or a Meeting's
 * pinned capture.
 */
export function whiteboardIdOfDocumentKey(key: string): string | null {
  const revision = /^whiteboards\/([A-Za-z0-9._-]+)\/revisions\/([A-Za-z0-9._-]+)\.json$/.exec(key);
  if (revision && isSafeKeySegment(revision[1]) && isSafeKeySegment(revision[2])) return revision[1];
  const capture = /^internal\/meetings\/([A-Za-z0-9._-]+)\/canvases\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.json$/.exec(key);
  if (capture && capture.slice(1).every(isSafeKeySegment)) return capture[2];
  return null;
}

/**
 * Custom metadata on a stored snapshot object. Lowercase because the S3 API
 * (which the sync server writes through) lowercases `x-amz-meta-*` names.
 * Metadata is advisory — the body carries its own clock and its hash can be
 * recomputed.
 */
export const SNAPSHOT_METADATA = {
  hash: "snapshot-hash",
  documentClock: "document-clock",
} as const;

export function readSnapshotMetadata(
  metadata: Record<string, string> | undefined,
): { hash: string | null; documentClock: number | null } {
  if (!metadata) return { hash: null, documentClock: null };
  // Case-folded: the R2 binding returns names verbatim, the S3 API lowercased.
  const folded = new Map(Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]));
  const hash = folded.get(SNAPSHOT_METADATA.hash) ?? null;
  const clockText = folded.get(SNAPSHOT_METADATA.documentClock);
  const clock = clockText ? Number(clockText) : Number.NaN;
  return {
    hash: hash && /^[a-f0-9]{32}$/.test(hash) ? hash : null,
    documentClock: Number.isSafeInteger(clock) && clock >= 0 ? clock : null,
  };
}
