import { describe, expect, it } from "vitest";
import { RoomEditRequests } from "./room-edit-requests.ts";
import type { LiveConnection } from "./room-connections.ts";
import type { SessionMeta } from "./room-types.ts";

function connection(userId: string, options: { manager?: boolean; editor?: boolean } = {}): LiveConnection {
  const meta = {
    userId,
    userName: userId,
    grantPrincipalKey: `principal-${userId}`,
    connectionId: `conn-${userId}`,
    writesSuspended: false,
    capabilities: {
      canManageWhiteboard: options.manager ?? false,
      canEditWhiteboard: options.editor ?? false,
      canControlSurface: false,
    },
  } as unknown as SessionMeta;
  return { tldrawSessionId: `session-${userId}`, meta };
}

function setup(initial: LiveConnection[]) {
  let live = initial;
  const requests = new RoomEditRequests({
    liveConnections: () => live,
    isBaseManager: (meta) => !meta.writesSuspended && meta.capabilities.canManageWhiteboard,
    canEditWhiteboardForMeta: (meta) =>
      !meta.writesSuspended && (meta.capabilities.canManageWhiteboard || meta.capabilities.canEditWhiteboard),
    canManageWhiteboard: (userId) => live.some(({ meta }) => meta.userId === userId && meta.capabilities.canManageWhiteboard),
    sendCustomMessage: () => {},
    broadcastState: () => {},
    refreshAuthority: () => {},
  });
  return {
    requests,
    setLive: (next: LiveConnection[]) => {
      live = next;
    },
  };
}

describe("RoomEditRequests", () => {
  const host = connection("host", { manager: true });
  const guest = connection("guest");

  it("lists a request while its requester is here and cannot edit", () => {
    const t = setup([host, guest]);
    expect(t.requests.request(guest.meta.grantPrincipalKey, "guest", "Guest")).toMatchObject({ status: "pending" });
    expect(t.requests.list().map((request) => request.principalKey)).toEqual([guest.meta.grantPrincipalKey]);
  });

  it("drops a request once its requester leaves the board", () => {
    const t = setup([host, guest]);
    t.requests.request(guest.meta.grantPrincipalKey, "guest", "Guest");

    t.setLive([host]);

    expect(t.requests.list()).toEqual([]);
  });

  it("drops a request once its requester can edit without it being resolved", () => {
    const t = setup([host, guest]);
    t.requests.request(guest.meta.grantPrincipalKey, "guest", "Guest");

    t.setLive([host, connection("guest", { editor: true })]);

    expect(t.requests.list()).toEqual([]);
  });

  it("gives back the slots of requesters who left", () => {
    const guests = Array.from({ length: 100 }, (_, index) => connection(`guest${index}`));
    const t = setup([host, ...guests]);
    for (const { meta } of guests) t.requests.request(meta.grantPrincipalKey, meta.userId, meta.userName);

    const latecomer = connection("latecomer");
    t.setLive([host, latecomer]);

    expect(t.requests.request(latecomer.meta.grantPrincipalKey, "latecomer", "Latecomer")).toMatchObject({
      status: "pending",
    });
  });
});
