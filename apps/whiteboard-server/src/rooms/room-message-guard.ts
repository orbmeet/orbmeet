import {
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import type { SessionMeta } from "./room-types.ts";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { AssembledMessageTooLargeError } from "@orbmeet/whiteboard-core/chunked-json";
import {
  classifyIncomingDiff,
  classifyIncomingDiffSizeEffect,
  getPageFrameIdsFromSnapshot,
  hasUnsafeObjectKeyDeep,
  JsonMessageAssembler,
  type IncomingDiffSizeEffect,
} from "./page-frame-guard.ts";
import type { PresenceOp } from "./room-presence-lane.ts";
import { ROOM_NAVIGATION_ID } from "@orbmeet/whiteboard-core/room-navigation";
import { isRecord } from "@orbmeet/primitives";
import { isPageFrameRecord } from "./record-rules.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createUserId } from "@tldraw/tlschema";
import { logError, logWarn } from "../lib/log.ts";

type CloseReason =
  (typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason];

/** A message the guard admitted, as the room hands it to TLSyncRoom. */
interface AdmittedMessage {
  /** The message as assembled, without its presence. */
  message: Record<string, unknown>;
  /** Its presence operation, stamped with the session's identity; the room's presence lane decides what of it goes on. */
  presence: PresenceOp | null;
}

export type IncomingMessageDecision = {
  accept: boolean;
  hasPageFrameMutation: boolean;
  assembledBytes: number;
  sizeEffect: IncomingDiffSizeEffect;
  /**
   * This message is the client's tldraw `connect` request. Applying it is what
   * promotes the session to Connected, which is the point from which
   * sendCustomMessage reaches it — so the room broadcasts its state right after.
   */
  isConnectRequest: boolean;
  /**
   * Exactly what the caller must hand to TLSyncRoom, and non-null iff `accept`.
   *
   * The guard assembles chunked messages itself, so it is the only party that
   * sees a whole message before it is judged. Forwarding what it assembled —
   * rather than the raw frame it was handed — is what makes the verdict
   * authoritative: TLSyncRoom never observes a partial message, and never a
   * different message from the one that was approved.
   */
  forward: AdmittedMessage | null;
  /**
   * The records the forwarded diff touches, when it touches page frames: what
   * the page-frame index re-reads once the push has merged. Taken from the
   * guard's own parse, so nothing downstream parses the message again.
   */
  touchedRecordIds: readonly string[];
  /** The forwarded diff writes the room's navigation. */
  touchesNavigation: boolean;
};

interface RoomMessageGuardOptions {
  whiteboardRoomId: WhiteboardRoomId;
  getSnapshot: () => unknown;
  getRecord?: (id: string) => unknown;
  getSessionMeta: (tldrawSessionId: string) => SessionMeta | undefined;
  canEditWhiteboardForMeta: (meta: SessionMeta) => boolean;
  canAcceptDocumentMutations?: () => boolean;
  sendCustomMessage: (tldrawSessionId: string, data: RoomMessage) => void;
  discardPush: (tldrawSessionId: string, clientClock: number) => void;
  onRoomSizeRecovered: () => void;
  closeSession: (tldrawSessionId: string, reason: CloseReason) => void;
  closeSessionTransiently: (tldrawSessionId: string) => void;
  /** Override only for deterministic resource-limit tests. */
  maxRoomAssemblyBytes?: number;
}

const { MAX_PAGES, MAX_ROOM_WRITE_BYTES } = WHITEBOARD_CONFIG;

/**
 * A chunk that does not complete a message, or a message with no authenticated
 * writer behind it. Nothing is forwarded: TLSyncRoom sees a message only once
 * this guard has assembled it whole and ruled on it.
 */
function forwardNothing(): IncomingMessageDecision {
  return {
    accept: false,
    hasPageFrameMutation: false,
    assembledBytes: 0,
    sizeEffect: "no-mutation",
    isConnectRequest: false,
    forward: null,
    touchedRecordIds: [],
    touchesNavigation: false,
  };
}

function isConnectRequestMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "connect"
  );
}

function getPushClientClock(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { type?: unknown; clientClock?: unknown };
  return candidate.type === "push"
    && Number.isSafeInteger(candidate.clientClock)
    && (candidate.clientClock as number) >= 0
    ? candidate.clientClock as number
    : null;
}

/**
 * A push's presence operation, stamped with the identity the session's token
 * carries — whatever name or id a client claims, peers are shown the one the
 * room admitted it as. Null when the operation is not one TLSyncClient sends.
 *
 * Presence has no record rules: a `__proto__` key in a patch would set the
 * presence record's prototype as sync-core applies it (and the presence
 * lane's copy of it), and one inside a put's free-form `meta` passes
 * tldraw's validator. So an operation carrying one is refused here, as a
 * document diff is.
 */
function stampPresence(presence: unknown, meta: SessionMeta): PresenceOp | null {
  if (!Array.isArray(presence) || presence.length !== 2) return null;
  const [operation, value] = presence as [unknown, unknown];
  if (!isRecord(value) || hasUnsafeObjectKeyDeep(value)) return null;
  const userId = createUserId(meta.userId);
  if (operation === "put") return ["put", { ...value, userId, userName: meta.userName }];
  if (operation === "patch") {
    return ["patch", { ...value, userId: ["put", userId], userName: ["put", meta.userName] }];
  }
  return null;
}

// Minimum spacing between snapshot re-measures. Re-measuring serializes the
// whole document (up to MAX_ROOM_WRITE_BYTES) on the event loop every room and
// socket on this host shares, so no amount of client traffic may drive more
// than one of them per window.
const REMEASURE_MIN_INTERVAL_MS = 2_000;
// Accepted additive bytes that may accumulate before the running estimate is
// refreshed against the real document, amortizing the serialization cost.
const MEASURE_AFTER_ACCEPTED_BYTES = 512 * 1024;
// Headroom above the write cap for pushes that also remove records. Deleting is
// the only way out of a full room, so those must still land once the document is
// at the cap — but they can carry writes too, so they get a bounded allowance
// rather than a free pass. Comfortably above one client's per-window ingress.
const REMOVING_WRITE_HEADROOM_BYTES = 4 * 1024 * 1024;
const CHUNK_ASSEMBLY_TIMEOUT_MS = 30_000;
const MAX_ROOM_ASSEMBLY_BYTES = 64 * 1024 * 1024;

export class RoomMessageGuard {
  private readonly messageAssemblers = new Map<string, JsonMessageAssembler>();
  private readonly connectedSessions = new Set<string>();
  private readonly assemblyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private totalAssemblyBytes = 0;
  private pageFrameIds: ReadonlySet<string> = new Set();
  private serializedSnapshotBytes = 0;
  private acceptedMutationBytesSinceMeasure = 0;
  private lastRemeasureAt = 0;
  // Whether `serializedSnapshotBytes` came from a measurement that succeeded.
  // A failed one pins the estimate at the cap to fail closed, and that pin must
  // not be mistaken for an exact reading — otherwise the room stays refusing
  // every write with nothing able to unstick it.
  private measurementIsExact = false;
  private roomSizeLimitSignaled = false;
  private recoveryCheck: ReturnType<typeof setTimeout> | null = null;

  private readonly options: RoomMessageGuardOptions;

  constructor(options: RoomMessageGuardOptions) {
    this.options = options;
    this.refreshPageFrameIds();
    this.measureSnapshotBytes();
  }

  isRoomSizeLimited(): boolean {
    return this.roomSizeLimitSignaled;
  }

  hasPageFrame(pageId: string): boolean {
    return this.pageFrameIds.has(pageId);
  }

  addSession(tldrawSessionId: string): void {
    this.messageAssemblers.set(tldrawSessionId, new JsonMessageAssembler());
    this.connectedSessions.delete(tldrawSessionId);
  }

  deleteSession(tldrawSessionId: string): void {
    this.releaseAssemblerBytes(this.messageAssemblers.get(tldrawSessionId));
    this.messageAssemblers.delete(tldrawSessionId);
    this.connectedSessions.delete(tldrawSessionId);
    this.clearAssemblyTimeout(tldrawSessionId);
  }

  clearSessions(): void {
    if (this.recoveryCheck) clearTimeout(this.recoveryCheck);
    this.recoveryCheck = null;
    this.messageAssemblers.clear();
    this.totalAssemblyBytes = 0;
    this.connectedSessions.clear();
    for (const timeout of this.assemblyTimeouts.values()) clearTimeout(timeout);
    this.assemblyTimeouts.clear();
  }

  noteServerPageFrameMutation(): void {
    this.refreshPageFrameIds();
  }

  /**
   * Refresh every document-derived cache after a server-side snapshot replace.
   * Unlike an incremental mutation, a replacement invalidates both the page
   * authority set and the byte estimate in one operation.
   */
  noteServerSnapshotReplacement(): void {
    this.refreshPageFrameIds();
    this.acceptedMutationBytesSinceMeasure = 0;
    this.measureSnapshotBytes();
  }

  /**
   * The running upper bound on the room's serialized size: last measured size
   * plus every mutation byte accepted since. Server-side commands size their
   * own writes against this instead of re-serializing the document, which is
   * the cost the amortization above exists to avoid.
   */
  getEstimatedRoomBytes(): number {
    return this.serializedSnapshotBytes + this.acceptedMutationBytesSinceMeasure;
  }

  /** Exact-measure the document when a server mutation would otherwise reject. */
  verifyRoomSizeEstimate(): boolean {
    return this.verifyEstimate();
  }

  /**
   * Account for bytes written by a server-side command (page add, PDF import)
   * so the estimate tracks them the same way it tracks accepted client pushes.
   * Without this the estimate silently under-counts server writes until the
   * next re-measure, and the room could be admitted past its cap.
   */
  noteServerMutationBytes(byteLength: number): void {
    if (byteLength <= 0) return;
    this.acceptedMutationBytesSinceMeasure += byteLength;
    if (this.acceptedMutationBytesSinceMeasure >= MEASURE_AFTER_ACCEPTED_BYTES) {
      this.remeasureIfDue();
    }
  }

  evaluate(
    tldrawSessionId: string,
    message: string | Uint8Array,
  ): IncomingMessageDecision {
    const meta = this.options.getSessionMeta(tldrawSessionId);
    // No metadata means there is no authenticated writer to authorize. tldraw
    // also ignores unknown sessions, but the application guard must fail closed
    // on its own rather than depend on that downstream implementation detail.
    if (!meta) {
      return forwardNothing();
    }

    const messageString =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const assembler = this.getMessageAssembler(tldrawSessionId);
    const previousAssemblerBytes = assembler.bufferedBytes;
    const roomAssemblyLimit = this.options.maxRoomAssemblyBytes ?? MAX_ROOM_ASSEMBLY_BYTES;
    const sessionAllowance = Math.max(
      0,
      roomAssemblyLimit - (this.totalAssemblyBytes - previousAssemblerBytes),
    );
    const assembled = assembler.handleMessage(messageString, sessionAllowance);
    this.totalAssemblyBytes += assembler.bufferedBytes - previousAssemblerBytes;
    if (!assembled) {
      this.ensureAssemblyTimeout(tldrawSessionId, assembler);
      return forwardNothing();
    }
    this.clearAssemblyTimeout(tldrawSessionId);

    if ("error" in assembled) {
      if (
        assembled.error instanceof AssembledMessageTooLargeError
        && !assembled.error.exceedsMessageMaximum
      ) {
        // An in-limit message that only outgrew what the room had left to
        // buffer. The room is busy, not this sender: close it as retryable
        // rather than with INVALID_RECORD, which the client treats as fatal.
        logWarn(
          `[Room ${this.options.whiteboardRoomId}] Room assembly budget exhausted; asking ${meta.userId} to reconnect.`,
        );
        this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.RATE_LIMITED);
        return forwardNothing();
      }
      logWarn(
        `[Room ${this.options.whiteboardRoomId}] Rejected malformed tldraw message from ${meta.userId}:`,
        assembled.error.message,
      );
      this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.INVALID_RECORD);
      return forwardNothing();
    }

    const data = assembled.data;
    if (!isRecord(data)) {
      this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.INVALID_RECORD);
      return forwardNothing();
    }
    const assembledBytes = Buffer.byteLength(assembled.stringified, "utf8");
    const isConnectRequest = isConnectRequestMessage(data);
    const clientClock = getPushClientClock(data);

    let presence: PresenceOp | null = null;
    if (data.type === "push" && data.presence !== undefined) {
      presence = clientClock === null ? null : stampPresence(data.presence, meta);
      if (presence === null) {
        this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.INVALID_RECORD);
        return forwardNothing();
      }
    }
    const admitted: Record<string, unknown> = { ...data };
    delete admitted.presence;

    // Only a write that can land is budgeted and judged as one. A viewer's
    // writes are skipped by tldraw at the session's readonly flag; those of an
    // editor whose authority is being narrowed, or made while the document
    // refuses writes, by the room's authorizers. Each is rolled back on its
    // client, and none of it reaches the document.
    const canWrite =
      this.options.canEditWhiteboardForMeta(meta) && this.options.canAcceptDocumentMutations?.() !== false;
    const sizeEffect = canWrite ? classifyIncomingDiffSizeEffect(data) : "no-mutation";
    const diff = isRecord(data.diff) ? data.diff : null;

    // Every verdict below shares the measurements above; only the outcome and
    // the page-frame flag vary, so name just those at each exit.
    const decide = (
      outcome: Pick<IncomingMessageDecision, "accept" | "hasPageFrameMutation">,
    ): IncomingMessageDecision => ({
      assembledBytes,
      sizeEffect,
      isConnectRequest,
      ...outcome,
      forward: outcome.accept ? { message: admitted, presence } : null,
      touchedRecordIds: outcome.accept && outcome.hasPageFrameMutation && diff ? Object.keys(diff) : [],
      touchesNavigation: outcome.accept && canWrite && !!diff && Object.hasOwn(diff, ROOM_NAVIGATION_ID),
    });

    // A connect request can include the full document diff from an
    // attacker-chosen clock. TLSyncRoom accepts it even after the session has
    // already connected, so letting duplicates through turns a tiny inbound
    // message into a large response plus an application-state broadcast.
    if (isConnectRequest) {
      if (this.connectedSessions.has(tldrawSessionId)) {
        return decide({ accept: false, hasPageFrameMutation: false });
      }
      // The remainder of the guard cannot reject a connect request as a
      // mutation. Mark it before handing it to TLSyncRoom; an invalid protocol
      // handshake closes the socket, whose cleanup removes this marker.
      this.connectedSessions.add(tldrawSessionId);
    }

    if (!canWrite) return decide({ accept: true, hasPageFrameMutation: false });

    const verdict = classifyIncomingDiff(data, this.pageFrameIds, MAX_PAGES);
    if (verdict === "forbidden") {
      logWarn(`[Room ${this.options.whiteboardRoomId}] Rejected a malformed document mutation from ${meta.userId}`);
      this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
      return decide({ accept: false, hasPageFrameMutation: false });
    }

    if (verdict === "invalid-record-id") {
      // Answer with the same NAK the room-size rejection uses: the client rolls
      // the offending records back and stays connected, which is the only
      // recovery that terminates; a transient reconnect would replay the
      // identical local edit forever. A message without a clock to answer (a
      // connect request carrying a diff) gets the transient resync instead.
      logWarn(`[Room ${this.options.whiteboardRoomId}] Rejected a record id snapshots cannot hold from ${meta.userId}`);
      if (clientClock === null) this.options.closeSessionTransiently(tldrawSessionId);
      else this.options.discardPush(tldrawSessionId, clientClock);
      return decide({ accept: false, hasPageFrameMutation: false });
    }

    if (verdict === "page-limit-exceeded") {
      logWarn(
        `[Room ${this.options.whiteboardRoomId}] Rejected page-frame mutation above the ${MAX_PAGES}-page limit from ${meta.userId}`,
      );
      this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
      return decide({ accept: false, hasPageFrameMutation: true });
    }

    if (verdict === "last-page") {
      // Between managers this is a race, not misbehavior: each deleted a
      // different page of a two-page board before seeing the other's change.
      // Roll the push back through tldraw's protocol, so the client undoes
      // its delete, and keep the session.
      if (clientClock === null) this.options.closeSessionTransiently(tldrawSessionId);
      else this.options.discardPush(tldrawSessionId, clientClock);
      return decide({ accept: false, hasPageFrameMutation: false });
    }

    const hasPageFrameMutation = verdict === "page-frames";
    // Size is the last question, asked only of a push that may be written:
    // the room-full signal it raises goes to everyone in the room.
    if (this.wouldExceedRoomLimit(sizeEffect, assembledBytes)) {
      this.roomSizeLimitSignaled = true;
      logWarn(
        `[Room ${this.options.whiteboardRoomId}] Rejected growth above the ${MAX_ROOM_WRITE_BYTES}-byte room limit from ${meta.userId}`,
      );
      this.options.sendCustomMessage(tldrawSessionId, {
        type: WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT,
        maxBytes: MAX_ROOM_WRITE_BYTES,
      });
      if (clientClock === null) {
        this.options.closeSession(tldrawSessionId, TLSyncErrorCloseEventReason.ROOM_FULL);
      } else {
        // Resolve the pending push through tldraw's protocol. Closing the socket
        // leaves the push pending, so the client replays it after reconnect and
        // can no longer make a deletion that would recover the room.
        this.options.discardPush(tldrawSessionId, clientClock);
      }
      return decide({ accept: false, hasPageFrameMutation: false });
    }

    return decide({ accept: true, hasPageFrameMutation });
  }

  /** Update the exact page authority index from touched records; amortize only
   * the byte measurement, whose upper bound remains safe between snapshots. */
  recordAcceptedMessage(decision: IncomingMessageDecision, snapshot?: unknown): void {
    if (decision.sizeEffect !== "no-mutation") {
      this.acceptedMutationBytesSinceMeasure += decision.assembledBytes;
      if (this.roomSizeLimitSignaled) {
        this.checkRoomSizeRecovery(snapshot);
      // A remove-only push cannot grow the document, so the running total stays
      // an upper bound without re-measuring. Defer that (full-serialization)
      // cost to the next over-limit check rather than paying it on every erase.
      } else if (
        decision.sizeEffect !== "remove-only" &&
        this.acceptedMutationBytesSinceMeasure >= MEASURE_AFTER_ACCEPTED_BYTES
      ) {
        this.remeasureIfDue(snapshot);
      }
    }
    if (decision.hasPageFrameMutation) {
      if (this.options.getRecord && decision.forward) {
        const nextPageFrameIds = new Set(this.pageFrameIds);
        for (const id of decision.touchedRecordIds) {
          if (isPageFrameRecord(this.options.getRecord(id))) nextPageFrameIds.add(id);
          else nextPageFrameIds.delete(id);
        }
        this.pageFrameIds = nextPageFrameIds;
      } else this.refreshPageFrameIds(snapshot);
    }
  }

  /**
   * Whether admitting this message would leave the room above the write cap.
   *
   * The running estimate (last measured size + accepted mutation bytes) only
   * ever over-counts: mutation bytes are added in full, a patch that rewrites an
   * existing record is charged as if it were new, and removes never subtract. An
   * under-limit estimate is therefore trustworthy on its own — but an over-limit
   * one says nothing until it has been checked against the real document.
   *
   * So an over-limit projection is never acted on until `verifyEstimate` says
   * it rests on an exact reading of the current document. That gives both
   * properties at once:
   *
   * - A stale-high estimate can never reject a write. Under the previous 2s
   *   throttle a burst could pile up tens of megabytes of phantom growth and
   *   close an editor with ROOM_FULL against a nearly empty document.
   * - A client parked at a genuinely full room still serializes the document
   *   exactly once, not once per message: its pushes are rejected, rejected
   *   pushes are never recorded, so no drift accumulates to trigger another.
   *
   * Removals are what let a full room recover, and they do accumulate drift, so
   * the first write after a delete re-measures and sees the room shrink.
   *
   * A `may-shrink` push (removes alongside other ops) is measured the same way
   * but against a higher ceiling. Rejecting it at the cap is precisely what
   * leaves a full room with no way back down, because the delete the user just
   * asked for is the recovery. The headroom is bounded, and a push can never add
   * more than it sends, so the document still cannot grow without limit.
   * `remove-only` pushes are always admitted: they are the guaranteed escape.
   */
  private wouldExceedRoomLimit(
    sizeEffect: IncomingDiffSizeEffect,
    incomingBytes: number,
  ): boolean {
    if (sizeEffect === "no-mutation" || sizeEffect === "remove-only") return false;
    const ceilingBytes =
      sizeEffect === "may-shrink"
        ? MAX_ROOM_WRITE_BYTES + REMOVING_WRITE_HEADROOM_BYTES
        : MAX_ROOM_WRITE_BYTES;
    const projectedBytes = () =>
      this.serializedSnapshotBytes +
      this.acceptedMutationBytesSinceMeasure +
      incomingBytes;
    if (projectedBytes() <= ceilingBytes) return false;
    if (!this.verifyEstimate()) return true;
    return projectedBytes() > ceilingBytes;
  }

  /**
   * Bring the size estimate to something an over-limit verdict can rest on.
   *
   * Returns false when it could not, in which case the conservative
   * (over-counting) estimate stands and the write is refused — the same
   * fail-closed direction the estimate itself has.
   */
  private verifyEstimate(): boolean {
    // Nothing accepted since the last successful measurement, so that
    // measurement still describes the document exactly.
    if (this.measurementIsExact && this.acceptedMutationBytesSinceMeasure === 0) {
      return true;
    }
    // Otherwise the estimate has either drifted or was pinned by a measurement
    // that threw. Only the second case is throttled: a document that cannot be
    // serialized at all must not cost one attempt per message, while a healthy
    // one is always verified rather than rejected on a guess.
    if (!this.measurementIsExact && !this.isRemeasureDue()) return false;
    this.measureSnapshotBytes();
    return this.measurementIsExact;
  }

  private getMessageAssembler(tldrawSessionId: string): JsonMessageAssembler {
    let assembler = this.messageAssemblers.get(tldrawSessionId);
    if (!assembler) {
      assembler = new JsonMessageAssembler();
      this.messageAssemblers.set(tldrawSessionId, assembler);
    }
    return assembler;
  }

  private ensureAssemblyTimeout(
    tldrawSessionId: string,
    assembler: JsonMessageAssembler,
  ): void {
    if (this.assemblyTimeouts.has(tldrawSessionId)) return;
    const timeout = setTimeout(() => {
      this.assemblyTimeouts.delete(tldrawSessionId);
      if (!assembler.isAssembling) return;
      this.releaseAssemblerBytes(assembler);
      assembler.reset();
      logWarn(
        `[Room ${this.options.whiteboardRoomId}] Timed out incomplete tldraw message`,
      );
      // tldraw maintains its own parallel chunk assembler. Closing the session
      // is required to release both buffers; resetting only this guard would
      // leave sync-core retaining the partial message.
      this.options.closeSessionTransiently(tldrawSessionId);
    }, CHUNK_ASSEMBLY_TIMEOUT_MS);
    timeout.unref?.();
    this.assemblyTimeouts.set(tldrawSessionId, timeout);
  }


  private clearAssemblyTimeout(tldrawSessionId: string): void {
    const timeout = this.assemblyTimeouts.get(tldrawSessionId);
    if (!timeout) return;
    clearTimeout(timeout);
    this.assemblyTimeouts.delete(tldrawSessionId);
  }

  private releaseAssemblerBytes(assembler: JsonMessageAssembler | undefined): void {
    if (!assembler) return;
    this.totalAssemblyBytes = Math.max(0, this.totalAssemblyBytes - assembler.bufferedBytes);
  }

  // Re-derive the page-frame id set from the authoritative document. Serializes
  // the snapshot, so only call this after a confirmed page-frame mutation or a
  // server-side page insert, never on the ordinary per-message path.
  private refreshPageFrameIds(snapshot?: unknown): void {
    this.pageFrameIds = getPageFrameIdsFromSnapshot(snapshot ?? this.options.getSnapshot());
  }

  /**
   * Throttled re-measure for the *amortization* path only.
   *
   * Keeping the running estimate close to reality is a nicety, not a
   * correctness requirement — `wouldExceedRoomLimit` re-measures on its own
   * whenever a verdict actually depends on it. So this one is free to skip:
   * without a throttle the accept path re-serialized the document once per
   * MEASURE_AFTER_ACCEPTED_BYTES accepted, which at the client ingress ceiling
   * is dozens of full-document walks per second on the loop every room and
   * socket on this host shares.
   *
   * Deferring is always safe: the running estimate only ever over-counts, so a
   * skipped re-measure keeps the bound conservative rather than admitting
   * something oversized.
   */
  private isRemeasureDue(): boolean {
    return Date.now() - this.lastRemeasureAt >= REMEASURE_MIN_INTERVAL_MS;
  }

  /**
   * While the room is at its limit, look for it to come back under, through
   * the same throttle as every other measurement: deleting shapes one by one
   * at the ingress ceiling would otherwise serialize the whole document per
   * message. A check the throttle skips is scheduled for when it allows, so
   * recovery is announced even if no further message arrives.
   */
  private checkRoomSizeRecovery(snapshot?: unknown): void {
    if (!this.isRemeasureDue()) {
      this.recoveryCheck ??= setTimeout(() => {
        this.recoveryCheck = null;
        if (this.roomSizeLimitSignaled) this.checkRoomSizeRecovery();
      }, Math.max(0, REMEASURE_MIN_INTERVAL_MS - (Date.now() - this.lastRemeasureAt)));
      this.recoveryCheck.unref?.();
      return;
    }
    this.measureSnapshotBytes(snapshot);
    if (this.measurementIsExact && this.serializedSnapshotBytes <= MAX_ROOM_WRITE_BYTES) {
      this.roomSizeLimitSignaled = false;
      this.options.onRoomSizeRecovered();
    }
  }

  private remeasureIfDue(snapshot?: unknown): void {
    if (!this.isRemeasureDue()) return;
    this.measureSnapshotBytes(snapshot);
  }

  // Stamps `lastRemeasureAt` itself, so every measurement — including the
  // constructor's and the over-limit verification's — refreshes the
  // amortization budget rather than only the throttled path doing so.
  private measureSnapshotBytes(snapshot?: unknown): void {
    this.lastRemeasureAt = Date.now();
    try {
      this.serializedSnapshotBytes = Buffer.byteLength(
        JSON.stringify(snapshot ?? this.options.getSnapshot()),
        "utf8",
      );
      this.measurementIsExact = true;
    } catch (error) {
      // Fail closed for growth. This is deliberately recoverable: the pin is
      // marked inexact, so the next over-limit check re-measures once its
      // throttle window has passed rather than refusing every mutation in the
      // room until it is restarted.
      this.serializedSnapshotBytes = MAX_ROOM_WRITE_BYTES;
      this.measurementIsExact = false;
      logError(
        `[Room ${this.options.whiteboardRoomId}] Failed to measure room snapshot:`,
        error,
      );
    }
    this.acceptedMutationBytesSinceMeasure = 0;
  }
}
