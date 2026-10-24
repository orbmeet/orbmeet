import {
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
  type TLPersistentClientSocket,
  type TLSocketStatusChangeEvent,
} from "@tldraw/sync-core";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

type SyncQuery = {
  sessionId: string;
  storeId: string;
};

// WebSocket.OPEN, as a literal: reading it off the global constructor breaks
// wherever WebSocket is polyfilled or stubbed. Mirrors room-connections.ts.
const SOCKET_OPEN = 1;
const MIN_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;
// How long a socket asked to close may stay in CLOSING before we give up
// waiting for its `close` event and reconnect anyway.
const CLOSE_HANDSHAKE_GRACE_MS = 3_000;
const MAX_BYTES_PER_CHAR = 4;
const MAX_SAFE_MESSAGE_SIZE = WHITEBOARD_CONFIG.MAX_CLIENT_FRAME_BYTES / MAX_BYTES_PER_CHAR;
const AUTH_PROTOCOL = "orbmeet-wb";
const textEncoder = new TextEncoder();

// Reasons the sync server's /connect handler closes a socket with code 4099. A wifi blip
// during token refresh surfaces here as NOT_AUTHENTICATED (stale/expired JWT)
// or UNKNOWN_ERROR (the VPS↔Worker access-validation call timed out). Both are
// transient: the adapter can re-resolve the URI (which re-mints the token) and
// reconnect. Only the reasons below are genuinely permanent — for those we keep
// tldraw's terminal `error` status, which stops retrying.
const FATAL_SYNC_ERROR_REASONS: ReadonlySet<string> = new Set([
  TLSyncErrorCloseEventReason.NOT_FOUND,
  TLSyncErrorCloseEventReason.FORBIDDEN,
  TLSyncErrorCloseEventReason.CLIENT_TOO_OLD,
  TLSyncErrorCloseEventReason.SERVER_TOO_OLD,
  TLSyncErrorCloseEventReason.INVALID_RECORD,
  // The same message would be resent on reconnect and refused again.
  TLSyncErrorCloseEventReason.MESSAGE_TOO_LARGE,
]);

/**
 * True for sync-error reasons that warrant another connection attempt (a fresh
 * token, a recovered backend). NOT_AUTHENTICATED, UNKNOWN_ERROR, RATE_LIMITED,
 * and anything unrecognized fall here — surfacing them as terminal would make a
 * momentary network drop permanently break the whiteboard.
 */
export function isTransientSyncErrorReason(reason: string): boolean {
  return !FATAL_SYNC_ERROR_REASONS.has(reason);
}

/**
 * What a connection attempt tells the URI factory about the attempt before it.
 * `tokenRejected` is true when the last socket was closed as NOT_AUTHENTICATED:
 * the sync server found the token's claims stale (a grant or role changed), so
 * a factory that caches tokens must mint a new one rather than resend it.
 */
export interface WhiteboardConnectAttempt {
  tokenRejected: boolean;
}

function httpToWs(url: string): string {
  return url.replace(/^http(s)?:/, "ws$1:");
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Split a message into `${chunksRemaining}_` prefixed parts, built from the tail
 * backwards so the prefix counts down to 0 on the final chunk (the wire format
 * the server's assembler reassembles).
 *
 * Boundaries are nudged off surrogate pairs. `slice` cuts at UTF-16 code-unit
 * offsets, so a pair straddling a boundary would be sent as two lone
 * surrogates — which the WebSocket text encoder replaces with U+FFFD, silently
 * corrupting emoji and other astral characters in large pushes. The pair is
 * kept whole in the earlier chunk instead, which only ever shrinks a chunk and
 * so cannot breach the size ceiling.
 */
export function chunkMessage(message: string): string[] {
  if (message.length < MAX_SAFE_MESSAGE_SIZE) return [message];
  const chunks: string[] = [];
  let chunkNumber = 0;
  let offset = message.length;
  while (offset > 0) {
    const prefix = `${chunkNumber}_`;
    let chunkSize = Math.max(Math.min(MAX_SAFE_MESSAGE_SIZE - prefix.length, offset), 1);
    if (chunkSize > 1 && isLowSurrogate(message.charCodeAt(offset - chunkSize))) {
      chunkSize -= 1;
    }
    chunks.unshift(prefix + message.slice(offset - chunkSize, offset));
    offset -= chunkSize;
    chunkNumber++;
  }
  return chunks;
}

/**
 * Full jitter: pick uniformly from `[0, ceiling]` rather than waiting exactly
 * `ceiling`.
 *
 * The ceiling progression (500 / 750 / 1125 / … / 5000) is identical on every
 * client, so without jitter a backend outage would end with every
 * disconnected client reconnecting in the same millisecond — a synchronised
 * storm against token issuance and the sync server, which then causes the next
 * round of failures. Spreading arrivals across the whole window costs nothing
 * and removes the self-amplification.
 */
export function jitterReconnectDelayMs(
  ceilingMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(random() * ceilingMs);
}

export function buildWhiteboardWebSocketRequest(
  rawUri: string,
  query: SyncQuery,
): { uri: string; protocols: string[] } {
  const url = new URL(rawUri, globalThis.location?.href);
  const hashParams = new URLSearchParams(url.hash.slice(1));
  const token = url.searchParams.get("token") ?? hashParams.get("token");

  url.searchParams.delete("token");
  hashParams.delete("token");
  url.searchParams.set("sessionId", query.sessionId);
  url.searchParams.set("storeId", query.storeId);
  url.hash = hashParams.toString() ? `#${hashParams.toString()}` : "";

  return {
    uri: httpToWs(url.toString()),
    protocols: token ? [token, AUTH_PROTOCOL] : [AUTH_PROTOCOL],
  };
}

export class WhiteboardWebSocketAdapter implements TLPersistentClientSocket {
  private ws: WebSocket | null = null;
  private disposed = false;
  /**
   * Monotonic token for "the connection attempt currently in charge".
   *
   * `connect()` awaits `getUri()` — which mints a fresh token — before it can
   * claim `this.ws`, so two overlapping calls (a `restart()` during a slow mint)
   * would each construct a `WebSocket` and the second would silently overwrite
   * the first. The orphan was never closed: server-side it stayed OPEN, so
   * `evictStaleUserSockets` skipped it and it kept counting against
   * `MAX_CONNECTIONS_PER_USER` until the 120s idle timeout. Two flaps exhausted
   * every slot and the user got `1008 Too many connections`.
   *
   * Every await and every teardown retires its generation, so a superseded
   * attempt abandons itself before it can construct a socket at all.
   */
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  private connectionStatusValue: TLPersistentClientSocket["connectionStatus"] = "offline";
  private readonly messageListeners = new Set<(msg: object) => void>();
  private readonly statusListeners = new Set<(event: TLSocketStatusChangeEvent) => void>();

  /** Whether the last socket closed as NOT_AUTHENTICATED, for the next `getUri`. */
  private tokenRejected = false;

  constructor(
    private readonly getUri: (attempt: WhiteboardConnectAttempt) => string | Promise<string>,
    private readonly query: SyncQuery,
  ) {
    void this.connect();
  }

  get connectionStatus(): TLPersistentClientSocket["connectionStatus"] {
    return this.connectionStatusValue;
  }

  close(): void {
    this.disposed = true;
    this.generation++;
    this.clearReconnectTimer();
    this.clearCloseGraceTimer();
    closeQuietly(this.ws);
    this.ws = null;
  }

  restart(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    if (this.ws) {
      // Same rule as the `onerror` path: hand the socket back to the server
      // before opening its replacement. Reconnecting immediately here was the
      // one way left to run two sockets for one session, and a CLOSING socket
      // still counts against MAX_CONNECTIONS_PER_USER.
      this.retireSocket(this.ws);
      return;
    }
    // No socket yet — a `connect()` may be awaiting its token. Retire that
    // attempt's generation so it abandons itself, then start a fresh one.
    this.generation++;
    this.setStatus("offline");
    void this.connect();
  }

  /** True while `generation` is still the attempt in charge. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  sendMessage(msg: object): void {
    const socket = this.ws;
    // The readyState check is not protecting against a throw: send() only throws
    // while CONNECTING, which "online" (set solely in onopen) already excludes,
    // and a CLOSING/CLOSED socket discards the data instead. It skips serializing
    // and chunking a push — potentially megabytes — that the socket would drop,
    // between the peer closing and our close event landing. tldraw re-sends any
    // unacknowledged push after the reconnect either way.
    if (
      !socket ||
      this.connectionStatusValue !== "online" ||
      socket.readyState !== SOCKET_OPEN
    ) {
      return;
    }
    const serialized = JSON.stringify(msg);
    if (textEncoder.encode(serialized).byteLength > WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES) {
      // tldraw does not catch adapter send failures. Throwing here leaves its
      // unsent diff queued and schedules the same exception again. A terminal
      // socket status is the protocol-supported way to stop synchronization
      // and surface the failure through onSyncError without pretending the
      // oversized diff reached the server.
      this.failTerminal(TLSyncErrorCloseEventReason.INVALID_RECORD);
      return;
    }
    for (const part of chunkMessage(serialized)) {
      socket.send(part);
    }
  }

  onReceiveMessage(cb: (val: object) => void): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  onStatusChange(cb: (event: TLSocketStatusChangeEvent) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.ws) return;
    const generation = ++this.generation;

    let request: { uri: string; protocols: string[] };
    try {
      const uri = await this.getUri({ tokenRejected: this.tokenRejected });
      // Superseded while the token was being minted. Returning here — before a
      // `WebSocket` exists — is what keeps the orphan from being created in the
      // first place; there is nothing left to abandon or to close.
      if (!this.isCurrent(generation)) return;
      request = buildWhiteboardWebSocketRequest(uri, this.query);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(request.uri, request.protocols);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      if (!this.isCurrent(generation)) return;
      this.setStatus("online");
    };

    socket.onmessage = (event) => {
      if (!this.isCurrent(generation)) return;
      let parsed: object;
      try {
        parsed = JSON.parse(event.data.toString()) as object;
      } catch {
        // A dropped sync patch cannot be recovered on the same connection: all
        // later diffs are relative to state the client never applied. Retire the
        // socket so the replacement performs a full protocol rehydration.
        this.retireSocket(socket, generation);
        return;
      }
      // Listener failures are application failures, not malformed wire data,
      // so a healthy socket is kept: retiring it would turn a deterministic
      // client bug into reconnect churn. The exception is the handshake. A
      // client that failed to apply `connect` never joins the room yet looks
      // online (pings still answer), so it reconnects, with backoff.
      const isHandshake = (parsed as { type?: unknown }).type === "connect";
      let handshakeFailed = false;
      for (const listener of this.messageListeners) {
        try {
          listener(parsed);
        } catch (error) {
          // Subscribers are independent projections of the same protocol
          // frame. One faulty projection must not prevent the others from
          // advancing to the new sync state.
          console.error("Whiteboard socket message listener failed:", error);
          if (isHandshake) handshakeFailed = true;
        }
      }
      if (handshakeFailed) {
        this.retireSocket(socket, generation);
        return;
      }
      // A 101 upgrade is not proof that admission succeeded: rejected sockets
      // also open before the server closes them with a sync error. Reset
      // backoff only once a real protocol message has been applied.
      this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
      this.tokenRejected = false;
    };

    socket.onerror = () => {
      if (!this.isCurrent(generation)) return;
      this.retireSocket(socket, generation);
    };

    socket.onclose = (event) => {
      if (!this.isCurrent(generation)) return;
      this.handleDisconnect(
        event.code === TLSyncErrorCloseEventCode
          ? event.reason || TLSyncErrorCloseEventReason.UNKNOWN_ERROR
          : null,
      );
    };
  }

  /**
   * Close `socket` and report offline, but leave the reconnect to the socket's
   * own `close` event.
   *
   * A CLOSING socket is still OPEN as far as the server is concerned, so
   * treating `close()` as completed teardown starts the replacement while the
   * old one still holds a slot — the two then race for the same
   * MAX_CONNECTIONS_PER_USER budget and the client falls into a
   * 1006 → reconnect → 1008 loop. `handleDisconnect` runs once the handshake
   * lands; the grace timer covers a handshake that never does.
   */
  private retireSocket(socket: WebSocket, generation = this.generation): void {
    closeQuietly(socket);
    this.setStatus("offline");
    this.scheduleCloseGrace(generation);
  }

  private scheduleCloseGrace(generation: number): void {
    if (this.closeGraceTimer) return;
    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = null;
      if (!this.isCurrent(generation)) return;
      this.handleDisconnect(TLSyncErrorCloseEventReason.UNKNOWN_ERROR);
    }, CLOSE_HANDSHAKE_GRACE_MS);
  }

  private handleDisconnect(errorReason: string | null): void {
    this.clearCloseGraceTimer();
    // Retire this generation so the socket's own late events — the `close` that
    // follows the grace timer, or a duplicated `error` — cannot run teardown a
    // second time against whatever connection has since taken its place.
    this.generation++;
    this.ws = null;
    // Sticky until the server accepts a socket: a mint that fails still leaves
    // the held token stale for the attempt after it.
    if (errorReason === TLSyncErrorCloseEventReason.NOT_AUTHENTICATED) this.tokenRejected = true;
    // A non-sync close (null reason, e.g. a raw TCP drop) or a transient sync
    // error (bad token, brief backend outage) is recoverable: drop to `offline`
    // so tldraw keeps the sync client alive and we reconnect with a fresh URI.
    // Only a fatal sync reason (FORBIDDEN, CLIENT_TOO_OLD, …) goes terminal.
    // ROOM_FULL remains recoverable for compatibility with an older sync host.
    if (errorReason && !isTransientSyncErrorReason(errorReason)) {
      this.setStatus("error", errorReason);
      // Terminal: do not schedule a reconnect.
      return;
    }
    this.setStatus("offline");
    this.scheduleReconnect();
  }

  private failTerminal(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.clearReconnectTimer();
    this.clearCloseGraceTimer();
    closeQuietly(this.ws);
    this.ws = null;
    this.setStatus("error", reason);
  }

  private setStatus(status: TLPersistentClientSocket["connectionStatus"], reason?: string): void {
    if (this.connectionStatusValue === status && status !== "error") return;
    this.connectionStatusValue = status;
    this.statusListeners.forEach((cb) => {
      cb(status === "error" ? { status, reason: reason ?? TLSyncErrorCloseEventReason.UNKNOWN_ERROR } : { status });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const ceiling = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, Math.round(ceiling * 1.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, jitterReconnectDelayMs(ceiling));
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearCloseGraceTimer(): void {
    if (!this.closeGraceTimer) return;
    clearTimeout(this.closeGraceTimer);
    this.closeGraceTimer = null;
  }
}

function closeQuietly(socket: WebSocket | null): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // The socket may already be transitioning to CLOSED.
  }
}
