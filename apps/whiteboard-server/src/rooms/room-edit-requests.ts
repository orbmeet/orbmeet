import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import {
  syncCommandFailure,
  type PendingEditorRequest,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import type { LiveConnection } from "./room-connections.ts";
import type { SessionMeta } from "./room-types.ts";

const MAX_PENDING_REQUESTS = 100;
const MAX_USER_NAME_LENGTH = 256;

function normalizeAccessRequestUserName(userName: string): string {
  const stripped = userName.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return stripped.slice(0, MAX_USER_NAME_LENGTH) || "Anonymous";
}

export interface RoomEditRequestHost {
  liveConnections(): LiveConnection[];
  isBaseManager(meta: Pick<SessionMeta, "capabilities" | "writesSuspended">): boolean;
  canEditWhiteboardForMeta(meta: SessionMeta): boolean;
  canManageWhiteboard(userId: string): boolean;
  sendCustomMessage(tldrawSessionId: string, data: RoomMessage): void;
  broadcastState(): void;
  /** Re-read authority now: a grant made the requester's claims stale. */
  refreshAuthority(): void;
}

/**
 * The live "may I edit?" conversation.
 *
 * Pending requests are ephemeral collaboration state and belong to the room.
 * The grant itself does not: the Worker records it in D1, then tells the room,
 * and the requester's socket picks it up by reconnecting with a token that
 * carries it.
 */
export class RoomEditRequests {
  private readonly pending = new Map<string, PendingEditorRequest>();

  private readonly host: RoomEditRequestHost;

  constructor(host: RoomEditRequestHost) {
    this.host = host;
  }

  /** The requests still waiting on a manager (see `prune`). */
  list(): PendingEditorRequest[] {
    this.prune();
    return [...this.pending.values()];
  }

  request(
    principalKey: string,
    userId: string,
    userName: string | null,
  ): SyncCommandResult<"editRequest"> {
    this.prune();
    const sessions = this.host.liveConnections().filter(
      ({ meta }) => meta.grantPrincipalKey === principalKey,
    );
    if (sessions.length === 0) return syncCommandFailure("not_found", "User is not connected");

    if (sessions.some(({ meta }) => this.host.canEditWhiteboardForMeta(meta))) {
      this.notify(principalKey, { type: WHITEBOARD_EVENTS.ACCESS_GRANTED });
      return { ok: true, status: "already_approved" };
    }
    if (this.pending.has(principalKey)) return { ok: true, status: "already_pending" };
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return syncCommandFailure("rate_limited", "Too many pending requests");
    }

    const displayName = normalizeAccessRequestUserName(userName || sessions[0].meta.userName);
    this.pending.set(principalKey, { principalKey, userId, userName: displayName });
    this.host.broadcastState();

    const managers = this.host.liveConnections().filter(({ meta }) => this.host.isBaseManager(meta));
    if (managers.length === 0) return { ok: true, status: "pending_no_host" };
    for (const { tldrawSessionId } of managers) {
      this.host.sendCustomMessage(tldrawSessionId, {
        type: WHITEBOARD_EVENTS.ACCESS_REQUESTED,
        principalKey,
        userId,
        userName: displayName,
      });
    }
    return { ok: true, status: "pending" };
  }

  resolve(
    principalKey: string,
    approverId: string,
    outcome: "approved" | "denied",
  ): SyncCommandResult<"editResolve"> {
    if (!this.host.canManageWhiteboard(approverId)) {
      return syncCommandFailure("forbidden", "Only whiteboard managers can resolve edit requests");
    }
    if (outcome === "denied") {
      // Deny answers an outstanding request only; an existing editor is revoked instead.
      if (!this.pending.delete(principalKey)) {
        return syncCommandFailure("not_found", "No pending request for that participant");
      }
      this.notify(principalKey, { type: WHITEBOARD_EVENTS.ACCESS_DENIED, reason: "host_denied" });
      this.host.broadcastState();
      return { ok: true, status: "denied" };
    }

    this.pending.delete(principalKey);
    this.notify(principalKey, { type: WHITEBOARD_EVENTS.ACCESS_GRANTED });
    this.host.broadcastState();
    // The grant is in D1 now; the requester's claims are stale, so the fresh
    // verdict reconnects them with edit access.
    this.host.refreshAuthority();
    return { ok: true, status: "approved" };
  }

  clear(): void {
    this.pending.clear();
  }

  /**
   * Drop every request nobody is waiting on any more: its requester has left
   * the board, or can already edit (a grant made outside `resolve`, from the
   * participant list say). Otherwise managers are shown requests from people
   * who are gone or already editing, and the `MAX_PENDING_REQUESTS` slots they
   * hold are never given back while the room stays open.
   */
  private prune(): void {
    if (this.pending.size === 0) return;
    const waiting = new Set<string>();
    const editing = new Set<string>();
    for (const { meta } of this.host.liveConnections()) {
      waiting.add(meta.grantPrincipalKey);
      if (this.host.canEditWhiteboardForMeta(meta)) editing.add(meta.grantPrincipalKey);
    }
    for (const principalKey of this.pending.keys()) {
      if (!waiting.has(principalKey) || editing.has(principalKey)) this.pending.delete(principalKey);
    }
  }

  private notify(principalKey: string, data: RoomMessage): void {
    for (const { tldrawSessionId, meta } of this.host.liveConnections()) {
      if (meta.grantPrincipalKey === principalKey) this.host.sendCustomMessage(tldrawSessionId, data);
    }
  }
}
