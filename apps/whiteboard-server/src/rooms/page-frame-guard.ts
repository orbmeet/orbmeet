import { isRecord } from "@orbmeet/primitives";
import { isDocumentRecordId } from "@orbmeet/whiteboard-core/room-snapshot-validation";
import { isPageFrameRecord } from "./record-rules.ts";
export { JsonMessageAssembler } from "@orbmeet/whiteboard-core/chunked-json";

/**
 * What the room checks of a client push before tldraw applies it: only what
 * tldraw cannot judge record by record. Each record a push writes is judged
 * whole, after it is applied, by the room's authorizers
 * (room-record-authorizers.ts); this is the message around them.
 */

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Whether a value carries a prototype-polluting key (`__proto__`,
 * `constructor`, `prototype`) anywhere within it. sync-core applies a patch
 * with `applyObjectDiff`, whose `newObject[key] = value` sets a record's
 * prototype from a `__proto__` key before any authorizer sees the result, and
 * its validator accepts the key inside a put record's free-form JSON (`meta`)
 * (both pinned in tldraw-contract.test.ts). So it is checked on the message
 * itself.
 * `Object.entries` sees a JSON-parsed `__proto__` because it is an own
 * enumerable property, not the real prototype.
 */
export function hasUnsafeObjectKeyDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeObjectKeyDeep);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key) || hasUnsafeObjectKeyDeep(child)) return true;
  }
  return false;
}

export function getPageFrameIdsFromSnapshot(snapshot: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(snapshot) || !Array.isArray(snapshot.documents)) return ids;

  for (const document of snapshot.documents) {
    if (!isRecord(document)) continue;
    const state = document.state;
    if (!isPageFrameRecord(state) || !isRecord(state)) continue;
    if (typeof state.id === "string") ids.add(state.id);
  }

  return ids;
}

export type IncomingDiffVerdict =
  // Touches no page frame.
  | "allow"
  // Creates, changes, replaces or removes a page frame: the room's page index
  // is refreshed once it lands. Who may do so is the authorizers' to decide.
  | "page-frames"
  // Not a message our client produces: an op that is not a `[kind, payload]`
  // tuple of put, patch or remove with an object to put or patch, or a
  // prototype-polluting key anywhere.
  | "forbidden"
  // A record id the snapshot validator would refuse, or a put stored under a
  // key other than its record's own id (sync-core stores a put under its key
  // as sent). Stored, it would fail every later capture and restore.
  | "invalid-record-id"
  // The board would have more page frames than the server allows.
  | "page-limit-exceeded"
  // The board would be left without a page. Each client refuses to delete its
  // last page, but two managers can each delete a different page of a
  // two-page board before seeing the other's change.
  | "last-page";

/**
 * How a client push can move the room's serialized size.
 *
 * `may-shrink` exists because tldraw builds one diff per push out of
 * added + updated + removed (see getNetworkDiff in @tldraw/sync-core), so a
 * delete that also touches another record — an arrow rebinding, a group
 * dissolving, a binding going away — arrives as `remove` alongside `patch`.
 * Such a push is not purely additive, so its wire size is not a bound on the
 * growth it causes, and the room-size gate must not judge it as if it were.
 */
export type IncomingDiffSizeEffect =
  | "no-mutation"
  | "remove-only"
  | "may-shrink"
  | "may-grow";

export function classifyIncomingDiffSizeEffect(message: unknown): IncomingDiffSizeEffect {
  if (!isRecord(message) || message.type !== "push" || !isRecord(message.diff)) {
    return "no-mutation";
  }

  const operations = Object.values(message.diff);
  if (operations.length === 0) return "no-mutation";

  let removeCount = 0;
  for (const operation of operations) {
    if (Array.isArray(operation) && operation[0] === "remove") removeCount += 1;
  }

  if (removeCount === 0) return "may-grow";
  return removeCount === operations.length ? "remove-only" : "may-shrink";
}

/**
 * Judge a client `push` against the room's page-frame ids. A push's effect on
 * how many pages a board has is a property of the whole push, so it is judged
 * here rather than record by record. An ordinary shape edit costs a Set lookup;
 * the caller refreshes the ids after a page-frame push lands.
 */
export function classifyIncomingDiff(
  message: unknown,
  pageFrameIds: ReadonlySet<string>,
  maxPageFrames = Number.POSITIVE_INFINITY,
): IncomingDiffVerdict {
  if (!isRecord(message) || message.type !== "push") return "allow";
  const diff = message.diff;
  if (!isRecord(diff)) return "allow";
  if (hasUnsafeObjectKeyDeep(diff)) return "forbidden";

  let touchesPageFrames = false;
  const projectedPageFrameIds = new Set(pageFrameIds);
  for (const [id, op] of Object.entries(diff)) {
    if (!Array.isArray(op)) return "forbidden";
    const [kind, payload] = op as [unknown, unknown];
    if (kind !== "put" && kind !== "patch" && kind !== "remove") return "forbidden";
    if (kind !== "remove" && !isRecord(payload)) return "forbidden";
    if (!isDocumentRecordId(id) || (kind === "put" && (payload as { id?: unknown }).id !== id)) {
      return "invalid-record-id";
    }
    // A put can create a page or replace one with another shape. A patch can
    // only edit one, never make one: a shape's type does not change in place.
    if (kind === "put" && isPageFrameRecord(payload)) {
      touchesPageFrames = true;
      projectedPageFrameIds.add(id);
    } else if (pageFrameIds.has(id)) {
      touchesPageFrames = true;
      if (kind !== "patch") projectedPageFrameIds.delete(id);
    }
  }

  if (!touchesPageFrames) return "allow";
  if (projectedPageFrameIds.size > maxPageFrames) return "page-limit-exceeded";
  if (pageFrameIds.size > 0 && projectedPageFrameIds.size === 0) return "last-page";
  return "page-frames";
}
