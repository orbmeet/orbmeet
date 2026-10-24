import { describe, expect, it } from "vitest";
import { buildWhiteboardStateMessages } from "./room-state-broadcast.ts";
import type { LiveConnection } from "./room-connections.ts";
import type { SessionMeta } from "./room-types.ts";

function meta(
  userId: string,
  userName: string,
  canManageWhiteboard = false,
): SessionMeta {
  return {
    userId,
    userName,
    role: "participant",
    capabilities: {
      canEditWhiteboard: canManageWhiteboard,
      canControlSurface: canManageWhiteboard,
      canManageWhiteboard,
    },
    grantPrincipal: { type: "user", id: userId },
    grantPrincipalKey: `user:${userId}`,
    writesSuspended: false,
    whiteboardRoomId: "meet-state-test",
    connectionId: `${userId}-connection`,
    connectedReadonly: !canManageWhiteboard,
  };
}

describe("buildWhiteboardStateMessages", () => {
  it("sends management-only data only to explicit managers", () => {
    const sessions: LiveConnection[] = [
      { tldrawSessionId: "host-session", meta: meta("host", "Host", true) },
      { tldrawSessionId: "acting-session", meta: meta("acting", "Acting") },
      { tldrawSessionId: "viewer-session", meta: meta("viewer", "Viewer") },
    ];

    const messages = buildWhiteboardStateMessages({
      sessions,
      editorPrincipalKeys: ["user:acting"],
      pendingEditorRequests: [{
        principalKey: "user:viewer",
        userId: "viewer",
        userName: "Viewer",
      }],
      roomSizeLimited: false,
      navigationControllerUserId: "acting",
      navigationControllerName: "Acting",
      isBaseManager: (sessionMeta) => sessionMeta.capabilities.canManageWhiteboard,
      canEditWhiteboardForMeta: (sessionMeta) =>
        sessionMeta.capabilities.canEditWhiteboard ||
        sessionMeta.grantPrincipalKey === "user:acting",
      includeConnectedUsersForSession: () => true,
    });

    const bySession = new Map(messages.map((message) => [message.tldrawSessionId, message.state]));

    expect(bySession.get("host-session")).toMatchObject({
      editorUserIds: ["host", "acting"],
      roomSizeLimited: false,
      pendingEditorRequests: [{
        principalKey: "user:viewer",
        userId: "viewer",
        userName: "Viewer",
      }],
      canEditWhiteboard: true,
      editAccessRequestPending: false,
      // Who can write already, and their grant principal for whoever cannot:
      // handing the board to them grants it first.
      connectedUsers: [
        { userId: "host", userName: "Host", principalKey: "user:host", canEdit: true },
        { userId: "acting", userName: "Acting", principalKey: "user:acting", canEdit: true },
        { userId: "viewer", userName: "Viewer", principalKey: "user:viewer", canEdit: false },
      ],
    });
    expect(bySession.get("host-session")).toMatchObject({
      editorPrincipalKeys: ["user:acting"],
    });
    expect(bySession.get("acting-session")).toMatchObject({
      pendingEditorRequests: [],
      connectedUsers: [],
      canEditWhiteboard: true,
      editAccessRequestPending: false,
    });
    expect(bySession.get("viewer-session")).toMatchObject({
      pendingEditorRequests: [],
      connectedUsers: [],
      canEditWhiteboard: false,
      editAccessRequestPending: true,
    });

    // Grant principal keys encode internal identity (guest admission ids) and
    // only the manager UI reads them, so non-managers get an empty list.
    expect(bySession.get("acting-session")).toMatchObject({ editorPrincipalKeys: [] });
    expect(bySession.get("viewer-session")).toMatchObject({ editorPrincipalKeys: [] });

    // The non-manager lists must survive serialization. `undefined` is dropped by
    // JSON.stringify, so a demoted manager would never receive a frame that
    // clears the lists it was sent while it still had the role.
    const onWire = JSON.parse(JSON.stringify(bySession.get("acting-session")));
    expect(onWire.connectedUsers).toEqual([]);
    expect(onWire.editorPrincipalKeys).toEqual([]);
  });

  it("omits the full participant roster after a manager has received it", () => {
    const [message] = buildWhiteboardStateMessages({
      sessions: [{ tldrawSessionId: "host-session", meta: meta("host", "Host", true) }],
      editorPrincipalKeys: [],
      pendingEditorRequests: [],
      roomSizeLimited: false,
      navigationControllerUserId: null,
      navigationControllerName: null,
      isBaseManager: () => true,
      canEditWhiteboardForMeta: () => true,
      includeConnectedUsersForSession: () => false,
    });
    expect(message.state).not.toHaveProperty("connectedUsers");
  });

  it("consults the roster predicate for non-manager sessions so it can prune them", () => {
    const seen: string[] = [];
    buildWhiteboardStateMessages({
      sessions: [
        { tldrawSessionId: "host-session", meta: meta("host", "Host", true) },
        { tldrawSessionId: "viewer-session", meta: meta("viewer", "Viewer", false) },
      ],
      editorPrincipalKeys: [],
      pendingEditorRequests: [],
      roomSizeLimited: false,
      navigationControllerUserId: null,
      navigationControllerName: null,
      isBaseManager: (sessionMeta) => sessionMeta.capabilities.canManageWhiteboard,
      canEditWhiteboardForMeta: () => true,
      includeConnectedUsersForSession: (tldrawSessionId) => {
        seen.push(tldrawSessionId);
        return true;
      },
    });

    // The room's implementation forgets a session's roster state in this
    // callback. Calling it only for managers would strand a demoted session as
    // "already has the roster" and starve it after re-promotion.
    expect(seen).toEqual(["host-session", "viewer-session"]);
  });
});
