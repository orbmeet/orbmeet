import { DEFAULT_INITIAL_SNAPSHOT, type RoomSnapshot } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { ROOM_NAVIGATION_TYPE } from "./room-navigation.ts";
import { whiteboardTLSchema } from "./room-schema.ts";
import { WHITEBOARD_CONFIG } from "./config.ts";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "./page-shape-schema.ts";
import { isRecord } from "@orbmeet/primitives";

export type WhiteboardSnapshotValidationResult =
  | { ok: true; snapshot: RoomSnapshot }
  | { ok: false; error: string };

export function createEmptyWhiteboardRoomSnapshot(): RoomSnapshot {
  return {
    ...structuredClone(DEFAULT_INITIAL_SNAPSHOT),
    schema: whiteboardTLSchema.serialize(),
  };
}

function isClock(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const MAX_SNAPSHOT_TOMBSTONES = 100_000;
const MAX_TLDRAW_RECORD_ID_LENGTH = 512;

/**
 * The one predicate for "what is a legal document record id", shared by every
 * boundary that names one: the persistence validator (tombstones, below) and
 * the sync service's live admission guard. Enforcing the same predicate at both
 * ends is what keeps a record the room accepts live from becoming a snapshot
 * the room's own validator then refuses — a divergence that would poison a
 * board's snapshot pipeline end-to-end.
 */
export function isDocumentRecordId(value: string): boolean {
  if (!value || value.length > MAX_TLDRAW_RECORD_ID_LENGTH) return false;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const typeName = value.slice(0, separator);
  const recordType = (whiteboardTLSchema.types as Record<
    string,
    { scope: "document" | "session" | "presence" }
  >)[typeName];
  return recordType?.scope === "document";
}

/** Validate a persisted sync snapshot before it becomes restorable authority. */
export function validateWhiteboardRoomSnapshot(
  value: unknown,
): WhiteboardSnapshotValidationResult {
  try {
    if (!isRecord(value) || !Array.isArray(value.documents)) {
      return { ok: false, error: "Snapshot must contain a documents array" };
    }
    if (!isRecord(value.schema)) {
      return { ok: false, error: "Snapshot schema is missing" };
    }
    if (
      value.documentClock !== undefined && !isClock(value.documentClock) ||
      value.clock !== undefined && !isClock(value.clock) ||
      value.tombstoneHistoryStartsAtClock !== undefined &&
        !isClock(value.tombstoneHistoryStartsAtClock)
    ) {
      return { ok: false, error: "Snapshot contains an invalid clock" };
    }
    if (value.tombstones !== undefined) {
      if (!isRecord(value.tombstones)) {
        return { ok: false, error: "Snapshot contains invalid tombstones" };
      }
      const tombstones = Object.entries(value.tombstones);
      if (
        tombstones.length > MAX_SNAPSHOT_TOMBSTONES
        || tombstones.some(([id, clock]) => !isDocumentRecordId(id) || !isClock(clock))
      ) {
        return { ok: false, error: "Snapshot contains invalid tombstones" };
      }
    }

    const store = Object.create(null) as Record<string, TLRecord>;
    const recordIds = new Set<string>();
    for (const document of value.documents) {
      if (!isRecord(document) || !isClock(document.lastChangedClock) || !isRecord(document.state)) {
        return { ok: false, error: "Snapshot contains an invalid document entry" };
      }
      const { id, typeName } = document.state;
      if (typeof id !== "string" || !id || typeof typeName !== "string" || !typeName) {
        return { ok: false, error: "Snapshot record identity is invalid" };
      }
      if (recordIds.has(id)) return { ok: false, error: `Snapshot contains duplicate record ${id}` };
      recordIds.add(id);
      store[id] = document.state as unknown as TLRecord;
    }

    const migrated = whiteboardTLSchema.migrateStoreSnapshot({
      schema: value.schema as RoomSnapshot["schema"] & object,
      store,
    });
    if (migrated.type !== "success") {
      return { ok: false, error: `Snapshot schema migration failed: ${migrated.reason}` };
    }

    let hasDocument = false;
    let hasPage = false;
    // The room's own page policy, restated here. Schema validation alone accepts
    // a document the live room would never have let a client build — hundreds of
    // native pages, each with a name far past what the page-frame guard allows —
    // and a restore is a way to install exactly that. The two limits have to
    // agree or a restored board is one no client can edit back into policy.
    let pageCount = 0;
    let pageFrameCount = 0;
    for (const record of Object.values(migrated.value)) {
      const recordType = whiteboardTLSchema.types[record.typeName];
      if (!recordType || recordType.scope !== "document") {
        return { ok: false, error: `Snapshot contains unsupported record type ${record.typeName}` };
      }
      recordType.validator.validate(record);
      hasDocument ||= record.typeName === "document";
      if (record.typeName === "page") {
        hasPage = true;
        pageCount += 1;
        const name = (record as { name?: unknown }).name;
        if (typeof name === "string" && name.length > WHITEBOARD_CONFIG.MAX_PAGE_NAME_LENGTH) {
          return { ok: false, error: "Snapshot contains an over-long page name" };
        }
      }
      if (
        record.typeName === "shape"
        && (record as { type?: unknown }).type === WHITEBOARD_PAGE_SHAPE_TYPE
      ) {
        pageFrameCount += 1;
        const frameName = ((record as { props?: { name?: unknown } }).props ?? {}).name;
        if (
          typeof frameName === "string"
          && frameName.length > WHITEBOARD_CONFIG.MAX_PAGE_NAME_LENGTH
        ) {
          return { ok: false, error: "Snapshot contains an over-long page name" };
        }
      }
    }
    if (!hasDocument || !hasPage) {
      return { ok: false, error: "Snapshot must contain a document and at least one page" };
    }
    if (
      pageCount > WHITEBOARD_CONFIG.MAX_PAGES
      || pageFrameCount > WHITEBOARD_CONFIG.MAX_PAGES
    ) {
      return {
        ok: false,
        error: `Snapshot exceeds the ${WHITEBOARD_CONFIG.MAX_PAGES}-page limit`,
      };
    }

    // A successful migration is the authoritative record set. Returning the
    // original payload after validating only the migrated copy lets callers
    // install stale record shapes while labelling them valid.
    const originalClocks = new Map(
      value.documents.map((document) => {
        const entry = document as { state: { id: string }; lastChangedClock: number };
        return [entry.state.id, entry.lastChangedClock] as const;
      }),
    );
    let fallbackClock = isClock(value.documentClock) ? value.documentClock : 0;
    if (!isClock(value.documentClock)) {
      for (const clock of originalClocks.values()) {
        if (clock > fallbackClock) fallbackClock = clock;
      }
    }
    const migratedRecords = Object.values(migrated.value);
    const inputOrder = new Map(
      value.documents.map((document, index) => [
        (document as { state: { id: string } }).state.id,
        index,
      ]),
    );
    migratedRecords.sort((left, right) =>
      (inputOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (inputOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );

    return {
      ok: true,
      snapshot: {
        schema: whiteboardTLSchema.serialize(),
        documents: migratedRecords.map((state) => ({
          state,
          lastChangedClock: originalClocks.get(state.id) ?? fallbackClock,
        })),
        ...(isClock(value.clock) ? { clock: value.clock } : {}),
        ...(isClock(value.documentClock) ? { documentClock: value.documentClock } : {}),
        ...(value.tombstones !== undefined
          ? { tombstones: Object.fromEntries(Object.entries(value.tombstones)) }
          : {}),
        ...(isClock(value.tombstoneHistoryStartsAtClock)
          ? { tombstoneHistoryStartsAtClock: value.tombstoneHistoryStartsAtClock }
          : {}),
      } as unknown as RoomSnapshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Snapshot validation failed",
    };
  }
}

export async function computeWhiteboardSnapshotHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("Unsupported canonical JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Hash only the document records, independent of sync clocks, schema metadata,
 * record ordering, and JSON key ordering. Restoring a Snapshot deliberately
 * advances its clocks, so the byte-level snapshot hash cannot recognize an
 * idempotent retry of content that is already live.
 *
 * The room's navigation is left out: it says where the presenter is, not
 * what the board holds, so a page turn is not a change of content.
 */
export async function computeWhiteboardDocumentContentHash(
  snapshot: unknown,
): Promise<string | null> {
  try {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.documents)) return null;
    let states: Record<string, unknown>[] = [];
    for (const document of snapshot.documents) {
      if (!isRecord(document) || !isRecord(document.state)) return null;
      states.push(document.state);
    }
    const recordIds = new Set<string>();
    for (const state of states) {
      if (typeof state.id !== "string" || recordIds.has(state.id)) return null;
      recordIds.add(state.id);
    }

  // Historical revisions may use an older schema. Hash their migrated records
  // when schema metadata is available so a successful restore compares equal
  // to the current-schema snapshot the room publishes on retry.
    if (isRecord(snapshot.schema)) {
      const store = Object.fromEntries(
        states.map((state) => [String(state.id), state]),
      ) as unknown as Record<string, TLRecord>;
      const migrated = whiteboardTLSchema.migrateStoreSnapshot({
        schema: snapshot.schema as RoomSnapshot["schema"] & object,
        store,
      });
      if (migrated.type !== "success") return null;
      states = Object.values(migrated.value) as unknown as Record<string, unknown>[];
    }

    states = states.filter((state) => state.typeName !== ROOM_NAVIGATION_TYPE);
    states.sort((left, right) => {
      const leftId = String(left.id);
      const rightId = String(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return computeWhiteboardSnapshotHash(canonicalJson(states));
  } catch {
    return null;
  }
}

export async function validateWhiteboardSnapshotBody(
  body: string,
  expectedHash?: string | null,
): Promise<WhiteboardSnapshotValidationResult & { hash?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "Snapshot is not valid JSON" };
  }
  const validation = validateWhiteboardRoomSnapshot(parsed);
  if (!validation.ok) return validation;
  const hash = await computeWhiteboardSnapshotHash(body);
  if (expectedHash !== undefined && expectedHash !== null && hash !== expectedHash) {
    return { ok: false, error: "Snapshot hash does not match its body" };
  }
  return { ...validation, hash };
}
