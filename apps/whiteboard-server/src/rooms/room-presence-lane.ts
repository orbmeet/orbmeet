import * as syncCore from "@tldraw/sync-core";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

/** A diff of one record, as sync-core applies it. */
type ObjectDiff = Record<string, unknown>;

/** A presence operation as a client pushes it: its whole record, or a diff against the last it pushed. */
export type PresenceOp = ["put", Record<string, unknown>] | ["patch", ObjectDiff];

// `applyObjectDiff` is @internal in sync-core and left out of its published
// types. The lane must apply a patch exactly as the room applies it, or what
// it forwards whole would not be what the client believes it sent, so it uses
// sync-core's own; a sync-core without it must stop the server rather than
// guess.
const applyObjectDiff = (() => {
  const method = (syncCore as { applyObjectDiff?: unknown }).applyObjectDiff;
  if (typeof method !== "function") {
    throw new Error("@tldraw/sync-core no longer provides applyObjectDiff; presence cannot be kept in step");
  }
  return method as (object: Record<string, unknown>, diff: ObjectDiff) => Record<string, unknown>;
})();

interface PresenceLaneHost {
  /** Charge `bytes` of presence from `userId` against the room's fanout budgets. False when spent. */
  reserveFanout(userId: string, bytes: number): boolean;
  /** Ask a session to change its presence once, so the lane can forward it whole. */
  requestResync(tldrawSessionId: string): void;
}

interface SessionPresence {
  /** The presence this session believes it has pushed: its last put, with every patch since applied. */
  believed: Record<string, unknown> | null;
  /** Whether peers hold exactly `believed`. While not, every update is forwarded whole. */
  inStep: boolean;
  resyncTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * How long after a dropped update the session is asked to resync: the budget
 * windows are a second, so asking sooner would mostly be dropped again.
 */
const RESYNC_DELAY_MS = 1_000;

const { MAX_PRESENCE_MESSAGE_BYTES } = WHITEBOARD_CONFIG;

/**
 * The room's presence traffic, kept in step with what each client believes
 * it sent.
 *
 * tldraw's client pushes presence as a diff against the last presence it
 * pushed, not the last the room applied. So the room may never drop an update
 * and leave it at that — every later diff would land on a record the client
 * does not have, and a field that changed only in the dropped one would stay
 * wrong on every peer. Yet the room does drop updates: a busy room's fanout
 * budget runs out, and an update can be too large to send.
 *
 * Instead, this keeps the presence each session believes it sent. Once peers
 * have fallen out of step with it, the next update is forwarded as that whole
 * record, which puts them back; and since a session that has stopped moving
 * sends no next update, it is asked for one (`requestResync`).
 */
export class RoomPresenceLane {
  private readonly sessions = new Map<string, SessionPresence>();

  private readonly host: PresenceLaneHost;

  constructor(host: PresenceLaneHost) {
    this.host = host;
  }

  /**
   * The presence operation to forward for `op`, which `tldrawSessionId` (as
   * `userId`) just pushed, or null to forward none. `op` carries the identity
   * the room stamped on it.
   */
  forward(tldrawSessionId: string, userId: string, op: PresenceOp): PresenceOp | null {
    const session = this.session(tldrawSessionId);
    session.believed = op[0] === "put"
      ? op[1]
      : session.believed && applyObjectDiff(session.believed, op[1]);

    // In step, the operation itself; out of step, the whole record. Without a
    // record to send (a patch before any put), only an in-step patch can go.
    let forwarded: PresenceOp | null = session.inStep ? op : session.believed && ["put", session.believed];
    let exact = true;
    if (forwarded && byteLength(forwarded) > MAX_PRESENCE_MESSAGE_BYTES) {
      // Too large to send as it is: send the record without what makes it
      // large — a selection of thousands, a long scribble — and stay out of
      // step, so the next update tries the whole record again.
      forwarded = session.believed && ["put", trim(session.believed)];
      exact = false;
      if (forwarded && byteLength(forwarded) > MAX_PRESENCE_MESSAGE_BYTES) forwarded = null;
    }
    if (!forwarded) {
      session.inStep = false;
      return null;
    }
    if (!this.host.reserveFanout(userId, byteLength(forwarded))) {
      session.inStep = false;
      this.scheduleResync(tldrawSessionId, session);
      return null;
    }
    session.inStep = exact;
    return forwarded;
  }

  deleteSession(tldrawSessionId: string): void {
    const session = this.sessions.get(tldrawSessionId);
    if (session?.resyncTimer) clearTimeout(session.resyncTimer);
    this.sessions.delete(tldrawSessionId);
  }

  clear(): void {
    for (const id of this.sessions.keys()) this.deleteSession(id);
  }

  private session(tldrawSessionId: string): SessionPresence {
    let session = this.sessions.get(tldrawSessionId);
    if (!session) {
      session = { believed: null, inStep: true, resyncTimer: null };
      this.sessions.set(tldrawSessionId, session);
    }
    return session;
  }

  private scheduleResync(tldrawSessionId: string, session: SessionPresence): void {
    if (session.resyncTimer) return;
    session.resyncTimer = setTimeout(() => {
      session.resyncTimer = null;
      if (this.sessions.get(tldrawSessionId) !== session || session.inStep) return;
      this.host.requestResync(tldrawSessionId);
    }, RESYNC_DELAY_MS);
    session.resyncTimer.unref?.();
  }
}

function byteLength(op: PresenceOp): number {
  return Buffer.byteLength(JSON.stringify(op), "utf8");
}

/** A presence record without the fields that can grow without bound. */
function trim(presence: Record<string, unknown>): Record<string, unknown> {
  return { ...presence, selectedShapeIds: [], scribbles: [], brush: null };
}
