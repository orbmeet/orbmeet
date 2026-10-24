import type { WhiteboardCapabilities, WhiteboardRole } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { WhiteboardGrantPrincipal } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

export interface SessionMeta {
  userId: string;
  userName: string;
  role: WhiteboardRole;
  capabilities: WhiteboardCapabilities;
  grantPrincipal: WhiteboardGrantPrincipal;
  grantPrincipalKey: string;
  whiteboardRoomId: WhiteboardRoomId;
  connectionId: string;
  service?: string;
  documentId?: string;
  /**
   * Set when the Worker has just narrowed this principal's authority in D1 and
   * the room is waiting for the fresh verdict. Writes are refused until the
   * verdict either confirms the session (`active`) or replaces it (`refresh`).
   */
  writesSuspended: boolean;
  // The readonly state the tldraw session was created with at connect time.
  // Any authority change reconnects the socket with a fresh token, so this
  // always reflects the live tldraw session's readonly flag — letting the
  // mutation guard tell a genuine viewer (tldraw drops its writes natively)
  // apart from a still-writable session whose writes are suspended.
  connectedReadonly: boolean;
}

/** Who a WebSocket was admitted as: the verified claims of its token. */
export interface SocketSession {
  tldrawSessionId: string;
  userId: string;
  userName: string;
  role: WhiteboardRole;
  capabilities: WhiteboardCapabilities;
  grantPrincipal: WhiteboardGrantPrincipal;
  whiteboardRoomId: WhiteboardRoomId;
  connectionId: string;
  service?: string;
  documentId?: string;
  /** The board generation the token was minted for; absent from tokens minted before boards moved. */
  generation?: number;
  tokenExpiresAt?: number;
  tokenIssuedAt?: number;
}

/**
 * The socket a room and tldraw hold. Deliberately not a whole WebSocket:
 * tldraw subscribes to any socket offering `addEventListener`, and every
 * message must reach the room through `Room.handleMessage` and its guards.
 */
export interface TldrawSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}
