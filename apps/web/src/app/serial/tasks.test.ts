import { describe, expect, it } from "vitest";
import { scopeOf, type SerialTask } from "./tasks";

describe("scopeOf", () => {
  it("queues every change to one Organization's seats, and its checkout, together", () => {
    const scopes = new Set([
      scopeOf({ kind: "addOrganizationMember", organizationId: "org_1", actorUserId: "u", email: "e", role: "member" }),
      scopeOf({ kind: "removeOrganizationMember", organizationId: "org_1", actorUserId: "u", memberUserId: "m" }),
      scopeOf({ kind: "syncOrganizationSeats", organizationId: "org_1" }),
      scopeOf({
        kind: "prepareCheckout",
        customer: { kind: "organization", organizationId: "org_1" },
        actorUserId: "u",
        customerIpAddress: null,
      }),
    ]);
    expect([...scopes]).toEqual(["organization:org_1"]);
  });

  it("queues a board's lifecycle, its copies and its purge together", () => {
    const scopes = new Set([
      scopeOf({ kind: "archiveWhiteboard", whiteboardId: "wb_1", actorUserId: "u" }),
      scopeOf({ kind: "duplicateWhiteboard", whiteboardId: "wb_1", userId: "u" }),
      scopeOf({ kind: "purgeSpaceWhiteboard", spaceId: "s", whiteboardId: "wb_1", r2Operations: 1 }),
      scopeOf({
        kind: "restoreWhiteboardContent",
        board: { id: "wb_1", spaceId: "s", syncRoomId: "wb_1" },
        job: {} as Extract<SerialTask, { kind: "restoreWhiteboardContent" }>["job"],
      }),
    ]);
    expect([...scopes]).toEqual(["whiteboard:wb_1"]);
  });

  it("keeps different things in different queues", () => {
    expect(scopeOf({ kind: "archiveWhiteboard", whiteboardId: "wb_1", actorUserId: "u" }))
      .not.toBe(scopeOf({ kind: "archiveWhiteboard", whiteboardId: "wb_2", actorUserId: "u" }));
    expect(scopeOf({
      kind: "prepareCheckout",
      customer: { kind: "user", userId: "org_1" },
      actorUserId: "org_1",
      customerIpAddress: null,
    }))
      .not.toBe(scopeOf({ kind: "removeOrganizationMember", organizationId: "org_1", actorUserId: "u", memberUserId: "m" }));
  });
});
