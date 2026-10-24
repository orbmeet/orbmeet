import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { WHITEBOARD_SYNC_ROUTES } from "@orbmeet/whiteboard-core/protocol";
import type { RoomManager, SocketSession } from "../rooms/room-manager.ts";
import type { Room } from "../rooms/room.ts";
import type { TldrawSocket } from "../rooms/room-types.ts";
import { SYNC_SUBPROTOCOL, type SocketAdmission, type WsFatalCloseReason } from "../http/socket-admission.ts";
import { Reply, refuseUpgrade } from "../http/reply.ts";
import { logError, logInfo, logWarn } from "../lib/log.ts";

/**
 * Every live socket is pinged this often, and one that has not answered the
 * previous ping (or sent anything) by the next is dropped: a dead peer is
 * noticed within two intervals.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Outgoing bytes a socket may have queued before the server gives up on it.
 * A client this far behind is not catching up; it resyncs when it reconnects,
 * which is cheaper than holding an unbounded backlog for it.
 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export interface WebSocketGatewayDeps {
  roomManager: RoomManager;
  isShuttingDown(): boolean;
  admit(req: IncomingMessage): Promise<SocketAdmission>;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * The WebSocket side of the server: upgrade requests in, sockets joined to
 * their rooms, and the liveness of every socket after that.
 *
 * Admission policy lives in `http/socket-admission.ts` and the per-session
 * state machine in `Room`; this owns the handshake and the socket's events.
 */
export function createWebSocketGateway({ roomManager, isShuttingDown, admit }: WebSocketGatewayDeps) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WHITEBOARD_CONFIG.MAX_CLIENT_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SYNC_SUBPROTOCOL) ? SYNC_SUBPROTOCOL : false),
  });

  const awaitingPong = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (awaitingPong.has(ws)) {
        ws.terminate();
        continue;
      }
      awaitingPong.add(ws);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  function closeAfterHandshake(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ): void {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  }

  function reject(req: IncomingMessage, socket: Duplex, head: Buffer, reason: WsFatalCloseReason): void {
    closeAfterHandshake(req, socket, head, TLSyncErrorCloseEventCode, reason);
  }

  function join(ws: WebSocket, room: Room, session: SocketSession): void {
    const { tldrawSessionId, whiteboardRoomId } = session;
    const socket: TldrawSocket = {
      send(data) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          logWarn(`[ws] dropping ${tldrawSessionId}: ${ws.bufferedAmount} bytes queued`);
          ws.terminate();
          return;
        }
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
      get readyState() {
        return ws.readyState;
      },
    };

    ws.on("pong", () => awaitingPong.delete(ws));
    ws.on("message", (data, isBinary) => {
      awaitingPong.delete(ws);
      // Never getOrCreate: a cleaned-up room must not be silently recreated by
      // a straggling message. Fenced like every write: once the server is
      // shutting down, or another process may own the data dir, messages are
      // refused and the client reconnects.
      const current = roomManager.getRoomIfExists(whiteboardRoomId);
      if (!current) {
        ws.close(1011, "Room no longer exists");
        return;
      }
      try {
        const bytes = toBuffer(data);
        current.handleMessage(tldrawSessionId, isBinary ? bytes : bytes.toString("utf8"));
      } catch (error) {
        logError("[ws] message: handler threw", error);
        ws.close(1011, "Server error");
      }
    });
    ws.on("close", (code, reason) => {
      const reasonText = reason.toString("utf8");
      logInfo("[ws] close:", tldrawSessionId, "code:", code, "reason:", reasonText);
      // Deliberately unfenced: teardown must run even while shutting down or
      // after the writer lock was lost, or the session state leaks instead.
      roomManager.getRoomForTeardown(whiteboardRoomId)?.handleClose(tldrawSessionId, code, socket, reasonText);
    });
    // `close` follows every error, and is where the session is released.
    ws.on("error", (error) => logWarn("[ws] error:", tldrawSessionId, error.message));

    logInfo("[ws] open:", session.userId, "room:", whiteboardRoomId);
    try {
      room.handleConnect(socket, session);
    } catch (error) {
      logError("[ws] open: handleConnect threw", error);
      ws.close(1011, "Server error");
    }
  }

  /** Decide an upgrade request and, if it is admitted, join its socket to the room. */
  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Until the handshake hands the socket to `ws`, a reset during admission
    // is ours to absorb.
    socket.on("error", () => socket.destroy());
    try {
      if (isShuttingDown()) return refuseUpgrade(socket, Reply.text("Service shutting down", 503));
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname !== WHITEBOARD_SYNC_ROUTES.connect) return refuseUpgrade(socket, Reply.text("Not found", 404));

      const admission = await admit(req);
      // The client gave up while its token was being checked.
      if (socket.destroyed) return;
      if (admission.type === "refused") return refuseUpgrade(socket, admission.reply);
      if (admission.type === "rejected") return reject(req, socket, head, admission.reason);
      const { session } = admission;
      // The board at the token's generation: what the node it moved from saved
      // is loaded first. A token from before the board moved on is sent back
      // for a fresh one, which names the node holding it now.
      const notReady = await roomManager.prepare(session.whiteboardRoomId, session.generation);
      if (socket.destroyed) return;
      if (notReady) {
        logWarn(`[ws] room not at generation ${session.generation}: ${notReady.message} sid=${session.whiteboardRoomId}`);
        return reject(
          req,
          socket,
          head,
          notReady.reason === "conflict"
            ? TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
            : notReady.reason === "not_found"
              ? TLSyncErrorCloseEventReason.FORBIDDEN
              : TLSyncErrorCloseEventReason.UNKNOWN_ERROR,
        );
      }
      if (isShuttingDown()) return closeAfterHandshake(req, socket, head, 1012, "server restarting");

      // From opening the room to the room owning the socket is one synchronous
      // turn (`handleUpgrade` calls back before it returns), so nothing can
      // close the room in between. A handshake that fails instead leaves the
      // room to its own idle reaper.
      let room: Room | null;
      try {
        room = roomManager.openRoomForSocket(session.whiteboardRoomId, session.documentId);
      } catch (error) {
        logWarn(`[ws] room admission failed sub=${session.userId} sid=${session.whiteboardRoomId}`, error);
        room = null;
      }
      if (!room) {
        logWarn(`[ws] room unavailable, rejecting connect sub=${session.userId} sid=${session.whiteboardRoomId}`);
        return reject(req, socket, head, TLSyncErrorCloseEventReason.UNKNOWN_ERROR);
      }
      const joined = room;
      wss.handleUpgrade(req, socket, head, (ws) => join(ws, joined, session));
    } catch (error) {
      logError("[ws] upgrade failed:", error);
      refuseUpgrade(socket, Reply.text("WebSocket upgrade failed", 500));
    }
  }

  return {
    handleUpgrade,
    /** Ask every client to reconnect elsewhere. */
    closeAll(code: number, reason: string): void {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(code, reason);
    },
    /** Drop whatever is still connected, without a closing handshake. */
    terminateAll(): void {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
