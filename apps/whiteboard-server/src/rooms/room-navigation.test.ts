import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as syncCore from "@tldraw/sync-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { ROOM_NAVIGATION_ID } from "@orbmeet/whiteboard-core/room-navigation";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createTestRoom } from "./room-test-support.ts";
import type { Room } from "./room.ts";
import type { SocketSession } from "./room-types.ts";

const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-navigation-"));
  dirs.push(dir);
  return dir;
}

function session(whiteboardRoomId: WhiteboardRoomId, userId: string, manager: boolean): SocketSession {
  return {
    tldrawSessionId: `${userId}:sess`,
    userId,
    userName: userId,
    role: "participant",
    capabilities: { canEditWhiteboard: true, canControlSurface: manager, canManageWhiteboard: manager },
    grantPrincipal: { type: "user", id: userId },
    whiteboardRoomId,
    connectionId: `conn-${userId}`,
  };
}

function connect(room: Room, data: SocketSession) {
  room.handleConnect({ readyState: 1, send: () => {}, close: () => {} }, data);
  room.handleMessage(data.tldrawSessionId, JSON.stringify({
    type: "connect",
    protocolVersion: getTlsyncProtocolVersion(),
    schema: whiteboardTLSchema.serialize(),
    connectRequestId: "c",
    lastServerClock: -1,
  }));
  let clientClock = 0;
  return (diff: Record<string, unknown>) => {
    clientClock += 1;
    room.handleMessage(data.tldrawSessionId, JSON.stringify({ type: "push", clientClock, diff }));
  };
}

const navigationOf = (room: Room) =>
  (room.document.currentSnapshot().documents as unknown as Array<{ state: { id: string } }>)
    .find(({ state }) => state.id === ROOM_NAVIGATION_ID)?.state;

describe("the room's navigation", () => {
  it("adopts the spotlight a room kept in its metadata, once, as the navigation record", () => {
    const roomId = "meet-legacy-spotlight" as WhiteboardRoomId;
    const dir = dataDir();
    const first = createTestRoom(roomId, dir);
    const { setMeta } = first.document.store;
    setMeta("spotlightPageId", "shape:page-2");
    setMeta("spotlightPageNumber", "2");
    setMeta("spotlightPageCount", "3");
    setMeta("spotlightRev", "7");
    setMeta("spotlightRect", JSON.stringify({ x: 0, y: 0, w: 1, h: 0.5 }));
    setMeta("spotlightPresenterId", "manager-1");
    setMeta("spotlightRoam", "true");
    first.close();

    const reopened = createTestRoom(roomId, dir);
    expect(navigationOf(reopened)).toEqual({
      id: ROOM_NAVIGATION_ID,
      typeName: "orbmeet_navigation",
      pageId: "shape:page-2",
      pageNumber: 2,
      presenterId: "manager-1",
      roam: true,
    });
    for (const key of ["spotlightPageId", "spotlightRev", "spotlightRect", "spotlightRoam"]) {
      expect(reopened.document.store.getMeta(key)).toBeNull();
    }
    reopened.close();
  });

  it("releases an absent controller once a manager's move lands, and not for a refused one", () => {
    const roomId = "meet-nav-release" as WhiteboardRoomId;
    const dir = dataDir();
    const first = createTestRoom(roomId, dir);
    connect(first, session(roomId, "manager-1", true));
    connect(first, session(roomId, "editor-1", false));
    expect(first.navigation.setController("editor-1", "manager-1")).toMatchObject({ ok: true });
    first.close();

    // The controller has not come back: the manager drives meanwhile.
    const room = createTestRoom(roomId, dir);
    const asManager = connect(room, session(roomId, "manager-1", true));
    const move = (presenterId: string) => ({
      [ROOM_NAVIGATION_ID]: ["put", {
        id: ROOM_NAVIGATION_ID, typeName: "orbmeet_navigation", pageId: "shape:page-1", pageNumber: 1, presenterId, roam: false,
      }],
    });

    asManager(move("someone-else"));
    expect(room.document.store.getMeta("navigationControllerPrincipal")).not.toBeNull();

    asManager(move("manager-1"));
    expect(navigationOf(room)).toMatchObject({ presenterId: "manager-1" });
    expect(room.document.store.getMeta("navigationControllerPrincipal")).toBeNull();
    room.close();
  });
});
