import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionState, RoomEvent } from "livekit-client";
import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";
import type { MeetingSurfaceAccess } from "@/modules/meetings/contract/types";
import { REMINT_WHILE_OFFLINE_MS } from "./whiteboard-credentials";
import { WhiteboardSession, type WhiteboardSessionApi } from "./whiteboard-session";

const CONNECTION = "connection-1";
const URL_BASE = "https://whiteboard.example";

function token(documentId: string): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    connectionId: CONNECTION,
    documentId,
    capabilities: { canEditWhiteboard: true, canManageWhiteboard: false },
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function surfaceState(overrides: Partial<MeetingSurfaceState> = {}): MeetingSurfaceState {
  return { open: true, whiteboardId: "wb_1", revision: 1, openRevision: 1, ...overrides };
}

function fakeRoom(state = ConnectionState.Connected) {
  const handlers = new Map<string, Set<() => void>>();
  const room = {
    state,
    on: (event: string, handler: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return room;
    },
    off: (event: string, handler: () => void) => {
      handlers.get(event)?.delete(handler);
      return room;
    },
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
  return room;
}

/** The server: the room's surface, and access minted for whatever it presents. */
function fakeServer(initial: MeetingSurfaceState = surfaceState({ open: false, whiteboardId: null, revision: 0, openRevision: 0 })) {
  let surface = initial;
  const server = {
    surface: () => surface,
    setSurface(next: MeetingSurfaceState) {
      surface = next;
    },
    failMints: 0,
    mintAccess: vi.fn(async () => {
      if (server.failMints > 0) {
        server.failMints -= 1;
        throw new Error("mint failed");
      }
      const documentId = surface.whiteboardId ?? "wb_1";
      return { token: token(documentId), whiteboardUrl: URL_BASE, documentId, documentTitle: "Board" };
    }),
    writeSurface: vi.fn(async (open: boolean) => {
      const revision = surface.revision + 1;
      surface = {
        open,
        whiteboardId: surface.whiteboardId ?? "wb_1",
        revision,
        openRevision: open && !surface.open ? revision : surface.openRevision,
      };
      return surface;
    }),
  };
  return server;
}

function joinSurface(overrides: Partial<Extract<MeetingSurfaceAccess, { availability: "available" }>> = {}): MeetingSurfaceAccess {
  return {
    availability: "available",
    disabledReason: null,
    surfaceOpen: false,
    token: null,
    url: URL_BASE,
    documentId: null,
    documentTitle: null,
    ...overrides,
  };
}

async function createSession(options: {
  api: WhiteboardSessionApi;
  surface?: MeetingSurfaceAccess;
  canModerate?: boolean;
  openOnStart?: boolean;
  room?: ReturnType<typeof fakeRoom>;
}) {
  const session = new WhiteboardSession({
    connectionId: CONNECTION,
    surface: options.surface ?? joinSurface(),
    canModerate: options.canModerate ?? true,
    openOnStart: options.openOnStart,
    api: options.api,
    logError: () => {},
  });
  session.setRoom((options.room ?? fakeRoom()) as never);
  session.activate();
  await vi.advanceTimersByTimeAsync(0);
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WhiteboardSession", () => {
  it("starts from the join: a board open at join is shown and its token is usable", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({
      api: server,
      surface: joinSurface({ surfaceOpen: true, token: token("wb_1"), documentId: "wb_1" }),
    });
    expect(session.getSnapshot()).toMatchObject({
      sharedSurfaceOpen: true,
      locallyVisible: true,
      view: "loading",
      accessReady: true,
      documentId: "wb_1",
    });
    expect(server.mintAccess).not.toHaveBeenCalled();
    session.deactivate();
  });

  it("opens for everyone: the room answers, access follows its board, then the canvas", async () => {
    const server = fakeServer();
    const session = await createSession({ api: server });

    const opening = session.openShared();
    expect(session.getSnapshot()).toMatchObject({ locallyVisible: true, view: "loading" });
    await opening;
    await vi.advanceTimersByTimeAsync(0);

    expect(server.writeSurface).toHaveBeenCalledWith(true);
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, accessReady: true, documentId: "wb_1" });
    session.canvasStatusChanged("ready");
    expect(session.getSnapshot().view).toBe("ready");
    session.deactivate();
  });

  it("waits for LiveKit before minting", async () => {
    const server = fakeServer(surfaceState());
    const room = fakeRoom(ConnectionState.Connecting);
    const session = await createSession({ api: server, room });
    session.setSurface(surfaceState());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.mintAccess).not.toHaveBeenCalled();
    // Waiting for LiveKit is not a failure.
    expect(session.getSnapshot().view).toBe("loading");

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Connected);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.mintAccess).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().accessReady).toBe(true);
    session.deactivate();
  });

  it("keeps trying when access fails after an open, instead of hanging on a spinner", async () => {
    const server = fakeServer();
    server.failMints = Number.POSITIVE_INFINITY;
    const session = await createSession({ api: server });
    await session.openShared();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, accessReady: false });

    // Past the access deadline with failures, the board says it failed...
    await vi.advanceTimersByTimeAsync(8_000);
    expect(session.getSnapshot().view).toBe("fatal");
    // ...and still recovers once minting works again.
    server.failMints = 0;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(server.mintAccess.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(session.getSnapshot()).toMatchObject({ accessReady: true, view: "loading" });
    session.deactivate();
  });

  it("follows a board switch, retrying a mint that fails", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({
      api: server,
      canModerate: false,
      surface: joinSurface({ surfaceOpen: true, token: token("wb_1"), documentId: "wb_1" }),
    });
    session.setSurface(surfaceState());
    session.canvasStatusChanged("ready");

    server.setSurface(surfaceState({ whiteboardId: "wb_2", revision: 2 }));
    server.failMints = 1;
    session.setSurface(server.surface());
    await vi.advanceTimersByTimeAsync(0);
    // The old board's credential no longer serves the surface.
    expect(session.getSnapshot()).toMatchObject({ whiteboardId: "wb_2", accessReady: false });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot()).toMatchObject({ accessReady: true, documentId: "wb_2" });
    session.deactivate();
  });

  it("lets a participant hide a shared board, keeps it hidden across a switch, and reveals a reopening", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({ api: server, canModerate: false });
    session.setSurface(surfaceState());
    await session.hideOrClose();
    expect(server.writeSurface).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: false });

    session.setSurface(surfaceState({ whiteboardId: "wb_2", revision: 2, openRevision: 1 }));
    expect(session.getSnapshot().locallyVisible).toBe(false);

    session.setSurface(surfaceState({ open: false, whiteboardId: "wb_2", revision: 3, openRevision: 1 }));
    session.setSurface(surfaceState({ whiteboardId: "wb_2", revision: 4, openRevision: 4 }));
    expect(session.getSnapshot().locallyVisible).toBe(true);
    session.deactivate();
  });

  it("lets a moderator whose board failed locally still close it for everyone", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({ api: server });
    session.setSurface(surfaceState());
    session.canvasStatusChanged("fatal");
    session.dismiss();
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: false });

    await session.hideOrClose();
    expect(server.writeSurface).toHaveBeenCalledWith(false);
    expect(session.getSnapshot().sharedSurfaceOpen).toBe(false);
    session.deactivate();
  });

  it("reports a failed close to the caller", async () => {
    const server = fakeServer(surfaceState());
    server.writeSurface.mockRejectedValueOnce(new Error("room unavailable"));
    const session = await createSession({ api: server });
    session.setSurface(surfaceState());
    await expect(session.hideOrClose()).rejects.toThrow("room unavailable");
    expect(session.getSnapshot().sharedSurfaceOpen).toBe(true);
    session.deactivate();
  });

  it("ignores room reports older than what it already knows", async () => {
    const server = fakeServer();
    const session = await createSession({ api: server });
    await session.openShared();
    session.setSurface(surfaceState({ open: false, revision: 0 }));
    expect(session.getSnapshot().sharedSurfaceOpen).toBe(true);
    session.deactivate();
  });

  it("opens on start once the room reports a surface nobody has touched", async () => {
    const server = fakeServer();
    const session = await createSession({ api: server, openOnStart: true });
    // The join's view is unconfirmed (revision -1): not a reason to open.
    expect(server.writeSurface).not.toHaveBeenCalled();

    session.setSurface(server.surface());
    await vi.advanceTimersByTimeAsync(0);
    expect(server.writeSurface).toHaveBeenCalledTimes(1);
    expect(server.writeSurface).toHaveBeenCalledWith(true);
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: true });

    // Later reports never open it again, even a closed one.
    session.setSurface(surfaceState({ open: false, revision: 5, openRevision: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.writeSurface).toHaveBeenCalledTimes(1);
    session.deactivate();
  });

  it("leaves a board someone already closed closed, and leaves the choice to moderators", async () => {
    const closed = fakeServer(surfaceState({ open: false, revision: 2, openRevision: 1 }));
    const afterClose = await createSession({ api: closed, openOnStart: true });
    afterClose.setSurface(closed.surface());
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.writeSurface).not.toHaveBeenCalled();
    afterClose.deactivate();

    const untouched = fakeServer();
    const attendee = await createSession({ api: untouched, openOnStart: true, canModerate: false });
    attendee.setSurface(untouched.surface());
    await vi.advanceTimersByTimeAsync(0);
    expect(untouched.writeSurface).not.toHaveBeenCalled();
    attendee.deactivate();
  });

  it("waits for LiveKit before opening on start", async () => {
    const server = fakeServer();
    const room = fakeRoom(ConnectionState.Connecting);
    const session = await createSession({ api: server, openOnStart: true, room });
    session.setSurface(server.surface());
    await vi.advanceTimersByTimeAsync(0);
    expect(server.writeSurface).not.toHaveBeenCalled();

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Connected);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.writeSurface).toHaveBeenCalledWith(true);
    session.deactivate();
  });

  it("switches between Board and Talk without closing the board for the room", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({ api: server });
    session.setSurface(surfaceState());

    session.showTalk();
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: false });
    await session.showBoard();
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: true });
    expect(server.writeSurface).not.toHaveBeenCalled();
    session.deactivate();
  });

  it("opens a closed board for everyone when a moderator picks the Board view", async () => {
    const server = fakeServer();
    const session = await createSession({ api: server });
    await session.showBoard();
    expect(server.writeSurface).toHaveBeenCalledWith(true);
    expect(session.getSnapshot()).toMatchObject({ sharedSurfaceOpen: true, locallyVisible: true });
    session.deactivate();
  });

  it("reuses its token across failing reconnects, minting once per drop and at most once per window", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({
      api: server,
      surface: joinSurface({ surfaceOpen: true, token: token("wb_1"), documentId: "wb_1" }),
    });
    session.setSurface(surfaceState());

    await session.webSocketUri();
    expect(server.mintAccess).not.toHaveBeenCalled();
    session.canvasConnectionChanged("online");
    // A healthy socket closing may mean its capabilities changed: mint once.
    session.canvasConnectionChanged("offline");
    await session.webSocketUri();
    expect(server.mintAccess).toHaveBeenCalledTimes(1);

    // Attempts that keep failing reuse that token...
    for (let attempt = 0; attempt < 5; attempt += 1) await session.webSocketUri();
    expect(server.mintAccess).toHaveBeenCalledTimes(1);
    // ...until the window passes.
    await vi.advanceTimersByTimeAsync(REMINT_WHILE_OFFLINE_MS);
    await session.webSocketUri();
    expect(server.mintAccess).toHaveBeenCalledTimes(2);
    session.deactivate();
  });

  // A rejoin after an edit grant: the join token never came online, so neither
  // the drop rule nor the window above fired, and the stale token was resent
  // for 30 seconds while the server refused every attempt.
  it("mints instead of resending a token the sync server rejected as stale", async () => {
    const server = fakeServer(surfaceState());
    const session = await createSession({
      api: server,
      surface: joinSurface({ surfaceOpen: true, token: token("wb_1"), documentId: "wb_1" }),
    });
    session.setSurface(surfaceState());

    await session.webSocketUri({ tokenRejected: false });
    expect(server.mintAccess).not.toHaveBeenCalled();

    await session.webSocketUri({ tokenRejected: true });
    expect(server.mintAccess).toHaveBeenCalledTimes(1);
    session.deactivate();
  });
});

describe("WhiteboardSession timers", () => {
  it("does not spin once a deadline has passed", async () => {
    const server = fakeServer();
    server.failMints = Number.POSITIVE_INFINITY;
    const session = await createSession({ api: server });
    await session.openShared();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(session.getSnapshot().view).toBe("fatal");

    // Past the access deadline, the session wakes only for the next retry.
    const passes = vi.spyOn(session as unknown as { converge: () => void }, "converge");
    await vi.advanceTimersByTimeAsync(500);
    expect(passes.mock.calls.length).toBeLessThanOrEqual(1);
    session.deactivate();
  });
});
