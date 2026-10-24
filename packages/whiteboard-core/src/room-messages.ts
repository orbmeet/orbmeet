import { ASSISTANT_EVENTS, type AssistantEvent } from "./assistant/protocol.ts";
import { WHITEBOARD_EVENTS } from "./protocol.ts";
import type { PendingEditorRequest } from "./sync-commands.ts";

// Every message a room sends a browser outside tldraw's own sync protocol, as
// one union. The room sends nothing that is not a `RoomMessage`, and the board
// reads them through one channel (`whiteboard-client`'s `RoomChannel`), so a
// message added here is the whole of adding one: the compiler then names every
// sender and every reader that has to agree on it.

/**
 * Someone on the board, as a manager's hand-off menu sees them: whether they
 * can write yet decides whether handing them the board also grants them
 * edit access, which takes their grant principal.
 */
export interface ConnectedWhiteboardUserPayload {
  userId: string;
  userName: string;
  principalKey: string;
  canEdit: boolean;
}

/** The room as one session sees it; each session is sent its own. */
export interface WhiteboardStateMessage {
  type: typeof WHITEBOARD_EVENTS.STATE;
  editorUserIds: string[];
  editorPrincipalKeys: string[];
  canEditWhiteboard: boolean;
  editAccessRequestPending: boolean;
  pendingEditorRequests: PendingEditorRequest[];
  editorCount: number;
  roomSizeLimited: boolean;
  navigationControllerUserId: string | null;
  navigationControllerName: string | null;
  connectedUsers?: ConnectedWhiteboardUserPayload[];
}

export type RoomMessage =
  | WhiteboardStateMessage
  /** To managers: someone asked to edit. */
  | { type: typeof WHITEBOARD_EVENTS.ACCESS_REQUESTED; principalKey: string; userId: string; userName: string }
  /** To the requester's sessions. */
  | { type: typeof WHITEBOARD_EVENTS.ACCESS_GRANTED }
  | { type: typeof WHITEBOARD_EVENTS.ACCESS_DENIED; reason: "host_denied" }
  /** To the session whose write the room refused for size. */
  | { type: typeof WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT; maxBytes: number }
  | { type: typeof WHITEBOARD_EVENTS.ROOM_SIZE_RECOVERED; maxBytes: number }
  /**
   * To one session: the room dropped a presence update of its, so what peers
   * hold of its presence is no longer what it last sent. Its next presence
   * update is forwarded whole, which puts them back in step; the session
   * makes one now (see `presence-activity`).
   */
  | { type: typeof WHITEBOARD_EVENTS.PRESENCE_RESYNC }
  | AssistantEvent;

export type RoomMessageType = RoomMessage["type"];
export type RoomMessageOf<T extends RoomMessageType> = Extract<RoomMessage, { type: T }>;

const ROOM_MESSAGE_TYPES: ReadonlySet<string> = new Set<RoomMessageType>([
  ...Object.values(WHITEBOARD_EVENTS),
  ...Object.values(ASSISTANT_EVENTS),
]);

/**
 * A message off the wire, if it is one the room sends.
 *
 * Only the discriminant is checked. The fields come from the room, and each
 * reader already normalizes what it reads (an access request through its own
 * check, an assistant snapshot through its guard), so a second, divergent
 * validation here would only drift from those.
 */
export function readRoomMessage(data: unknown): RoomMessage | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && ROOM_MESSAGE_TYPES.has(type) ? (data as RoomMessage) : null;
}
