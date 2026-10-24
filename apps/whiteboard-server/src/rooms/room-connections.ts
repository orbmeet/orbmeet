import {
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
  type TLSocketRoom,
} from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { RateLimiter } from "../lib/rate-limiter.ts";
import { canEditWhiteboardForMeta } from "./room-authority.ts";
import { RoomRetainedPresenceGuard } from "./room-retained-presence.ts";
import { evictStaleUserSockets } from "./room-stale-sockets.ts";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import type { SessionMeta, TldrawSocket, SocketSession } from "./room-types.ts";
import { logInfo, logWarn } from "../lib/log.ts";

// The socket map is the single source of truth for who is connected
// right now. tldraw's getSessions() keeps a closed session in an "awaiting
// removal" state for ~5s (SESSION_REMOVAL_WAIT_TIME), so connections-sensitive
// lifecycle decisions — connection cap, departure, succession, idle cleanup —
// must read live sockets (readyState OPEN) here, not getSessions(). These are
// pure over the two maps so the room's lifecycle logic stays unit-testable.

const SOCKET_OPEN = 1;

export interface LiveConnection {
  tldrawSessionId: string;
  meta: SessionMeta;
}

export function getLiveConnections(
  activeSockets: ReadonlyMap<string, TldrawSocket>,
  sessionMetaIndex: ReadonlyMap<string, SessionMeta>,
): LiveConnection[] {
  const live: LiveConnection[] = [];
  for (const [tldrawSessionId, socket] of activeSockets) {
    if (socket.readyState !== SOCKET_OPEN) continue;
    const meta = sessionMetaIndex.get(tldrawSessionId);
    if (meta) live.push({ tldrawSessionId, meta });
  }
  return live;
}

export function hasAnyLiveConnection(
  activeSockets: ReadonlyMap<string, TldrawSocket>,
): boolean {
  for (const socket of activeSockets.values()) {
    if (socket.readyState === SOCKET_OPEN) return true;
  }
  return false;
}

export function liveConnectionCount(
  activeSockets: ReadonlyMap<string, TldrawSocket>,
  sessionMetaIndex: ReadonlyMap<string, SessionMeta>,
  userId: string,
): number {
  let count = 0;
  for (const [tldrawSessionId, socket] of activeSockets) {
    if (socket.readyState !== SOCKET_OPEN) continue;
    if (sessionMetaIndex.get(tldrawSessionId)?.userId === userId) count++;
  }
  return count;
}


const MAX_CONNECTIONS_PER_USER = 3;
const MAX_CONNECTIONS_PER_ROOM = 500;
const IDLE_CLOSE_DELAY_MS = 15 * 60 * 1000;
/**
 * How long a connection the server closed for fresh claims has to come back
 * before it counts as gone. Covers re-minting the token and the socket
 * adapter's reconnect backoff, with room to spare.
 */
export const REFRESH_RECONNECT_GRACE_MS = 15_000;
const BROADCAST_WINDOW_MS = 1000;
const MAX_PRESENCE_MESSAGES_PER_USER_PER_SECOND = 60;
const MAX_PRESENCE_FANOUT_BYTES_PER_USER_PER_SECOND = 8 * 1024 * 1024;
const MAX_PRESENCE_MESSAGES_PER_ROOM_PER_SECOND = 2_000;
const MAX_PRESENCE_FANOUT_BYTES_PER_ROOM_PER_SECOND = 64 * 1024 * 1024;

export type CloseReason = (typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason];

/** What the connections owner tells the room around it. */
export interface RoomConnectionsHost {
  whiteboardRoomId: WhiteboardRoomId;
  sync: TLSocketRoom<TLRecord, SessionMeta>;
  sessionAdded(tldrawSessionId: string): void;
  /** A session left the indexes: its socket closed, or it was evicted as stale. */
  sessionRemoved(tldrawSessionId: string): void;
  /** No session of `connectionId` is left. */
  connectionEnded(connectionId: string): void;
  stateChanged(connectionsChanged: boolean): void;
  /** Nothing has held the room open for the idle delay. */
  idle(): void;
}

/**
 * Who is connected to a room, and what holds it open.
 *
 * Owns the sockets and the session meta admitted with them, the ingress
 * and presence rate limits, the presence each session retains, and the
 * room's idle lifetime: a socket or a management operation holds the room
 * open, and once neither has for the idle delay the host is told to close it.
 */
export class RoomConnections {
  private readonly sockets = new Map<string, TldrawSocket>();
  // Session meta by tldrawSessionId, so a lookup is not an O(n) getSessions() scan.
  private readonly metas = new Map<string, SessionMeta>();
  // Rate-limited by userId, not tldrawSessionId, so three tabs get no more than one.
  private readonly ingressLimiter = new RateLimiter(300, 1000, {
    maxBytesPerSecond: WHITEBOARD_CONFIG.CLIENT_INGRESS_BYTES_PER_SECOND,
  });
  private readonly presenceLimiter = new RateLimiter(
    MAX_PRESENCE_MESSAGES_PER_USER_PER_SECOND,
    BROADCAST_WINDOW_MS,
    { maxBytesPerSecond: MAX_PRESENCE_FANOUT_BYTES_PER_USER_PER_SECOND },
  );
  private readonly presenceRoomLimiter = new RateLimiter(
    MAX_PRESENCE_MESSAGES_PER_ROOM_PER_SECOND,
    BROADCAST_WINDOW_MS,
    { maxBytesPerSecond: MAX_PRESENCE_FANOUT_BYTES_PER_ROOM_PER_SECOND },
  );
  private readonly retainedPresence: RoomRetainedPresenceGuard;
  /**
   * Sessions the server closed so their client reconnects with fresh claims.
   * The close and the resulting `handleClose` land on separate event-loop
   * turns, so this carries "a refresh, not a departure" across that hop.
   */
  private readonly refreshing = new Set<string>();
  /**
   * Connections whose last session closed for a refresh. Their departure
   * waits out `REFRESH_RECONNECT_GRACE_MS`: the client is re-minting its token
   * and will be back under the same connection id, and reading the gap as the
   * user leaving would release what they held (an assistant run's pending tool
   * calls, their navigation state). A session of the connection arriving
   * cancels it; the grace running out ends the connection as usual.
   */
  private readonly pendingDepartures = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // HTTP management requests own no socket, but hold the room open until they finish.
  private activeOperations = 0;
  private readonly operationDrainWaiters = new Set<() => void>();
  private acceptingOperations = true;
  private closed = false;

  private readonly host: RoomConnectionsHost;

  constructor(host: RoomConnectionsHost) {
    this.host = host;
    this.retainedPresence = new RoomRetainedPresenceGuard({
      whiteboardRoomId: host.whiteboardRoomId,
      room: host.sync,
      presenceRateLimiter: this.presenceLimiter,
      presenceRoomRateLimiter: this.presenceRoomLimiter,
      getUserId: (tldrawSessionId) => this.metas.get(tldrawSessionId)?.userId,
      liveConnectionCount: () => this.live().length,
      closeSessionTransiently: (tldrawSessionId) => this.closeTransiently(tldrawSessionId),
    });
    // A room's lifetime is owned from the moment it exists, not from the
    // moment a socket leaves it. Rooms are materialised by paths that never
    // see a connection at all (a capture of a cold room, a command that then
    // fails, an upgrade whose handshake never completed), and each holds a
    // SQLite handle, rate-limiter timers and the whole document. Without a
    // reaper from the start they accumulate until MAX_ROOMS is hit and every
    // new whiteboard connection fails. A connection cancels it, so an
    // arriving socket costs nothing.
    this.scheduleIdleClose();
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  live(): LiveConnection[] {
    return getLiveConnections(this.sockets, this.metas);
  }

  liveCount(userId: string): number {
    return liveConnectionCount(this.sockets, this.metas, userId);
  }

  meta(tldrawSessionId: string): SessionMeta | undefined {
    return this.metas.get(tldrawSessionId);
  }

  /** Every admitted session, including one whose socket has not closed yet. */
  allMetas(): Iterable<SessionMeta> {
    return this.metas.values();
  }

  // Emptiness for teardown decisions checks both tldraw sessions and raw
  // sockets: a socket that connected but has not finished the tldraw handshake
  // yet is invisible to getNumActiveSessions() (which also lags disconnects by
  // ~5s), and closing the room under it would orphan a live connection.
  isEmpty(): boolean {
    return !hasAnyLiveConnection(this.sockets) && this.host.sync.getNumActiveSessions() === 0;
  }

  /** Nothing holds the room open: no socket and no management operation in flight. */
  private isIdle(): boolean {
    return !hasAnyLiveConnection(this.sockets) && this.activeOperations === 0;
  }

  // ─── Sockets ───────────────────────────────────────────────────────────

  /** Admit a socket the room has already checked the document for. */
  connect(ws: TldrawSocket, data: SocketSession): void {
    const {
      tldrawSessionId,
      userId,
      userName,
      role,
      // meta gets its own copy of the admission claims; nothing mutates them.
      // An authority change reconnects the socket with a new token instead.
      capabilities: { ...capabilities },
      grantPrincipal,
      whiteboardRoomId,
      connectionId,
      service,
      documentId,
    } = data;

    let liveRoomConnections = 0;
    for (const socket of this.sockets.values()) {
      if (socket.readyState === SOCKET_OPEN) liveRoomConnections += 1;
    }
    if (liveRoomConnections >= MAX_CONNECTIONS_PER_ROOM) {
      ws.close(1008, "Whiteboard room is full");
      return;
    }

    // A client can reconnect (after a 1006 abnormal close) before the server
    // processes the old socket's close, burning through every slot and
    // looping 1006 → reconnect → 1008. Drop this user's sockets that are no
    // longer OPEN so the cap below counts only live ones.
    evictStaleUserSockets({
      activeSockets: this.sockets,
      room: this.host.sync,
      meetingId: this.host.whiteboardRoomId,
      sessionMetaIndex: this.metas,
      // The dead socket's real close event will skip cleanup (see
      // room-stale-sockets.ts), so everything keyed by its session goes here.
      onSessionEvicted: (sessionId, staleMeta) => {
        const refreshed = this.refreshing.delete(sessionId);
        this.host.sessionRemoved(sessionId);
        // The socket replacing it is the same connection: it is arriving, not leaving.
        if (staleMeta && staleMeta.connectionId !== connectionId) this.noteSessionGone(staleMeta, refreshed);
      },
      userId,
    });

    if (this.liveCount(userId) >= MAX_CONNECTIONS_PER_USER) {
      ws.close(1008, "Too many connections");
      return;
    }

    const meta: SessionMeta = {
      userId,
      userName,
      role,
      capabilities,
      grantPrincipal,
      grantPrincipalKey: whiteboardGrantPrincipalKey(grantPrincipal),
      whiteboardRoomId,
      connectionId,
      ...(service ? { service } : {}),
      ...(documentId ? { documentId } : {}),
      writesSuspended: false,
      connectedReadonly: false,
    };
    const isReadonly = !canEditWhiteboardForMeta(meta);
    meta.connectedReadonly = isReadonly;

    try {
      this.host.sync.handleSocketConnect({ sessionId: tldrawSessionId, socket: ws, isReadonly, meta });
    } catch (admissionError) {
      // TLSocketRoom may register the session before a later admission step
      // throws. Remove that partial registration, but never close a session id
      // already owned by a different live socket.
      if (!this.sockets.has(tldrawSessionId)) {
        try {
          this.host.sync.handleSocketClose(tldrawSessionId);
        } catch {
          // Cleanup is best effort; preserve the admission failure for callers.
        }
      }
      throw admissionError;
    }

    this.sockets.set(tldrawSessionId, ws);
    this.metas.set(tldrawSessionId, meta);
    this.host.sessionAdded(tldrawSessionId);
    // The connection came back from a refresh: it never left.
    this.cancelPendingDeparture(connectionId);

    // Admission is complete only once TLSyncRoom and every index own the
    // session; until then the armed reaper still retires an otherwise-empty room.
    this.cancelIdleClose();

    logInfo(
      `[Room ${this.host.whiteboardRoomId}] Connected: ${userName} (${userId}) readonly=${isReadonly} (${this.liveCount(userId)}/${MAX_CONNECTIONS_PER_USER} connections)`,
    );
    // The state broadcast waits for the tldraw connect handshake (see Room.handleMessage).
  }

  // A socket error is always followed by its close, so close is the single
  // disconnect entrypoint.
  handleClose(tldrawSessionId: string, code: number, ws?: TldrawSocket, reason?: string): void {
    logInfo(
      `[Room ${this.host.whiteboardRoomId}] Closed: ${tldrawSessionId} code=${code}${reason ? ` reason=${reason}` : ""}`,
    );
    const meta = this.metas.get(tldrawSessionId);
    // A superseded socket's delayed close must not remove the newer socket,
    // nor consume the refresh marker the current socket owns.
    if (ws && this.sockets.get(tldrawSessionId) !== ws) return;
    const refreshed = this.refreshing.delete(tldrawSessionId);
    this.sockets.delete(tldrawSessionId);
    this.metas.delete(tldrawSessionId);
    this.host.sessionRemoved(tldrawSessionId);
    if (this.closed) return;

    this.host.sync.handleSocketClose(tldrawSessionId);
    // The closed socket is already out of the map, so these live checks
    // exclude it, and stay correct through the ~5s before tldraw drops the
    // session. A user who reconnected at once still has a live socket.
    if (meta) this.noteSessionGone(meta, refreshed);
    this.host.stateChanged(true);
    if (this.isIdle()) this.scheduleIdleClose();
  }

  /**
   * A session left. Its connection ends with its last session, at once, or,
   * when the server closed that session for fresh claims, once the client
   * has had its grace to come back.
   */
  private noteSessionGone(meta: SessionMeta, refreshed: boolean): void {
    const { connectionId } = meta;
    for (const other of this.metas.values()) {
      if (other.connectionId === connectionId) return;
    }
    this.cancelPendingDeparture(connectionId);
    if (!refreshed) {
      this.host.connectionEnded(connectionId);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingDepartures.delete(connectionId);
      if (this.closed) return;
      for (const other of this.metas.values()) {
        if (other.connectionId === connectionId) return;
      }
      this.host.connectionEnded(connectionId);
    }, REFRESH_RECONNECT_GRACE_MS);
    timer.unref?.();
    this.pendingDepartures.set(connectionId, timer);
  }

  private cancelPendingDeparture(connectionId: string): void {
    const timer = this.pendingDepartures.get(connectionId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingDepartures.delete(connectionId);
  }

  /** Whether `connectionId` was closed for a refresh and has not come back or timed out yet. */
  isAwaitingRefresh(connectionId: string): boolean {
    return this.pendingDepartures.has(connectionId);
  }

  send(tldrawSessionId: string, data: RoomMessage): void {
    if (this.sockets.get(tldrawSessionId)?.readyState !== SOCKET_OPEN) return;
    try {
      this.host.sync.sendCustomMessage(tldrawSessionId, data);
    } catch {
      // Session may have disconnected between the socket check and send.
    }
  }

  /** The server closes the session so its client reconnects with fresh claims. */
  reconnect(tldrawSessionId: string): void {
    if (!this.sockets.has(tldrawSessionId)) return;
    this.refreshing.add(tldrawSessionId);
    this.revoke(tldrawSessionId, TLSyncErrorCloseEventReason.NOT_AUTHENTICATED);
  }

  revoke(tldrawSessionId: string, reason: CloseReason): void {
    const ws = this.sockets.get(tldrawSessionId);
    if (!ws) return;
    logInfo(`[Room ${this.host.whiteboardRoomId}] Revoking: ${tldrawSessionId} reason=${reason}`);
    try {
      ws.close(TLSyncErrorCloseEventCode, reason);
    } catch {
      this.handleClose(tldrawSessionId, TLSyncErrorCloseEventCode, ws, reason);
    }
  }

  revokeAll(reason: CloseReason): void {
    for (const sessionId of this.sockets.keys()) this.revoke(sessionId, reason);
  }

  closeOffending(tldrawSessionId: string, reason: CloseReason): void {
    if (this.host.sync.getSessions().some(({ sessionId }) => sessionId === tldrawSessionId)) {
      this.host.sync.closeSession(tldrawSessionId, reason);
      return;
    }
    this.sockets.get(tldrawSessionId)?.close(TLSyncErrorCloseEventCode, reason);
  }

  closeTransiently(tldrawSessionId: string): void {
    if (this.host.sync.getSessions().some(({ sessionId }) => sessionId === tldrawSessionId)) {
      this.host.sync.closeSession(tldrawSessionId);
      return;
    }
    this.sockets.get(tldrawSessionId)?.close(1012, "whiteboard session refreshing");
  }

  // ─── Rate limits ───────────────────────────────────────────────────────

  /** Charge an incoming message to its user; closes the session once over the limit. */
  admitIngress(tldrawSessionId: string, userId: string, message: string | Uint8Array): boolean {
    // Byte-accurate for the per-window byte budget: a string's .length is
    // UTF-16 code units, which undercounts multi-byte payloads.
    const messageBytes = typeof message === "string" ? Buffer.byteLength(message, "utf8") : message.byteLength;
    if (this.ingressLimiter.check(userId, messageBytes)) return true;
    logWarn("[Room] Rate limited, closing connection:", tldrawSessionId);
    this.closeOffending(tldrawSessionId, TLSyncErrorCloseEventReason.RATE_LIMITED);
    return false;
  }

  /** Charge a presence fanout to its user and the room; false when either is over budget. */
  reservePresenceFanout(userId: string, presenceBytes: number): boolean {
    const fanoutBytes = presenceBytes * Math.max(0, this.live().length - 1);
    const userReservation = this.presenceLimiter.reserve(userId, fanoutBytes);
    const roomReservation = this.presenceRoomLimiter.reserve("room", fanoutBytes);
    if (!userReservation || !roomReservation) return false;
    userReservation.commit();
    roomReservation.commit();
    return true;
  }

  /** Bound what a session retains once its presence has merged. */
  enforcePresenceCeilings(tldrawSessionId: string, userId: string): void {
    this.retainedPresence.enforceCeilings(tldrawSessionId, userId);
  }

  // ─── What holds the room open ──────────────────────────────────────────

  private scheduleIdleClose(): void {
    logInfo(`[Room ${this.host.whiteboardRoomId}] No live connections, cleanup scheduled in 15min`);
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A reconnect clears the timer, but once it has fired that is a no-op,
      // so liveness is checked again here. The database already holds every
      // accepted change; closing only releases memory.
      if (this.closed || !this.isIdle()) return;
      this.host.idle();
    }, IDLE_CLOSE_DELAY_MS);
  }

  private cancelIdleClose(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Hold the room open for a management operation; false once it is closing. */
  beginOperation(): boolean {
    if (this.closed || !this.acceptingOperations) return false;
    this.activeOperations++;
    this.cancelIdleClose();
    return true;
  }

  endOperation(): void {
    if (this.activeOperations === 0) return;
    this.activeOperations--;
    if (this.activeOperations !== 0) return;
    for (const resolve of this.operationDrainWaiters) resolve();
    this.operationDrainWaiters.clear();
    if (!this.closed && this.isIdle()) this.scheduleIdleClose();
  }

  waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.operationDrainWaiters.add(resolve));
  }

  /** Refuse new management operations and cancel the idle close: the room is being shut down or purged. */
  stopAcceptingOperations(): void {
    this.acceptingOperations = false;
    this.cancelIdleClose();
  }

  /** Release every timer and index. The sockets themselves close with the tldraw room. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdleClose();
    this.refreshing.clear();
    for (const timer of this.pendingDepartures.values()) clearTimeout(timer);
    this.pendingDepartures.clear();
    this.sockets.clear();
    this.metas.clear();
    this.presenceLimiter.destroy();
    this.presenceRoomLimiter.destroy();
    this.ingressLimiter.destroy();
  }
}
