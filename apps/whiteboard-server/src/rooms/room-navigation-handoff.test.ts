import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSocketRoom } from "@tldraw/sync-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commandStatus, createTestRoom } from "./room-test-support.ts";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

const tempDirs: string[] = [];
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-nav-handoff-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeSocket(): TldrawSocket {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
  };
}

/**
 * Capture the frames the room fans out.
 *
 * Observed at `TLSocketRoom.sendCustomMessage` rather than at the socket,
 * because tldraw only delivers to a session that has completed its `connect`
 * handshake — which a test socket has not. This is the seam the room actually
 * broadcasts through, so what lands here is what a connected client would get.
 */
function captureFrames(): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  vi.spyOn(TLSocketRoom.prototype, "sendCustomMessage").mockImplementation(
    ((_sessionId: string, data: unknown) => {
      frames.push(data as Record<string, unknown>);
    }) as never,
  );
  return frames;
}

function wsData(
  whiteboardRoomId: WhiteboardRoomId,
  userId: string,
  overrides: Partial<SocketSession> = {},
): SocketSession {
  return {
    tldrawSessionId: `${userId}:session`,
    userId,
    userName: userId,
    role: "participant",
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: true,
      canManageWhiteboard: true,
    },
    grantPrincipal: { type: "user", id: userId },
    whiteboardRoomId,
    connectionId: `${userId}-conn`,
    ...overrides,
  };
}

const VIEWER_CAPABILITIES = {
  canEditWhiteboard: false,
  canControlSurface: false,
  canManageWhiteboard: false,
};

describe("navigation control handoff", () => {
  it("refuses a target who cannot edit the canvas", () => {
    // Driving navigation requires Whiteboard edit access, so accepting the handoff
    // produced a room that announced a presenter and then routed every
    // navigation request back to the manager anyway.
    const roomId = "meet-nav-gate" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    room.handleConnect(
      makeSocket(),
      wsData(roomId, "viewer", { capabilities: { ...VIEWER_CAPABILITIES } }),
    );

    const response = room.navigation.setController("viewer", "manager");
    expect(commandStatus(response)).toBe(409);
    // And the room did not quietly record them as controller.
    expect(room.navigation.isActiveNavigator("manager")).toBe(true);
    room.close();
  });

  it("still refuses an absent target with 404", () => {
    const roomId = "meet-nav-absent" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));

    expect(commandStatus(room.navigation.setController("nobody", "manager"))).toBe(404);
    room.close();
  });

  it("accepts a target that holds edit access", () => {
    const roomId = "meet-nav-ok" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    room.handleConnect(
      makeSocket(),
      wsData(roomId, "presenter", {
        capabilities: { ...VIEWER_CAPABILITIES, canEditWhiteboard: true },
      }),
    );

    expect(commandStatus(room.navigation.setController("presenter", "manager"))).toBe(200);
    room.close();
  });
});

describe("navigation by someone else releasing an absent controller", () => {
  it("broadcasts whiteboard state naming nobody", () => {
    // The controller lives in the state frame. Releasing one without a state
    // broadcast left every client naming a presenter the room had retired.
    const roomId = "meet-nav-stale" as WhiteboardRoomId;
    const dataDir = makeDataDir();

    const first = createTestRoom(roomId, dataDir, () => {});
    first.handleConnect(makeSocket(), wsData(roomId, "manager"));
    first.handleConnect(
      makeSocket(),
      wsData(roomId, "presenter", {
        capabilities: { ...VIEWER_CAPABILITIES, canEditWhiteboard: true },
      }),
    );
    expect(commandStatus(first.navigation.setController("presenter", "manager"))).toBe(200);
    first.close();

    // Restart with only the manager present: the persisted controller never
    // reconnects, so the manager driving navigation retires the role.
    const restarted = createTestRoom(roomId, dataDir, () => {});
    restarted.handleConnect(makeSocket(), wsData(roomId, "manager"));
    expect(restarted.navigation.isActiveNavigator("manager")).toBe(true);
    const frames = captureFrames();

    restarted.navigation.navigated("manager");

    const stateFrame = frames.find((f) => f.type === WHITEBOARD_EVENTS.STATE);
    expect(stateFrame).toBeDefined();
    expect(stateFrame?.navigationControllerUserId).toBeNull();
    restarted.close();
  });

  it("does not broadcast state when there was no controller to release", () => {
    const roomId = "meet-nav-noop" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    const frames = captureFrames();

    room.navigation.navigated("manager");

    expect(frames.some((f) => f.type === WHITEBOARD_EVENTS.STATE)).toBe(false);
    room.close();
  });
});

function latestControllerFrom(frames: Array<Record<string, unknown>>): unknown {
  const stateFrames = frames.filter((f) => f.type === WHITEBOARD_EVENTS.STATE);
  return stateFrames[stateFrames.length - 1]?.navigationControllerUserId;
}

describe("navigation control belongs to the principal", () => {
  const editor = { ...VIEWER_CAPABILITIES, canEditWhiteboard: true };

  /** A presenter join: a fresh user id per join, one grant principal for the person. */
  function presenterJoin(roomId: WhiteboardRoomId, join: string, overrides: Partial<SocketSession> = {}): SocketSession {
    return wsData(roomId, `presenter_${join}`, {
      grantPrincipal: { type: "user", id: "presenter" },
      capabilities: editor,
      ...overrides,
    });
  }

  it("keeps control when the presenter rejoins under a new user id", () => {
    const roomId = "meet-nav-rejoin" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    room.handleConnect(makeSocket(), presenterJoin(roomId, "a"));
    expect(commandStatus(room.navigation.setController("presenter_a", "manager"))).toBe(200);

    room.handleClose("presenter_a:session", 1006);
    // While away, nobody is shown presenting and the manager drives.
    expect(room.navigation.isActiveNavigator("presenter_a")).toBe(false);
    expect(room.navigation.isActiveNavigator("manager")).toBe(true);

    room.handleConnect(makeSocket(), presenterJoin(roomId, "b"));
    const frames = captureFrames();
    expect(room.navigation.isActiveNavigator("presenter_b")).toBe(true);
    expect(room.navigation.isActiveNavigator("manager")).toBe(false);
    room.handleClose("manager:session", 1000);
    expect(latestControllerFrom(frames)).toBe("presenter_b");
    room.close();
  });

  it("shows no presenter while the controller is away", () => {
    const roomId = "meet-nav-leave" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    room.handleConnect(makeSocket(), presenterJoin(roomId, "a"));
    expect(commandStatus(room.navigation.setController("presenter_a", "manager"))).toBe(200);

    const frames = captureFrames();
    room.handleClose("presenter_a:session", 1000);

    expect(latestControllerFrom(frames)).toBeNull();
    expect(room.navigation.isActiveNavigator("manager")).toBe(true);
    room.close();
  });

  it("refuses a handoff to another session of the approver", () => {
    const roomId = "meet-nav-self" as WhiteboardRoomId;
    const room = createTestRoom(roomId, makeDataDir(), () => {});
    room.handleConnect(makeSocket(), wsData(roomId, "manager"));
    room.handleConnect(
      makeSocket(),
      wsData(roomId, "manager_tab2", { grantPrincipal: { type: "user", id: "manager" } }),
    );
    expect(room.navigation.setController("manager_tab2", "manager")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    room.close();
  });
});
