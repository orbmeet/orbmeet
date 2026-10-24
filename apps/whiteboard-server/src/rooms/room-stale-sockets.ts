import type { TLRecord } from "@tldraw/tlschema";
import type { TLSocketRoom } from "@tldraw/sync-core";
import type { SessionMeta, TldrawSocket } from "./room-types.ts";
import { logInfo } from "../lib/log.ts";

type EvictStaleSocketsOptions = {
  activeSockets: Map<string, TldrawSocket>;
  room: TLSocketRoom<TLRecord, SessionMeta>;
  meetingId: string;
  sessionMetaIndex: Map<string, SessionMeta>;
  onSessionEvicted: (tldrawSessionId: string, meta: SessionMeta | undefined) => void;
  userId: string;
};

export function evictStaleUserSockets({
  activeSockets,
  room,
  meetingId,
  sessionMetaIndex,
  onSessionEvicted,
  userId,
}: EvictStaleSocketsOptions): number {
  const staleSessionIds: string[] = [];
  // Socket ownership is immediate; tldraw's session projection can lag the
  // connect handshake. Scan the authoritative socket map so a dead pre-session
  // socket cannot keep consuming a per-user slot forever.
  for (const [sessionId, socket] of activeSockets) {
    if (socket.readyState === 1) continue;
    if (sessionMetaIndex.get(sessionId)?.userId !== userId) continue;
    staleSessionIds.push(sessionId);
  }

  for (const tldrawSessionId of staleSessionIds) {
    const staleSocket = activeSockets.get(tldrawSessionId);
    const staleMeta = sessionMetaIndex.get(tldrawSessionId);
    logInfo(
      `[Room ${meetingId}] Evicting stale socket for ${userId} (readyState=${staleSocket?.readyState ?? "missing"}) before reconnect`,
    );
    activeSockets.delete(tldrawSessionId);
    sessionMetaIndex.delete(tldrawSessionId);
    // The delayed real close event for this dead socket will skip the
    // per-session cleanup in Room.handleClose (its stored===ws guard no longer
    // matches), so the assembler must be removed here or it leaks for the
    // room's lifetime.
    onSessionEvicted(tldrawSessionId, staleMeta);
    try {
      room.handleSocketClose(tldrawSessionId);
    } catch {
      // Session may already be removed from tldraw - safe to ignore.
    }
  }

  return staleSessionIds.length;
}
