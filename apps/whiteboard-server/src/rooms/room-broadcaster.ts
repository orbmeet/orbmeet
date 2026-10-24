import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import { buildWhiteboardStateMessages } from "./room-state-broadcast.ts";
import type { PendingEditorRequest as PendingWhiteboardEditorRequest } from "@orbmeet/whiteboard-core/sync-commands";
import type { LiveConnection } from "./room-connections.ts";
import type { SessionMeta } from "./room-types.ts";

/** Room-wide delivery of the room's own messages. */
export interface RoomBroadcasterHost {
  whiteboardRoomId: string;
  liveConnections(): LiveConnection[];
  /** Deliver to one session if its socket is still open. */
  sendToSession(tldrawSessionId: string, data: RoomMessage): void;
  /**
   * The room's authority policy. `isBaseManager` reads only the admission
   * capability snapshot, so it deliberately accepts the narrow projection.
   */
  authority: {
    isBaseManager(meta: Pick<SessionMeta, "capabilities" | "writesSuspended">): boolean;
    canEditWhiteboardForMeta(meta: SessionMeta): boolean;
  };
  /** Everything the whiteboard-state frame needs, read at broadcast time. */
  collectStateInputs(): {
    editorPrincipalKeys: string[];
    pendingEditorRequests: PendingWhiteboardEditorRequest[];
    roomSizeLimited: boolean;
    navigationControllerUserId: string | null;
    navigationControllerName: string | null;
  };
}

export class RoomBroadcaster {
  // A session that is not (or is no longer) a manager is sent an empty roster,
  // so it no longer holds one. Forgetting that is what lets a re-promoted
  // manager receive the full roster again on the next broadcast instead of
  // being stuck with the empty list it was sent while demoted.
  private managerSessionsWithRoster = new Set<string>();

  private readonly host: RoomBroadcasterHost;

  constructor(host: RoomBroadcasterHost) {
    this.host = host;
  }

  // ── delivery ───────────────────────────────────────────────────────────

  broadcastToLiveConnections(data: RoomMessage): void {
    for (const { tldrawSessionId } of this.host.liveConnections()) {
      this.host.sendToSession(tldrawSessionId, data);
    }
  }

  /**
   * Deliver a room-wide custom message to every live connection.
   *
   * The audience comes from the live socket map, like every authority decision
   * in this room. Iterating tldraw's getSessions() instead is wrong in both
   * directions: it holds a closed SDK session for ~5s — which
   * sendCustomMessageIfConnected does filter — and it does not yet list a
   * connection that has just opened, which nothing downstream can repair. A
   * participant who joined moments ago simply never received the message.
   */

  broadcastWhiteboardState(connectionsChanged = false): void {
    const sessions = this.host.liveConnections();
    if (connectionsChanged) this.managerSessionsWithRoster.clear();
    const inputs = this.host.collectStateInputs();
    const messages = buildWhiteboardStateMessages({
      sessions,
      editorPrincipalKeys: inputs.editorPrincipalKeys,
      pendingEditorRequests: inputs.pendingEditorRequests,
      roomSizeLimited: inputs.roomSizeLimited,
      navigationControllerUserId: inputs.navigationControllerUserId,
      navigationControllerName: inputs.navigationControllerName,
      isBaseManager: (meta) => this.host.authority.isBaseManager(meta),
      canEditWhiteboardForMeta: (meta) => this.host.authority.canEditWhiteboardForMeta(meta),
      includeConnectedUsersForSession: (tldrawSessionId, meta) => {
        if (!this.host.authority.isBaseManager(meta)) {
          this.managerSessionsWithRoster.delete(tldrawSessionId);
          return true;
        }
        if (this.managerSessionsWithRoster.has(tldrawSessionId)) return false;
        this.managerSessionsWithRoster.add(tldrawSessionId);
        return true;
      },
    });

    for (const { tldrawSessionId, state } of messages) {
      this.host.sendToSession(tldrawSessionId, state);
    }
  }
}
