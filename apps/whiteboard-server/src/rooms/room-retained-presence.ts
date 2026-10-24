import type { TLRecord } from "@tldraw/tlschema";
import { TLSocketRoom } from "@tldraw/sync-core";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import type { RateLimiter } from "../lib/rate-limiter.ts";
import type { SessionMeta } from "./room-types.ts";
import { logWarn } from "../lib/log.ts";

// How often the room-total retained-presence check may serialize the whole
// presence store. Per-session enforcement already measures exactly one record
// per forwarded presence message (cheaper than the fanout broadcast the room
// performs for the same message); the full sweep is the extra defense.
const RETAINED_PRESENCE_SWEEP_INTERVAL_MS = 1_000;
// Ceiling on how often a retained-presence eviction may log. The client behind
// an eviction republishes on reconnect, so a pathological client could evict
// itself in a loop; the condition stays visible without becoming a log flood.
const RETAINED_PRESENCE_LOG_INTERVAL_MS = 10_000;
const MAX_RETAINED_PRESENCE_BYTES = WHITEBOARD_CONFIG.MAX_RETAINED_PRESENCE_BYTES;
const MAX_TOTAL_RETAINED_PRESENCE_BYTES = WHITEBOARD_CONFIG.MAX_TOTAL_RETAINED_PRESENCE_BYTES;

// `getPresenceRecords` is @internal in sync-core and omitted from its published
// types. This guard is the only bound on presence a session retains, so a
// sync-core without it must stop the server rather than run unbounded.
type PresenceRecordsMethod = (
  this: TLSocketRoom<TLRecord, SessionMeta>,
) => Record<string, Record<string, unknown>>;

const getPresenceRecords: PresenceRecordsMethod = (() => {
  const method = (TLSocketRoom.prototype as { getPresenceRecords?: unknown }).getPresenceRecords;
  if (typeof method !== "function") {
    throw new Error(
      "@tldraw/sync-core no longer provides TLSocketRoom.getPresenceRecords; retained presence cannot be bounded",
    );
  }
  return method as PresenceRecordsMethod;
})();

interface RetainedPresenceHost {
  whiteboardRoomId: WhiteboardRoomId;
  room: TLSocketRoom<TLRecord, SessionMeta>;
  presenceRateLimiter: RateLimiter;
  presenceRoomRateLimiter: RateLimiter;
  getUserId: (tldrawSessionId: string) => string | undefined;
  liveConnectionCount: () => number;
  closeSessionTransiently: (tldrawSessionId: string) => void;
}

/**
 * Bounds the presence each session RETAINS in sync-core's store (as opposed to
 * what a single message carries, which RoomMessageGuard bounds). Owned by the
 * Room; consulted after every accepted presence-bearing push.
 */
export class RoomRetainedPresenceGuard {
  private lastLogAt = 0;
  private lastSweepAt = 0;

  private readonly host: RetainedPresenceHost;

  constructor(host: RetainedPresenceHost) {
    this.host = host;
  }

  presenceRecordsOf(): Record<string, Record<string, unknown>> {
    return getPresenceRecords.call(this.host.room);
  }

  /** UTF-8 size of one session's retained presence record, measured exactly. */
  private measureRetainedPresenceBytes(tldrawSessionId: string): number | null {
    // The session→presence-id mapping only exists for Connected sessions; a
    // session still awaiting its connect reply cannot have merged presence
    // into the store, so there is nothing retained to bound.
    const presenceId = this.host.room.getSessionSnapshot(tldrawSessionId)?.presenceId;
    if (!presenceId) return null;
    const record = this.presenceRecordsOf()[presenceId];
    if (!record) return null;
    try {
      return Buffer.byteLength(JSON.stringify(record), "utf8");
    } catch {
      // An unserializable record is over any ceiling by definition.
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /**
   * Bound the presence a session RETAINS, not just what one message carries.
   *
   * MAX_PRESENCE_MESSAGE_BYTES bounds a single operation, but every accepted
   * patch merges into the per-session presence record that sync-core keeps
   * until the session closes, and nothing measured the result: forty in-cap
   * patches (an ever-growing `meta` object, `selectedShapeIds` append ops)
   * left ~120 KiB retained, fanned out to every peer on every later change.
   * The ceiling therefore lives on the merged record, measured after the
   * forwarded push commits — one exact JSON size per presence-bearing message,
   * still cheaper than the per-recipient fanout broadcast the same message
   * just performed. Measuring retained state (rather than write permission) is
   * also what keeps read-only participants covered.
   *
   * On breach the session's presence is evicted via the transient close, the
   * same mechanism a session close uses, because sync-core exposes no direct
   * presence-removal hook: the removal propagates to every client exactly as
   * it does at session close, and the client republishes fresh (small) state
   * on reconnect — the existing recovery semantic. The room-total ceiling is
   * the second net underneath it, amortized to one full sweep per second.
   */
  enforceCeilings(tldrawSessionId: string, userId: string): void {
    const retainedBytes = this.measureRetainedPresenceBytes(tldrawSessionId);
    if (retainedBytes !== null && retainedBytes > MAX_RETAINED_PRESENCE_BYTES) {
      this.evictRetainedPresence(
        tldrawSessionId,
        userId,
        retainedBytes,
        `kept more than the ${MAX_RETAINED_PRESENCE_BYTES}-byte retained presence ceiling`,
      );
      return;
    }
    const now = Date.now();
    if (now - this.lastSweepAt < RETAINED_PRESENCE_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;

    // One pass, one serialization per record. The total and the largest
    // contributor both come out of the same walk: measuring the sum and then
    // re-deriving the maximum through `measureRetainedPresenceBytes` per
    // session stringified every record in the room a second time, on the
    // message path, to recompute sizes this loop had just discarded.
    const sessionIdByPresenceId = new Map<string, string>();
    for (const { sessionId } of this.host.room.getSessions()) {
      const presenceId = this.host.room.getSessionSnapshot(sessionId)?.presenceId;
      if (presenceId) sessionIdByPresenceId.set(presenceId, sessionId);
    }
    const presenceRecords = this.presenceRecordsOf();
    let totalBytes = 0;
    let largestSessionId: string | null = null;
    let largestBytes = 0;
    for (const [presenceId, record] of Object.entries(presenceRecords)) {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      } catch {
        // An unserializable record is over any ceiling by definition, and the
        // half-max keeps the running total from overflowing on several of them.
        bytes = Number.MAX_SAFE_INTEGER / 2;
      }
      totalBytes += bytes;
      // Only a record belonging to a live session can be evicted; one left by a
      // session already gone still counts toward the total but is nobody's to
      // charge.
      const sessionId = sessionIdByPresenceId.get(presenceId);
      if (sessionId && bytes > largestBytes) {
        largestBytes = bytes;
        largestSessionId = sessionId;
      }
    }
    if (totalBytes <= MAX_TOTAL_RETAINED_PRESENCE_BYTES) return;

    // The room as a whole is over budget. Evict the session holding the
    // largest retained record — the biggest contributor is the one whose
    // presence is furthest from anything a legitimate client republished.
    if (largestSessionId === null) return;
    this.evictRetainedPresence(
      largestSessionId,
      this.host.getUserId(largestSessionId) ?? largestSessionId,
      largestBytes,
      `kept more than its share of the ${MAX_TOTAL_RETAINED_PRESENCE_BYTES}-byte room retained presence budget`,
    );
  }

  /**
   * Evict one session's retained presence: charge the removal fanout we are
   * about to emit (the forwarded patch was already billed separately, so this
   * is the only new bytes), log once per window, then transiently close — the
   * close is what deletes the record and broadcasts its removal to every peer.
   */
  private evictRetainedPresence(
    tldrawSessionId: string,
    userId: string,
    retainedBytes: number,
    cause: string,
  ): void {
    const recipientCount = Math.max(0, this.host.liveConnectionCount() - 1);
    const removalFanoutBytes = (tldrawSessionId.length + 64) * recipientCount;
    const userReservation = this.host.presenceRateLimiter.reserve(userId, removalFanoutBytes);
    const roomReservation = this.host.presenceRoomRateLimiter.reserve("room", removalFanoutBytes);
    // Evict regardless of the budget answer: the ceiling is a safety bound,
    // and the removal patch is going out either way.
    userReservation?.commit();
    roomReservation?.commit();

    const now = Date.now();
    if (now - this.lastLogAt >= RETAINED_PRESENCE_LOG_INTERVAL_MS) {
      this.lastLogAt = now;
      logWarn(
        `[Room ${this.host.whiteboardRoomId}] Evicting presence of ${userId} (${tldrawSessionId}): retained ${retainedBytes} bytes, ${cause}`,
      );
    }
    this.host.closeSessionTransiently(tldrawSessionId);
  }
}
