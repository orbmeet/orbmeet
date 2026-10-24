import type { PendingEditorRequest as PendingWhiteboardEditorRequest } from "@orbmeet/whiteboard-core/sync-commands";
import type { SessionMeta } from "./room-types.ts";
import type { LiveConnection } from "./room-connections.ts";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import type {
  ConnectedWhiteboardUserPayload,
  WhiteboardStateMessage,
} from "@orbmeet/whiteboard-core/room-messages";

interface BuildWhiteboardStateMessagesInput {
  sessions: LiveConnection[];
  editorPrincipalKeys: string[];
  pendingEditorRequests: PendingWhiteboardEditorRequest[];
  roomSizeLimited: boolean;
  navigationControllerUserId: string | null;
  navigationControllerName: string | null;
  isBaseManager: (meta: Pick<SessionMeta, "capabilities" | "writesSuspended">) => boolean;
  canEditWhiteboardForMeta: (meta: SessionMeta) => boolean;
  includeConnectedUsersForSession: (tldrawSessionId: string, meta: SessionMeta) => boolean;
}

export function buildWhiteboardStateMessages({
  sessions,
  editorPrincipalKeys,
  pendingEditorRequests,
  roomSizeLimited,
  navigationControllerUserId,
  navigationControllerName,
  isBaseManager,
  canEditWhiteboardForMeta,
  includeConnectedUsersForSession,
}: BuildWhiteboardStateMessagesInput): {
  tldrawSessionId: string;
  state: WhiteboardStateMessage;
}[] {
  const allEditorUserIds = [
    ...new Set(
      sessions
        .filter(({ meta }) => canEditWhiteboardForMeta(meta))
        .map(({ meta }) => meta.userId),
    ),
  ];

  // Deduplicated connected-user list sent only to managers so they can hand off
  // navigation control without leaking extra participant data to every viewer.
  const connectedUsersMap = new Map<string, ConnectedWhiteboardUserPayload>();
  for (const { meta } of sessions) {
    const canEdit = canEditWhiteboardForMeta(meta);
    const known = connectedUsersMap.get(meta.userId);
    if (!known) {
      connectedUsersMap.set(meta.userId, {
        userId: meta.userId,
        userName: meta.userName,
        principalKey: meta.grantPrincipalKey,
        canEdit,
      });
    } else if (canEdit && !known.canEdit) {
      // Any one of their connections that can write is enough to hand off to.
      connectedUsersMap.set(meta.userId, { ...known, canEdit, principalKey: meta.grantPrincipalKey });
    }
  }
  const connectedUsers = [...connectedUsersMap.values()];

  return sessions.map(({ tldrawSessionId, meta }) => {
    const isManager = isBaseManager(meta);
    // Called for every session, manager or not: the callback also prunes its
    // per-session bookkeeping, and skipping it for non-managers would leave a
    // demoted session marked as already holding the roster.
    const includeRoster = includeConnectedUsersForSession(tldrawSessionId, meta);
    const editAccessRequestPending = pendingEditorRequests.some(
      (request) => request.principalKey === meta.grantPrincipalKey,
    );

    return {
      tldrawSessionId,
      state: {
        type: WHITEBOARD_EVENTS.STATE,
        editorUserIds: allEditorUserIds,
        // Grant principal keys are an internal identity (they encode guest
        // admission ids), and nothing outside the manager UI reads them. Same
        // treatment as pendingEditorRequests/connectedUsers below: empty rather
        // than absent, so a demoted manager receives a frame that clears them.
        editorPrincipalKeys: isManager ? editorPrincipalKeys : [],
        canEditWhiteboard: canEditWhiteboardForMeta(meta),
        editAccessRequestPending,
        pendingEditorRequests: isManager ? pendingEditorRequests : [],
        editorCount: editorPrincipalKeys.length,
        roomSizeLimited,
        navigationControllerUserId,
        navigationControllerName,
        // Empty, not undefined: JSON.stringify drops undefined keys, so a
        // demoted manager would never receive a frame that clears the list it
        // was last sent and would keep showing it in the hand-off UI.
        ...(isManager
          ? (includeRoster ? { connectedUsers } : {})
          : { connectedUsers: [] }),
      },
    };
  });
}
