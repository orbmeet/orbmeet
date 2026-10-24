import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSocketRoom, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import type { RoomSnapshot } from "@tldraw/sync-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room } from "./room.ts";
import { REFRESH_RECONNECT_GRACE_MS } from "./room-connections.ts";
import { RoomManager } from "./room-manager.ts";
import { RoomNavigation } from "./room-navigation.ts";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { whiteboardRevisionKey } from "@orbmeet/whiteboard-core/document-keys";
import { createMemoryObjectStore, type ObjectStore } from "../persistence/r2.ts";
import { SnapshotStore } from "../persistence/snapshot-store.ts";
import { commandStatus, createTestRoom, fakeAuthority } from "./room-test-support.ts";

const CLEANUP_DELAY_MS = 15 * 60 * 1000;
const BOARD = "wb_test";

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

function makeSocket(readyState = 1): TldrawSocket & { closed: Array<[number?, string?]> } {
  const closed: Array<[number?, string?]> = [];
  return {
    readyState,
    send: () => {},
    close: (code?: number, reason?: string) => {
      closed.push([code, reason]);
    },
    closed,
  };
}

function makeWsData(
  whiteboardRoomId: WhiteboardRoomId,
  overrides: Partial<SocketSession> = {},
): SocketSession {
  return {
    tldrawSessionId: "user-1:aaaaaaaa",
    userId: "user-1",
    userName: "User One",
    role: "participant",
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: true,
      canManageWhiteboard: true,
    },
    grantPrincipal: { type: "user", id: "user-1" },
    whiteboardRoomId,
    connectionId: "conn-1",
    ...overrides,
  };
}

/** An object store whose writes can be made to fail. */
function failingStore(): ObjectStore & { failWrites: boolean; objects: ReturnType<typeof createMemoryObjectStore>["objects"] } {
  const inner = createMemoryObjectStore();
  const store = {
    failWrites: false,
    objects: inner.objects,
    get: inner.get,
    head: inner.head,
    copy: inner.copy,
    delete: inner.delete,
    list: inner.list,
    async put(key: string, body: Uint8Array<ArrayBuffer>, metadata: Record<string, string>) {
      if (store.failWrites) throw new Error("R2 unavailable");
      await inner.put(key, body, metadata);
    },
  };
  return store;
}

function liveSnapshot(room: Room): RoomSnapshot {
  return room.document.currentSnapshot();
}

function pageFrameCount(snapshot: RoomSnapshot): number {
  return snapshot.documents.filter(
    (document) =>
      document.state.typeName === "shape" &&
      (document.state as { type?: unknown }).type === "whiteboard-page",
  ).length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("room idle reaping", () => {
  it("reaps a room that never saw a socket", async () => {
    const onEmpty = vi.fn();
    const room = createTestRoom("meet-cold", makeDataDir(), onEmpty);

    // Materialised by a capture or another management command, never connected to.
    // Before the reaper moved into the constructor nothing would ever close it.
    expect(onEmpty).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);

    await vi.waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
    expect(room.isEmpty()).toBe(true);
  });

  it("does not run the idle reaper after process shutdown begins", async () => {
    const onEmpty = vi.fn();
    const room = createTestRoom("meet-shutdown", makeDataDir(), onEmpty);

    room.connections.stopAcceptingOperations();
    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);

    expect(onEmpty).not.toHaveBeenCalled();
    room.close();
  });

  it("rejects a PDF page apply after the room has closed", async () => {
    const room = createTestRoom("meet-closed-import", makeDataDir(), vi.fn());
    room.close();

    const result = room.insertImportedPages("user-1", {
      importId: "import-1",
      insertIndex: 0,
      pages: [],
    });

    expect(result.reply.status).toBe(409);
    expect(result.placedPageIndices).toEqual([]);
    expect(result.reply.json).toEqual({
      error: "Whiteboard room is no longer available",
    });
  });

  it("cancels the constructor's reaper when a socket arrives", async () => {
    const whiteboardRoomId = "meet-warm" as WhiteboardRoomId;
    const onEmpty = vi.fn();
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), onEmpty);

    room.handleConnect(makeSocket(), makeWsData(whiteboardRoomId));

    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);

    expect(onEmpty).not.toHaveBeenCalled();
    expect(room.isEmpty()).toBe(false);
  });

  it("reschedules the reaper after the last socket closes", async () => {
    const whiteboardRoomId = "meet-drain" as WhiteboardRoomId;
    const onEmpty = vi.fn();
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), onEmpty);
    const data = makeWsData(whiteboardRoomId);
    const socket = makeSocket();

    room.handleConnect(socket, data);
    socket.readyState = 3;
    room.handleClose(data.tldrawSessionId, 1006, socket);

    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);

    await vi.waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
  });

  it("keeps the reaper armed when socket admission throws", async () => {
    const whiteboardRoomId = "meet-admission-fails" as WhiteboardRoomId;
    const onEmpty = vi.fn();
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), onEmpty);
    vi.spyOn(TLSocketRoom.prototype, "handleSocketConnect").mockImplementationOnce(() => {
      throw new Error("sync admission failed");
    });
    const closeSpy = vi
      .spyOn(TLSocketRoom.prototype, "handleSocketClose")
      .mockImplementationOnce(() => {
        throw new Error("partial admission cleanup failed");
      });

    expect(() => room.handleConnect(
      makeSocket(),
      makeWsData(whiteboardRoomId),
    )).toThrow("sync admission failed");
    expect(closeSpy).toHaveBeenCalledWith("user-1:aaaaaaaa");

    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);

    await vi.waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
    expect(room.isEmpty()).toBe(true);
  });

  it("does not clean up a session id owned by an existing socket", () => {
    const whiteboardRoomId = "meet-admission-collision" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const data = makeWsData(whiteboardRoomId);
    room.handleConnect(makeSocket(), data);
    vi.spyOn(TLSocketRoom.prototype, "handleSocketConnect").mockImplementationOnce(() => {
      throw new Error("duplicate sync admission failed");
    });
    const closeSpy = vi.spyOn(TLSocketRoom.prototype, "handleSocketClose");

    expect(() => room.handleConnect(makeSocket(), data)).toThrow(
      "duplicate sync admission failed",
    );

    expect(closeSpy).not.toHaveBeenCalled();
    expect(room.isEmpty()).toBe(false);
  });


  it("does not reap a room while a document command is persisting", async () => {
    const onEmpty = vi.fn();
    const objects = failingStore();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const put = objects.put;
    objects.put = async (...args) => {
      await gate;
      return put(...args);
    };
    const room = createTestRoom("meet-management-active", makeDataDir(), onEmpty, {
      snapshots: new SnapshotStore(objects),
    });

    const capture = room.document.capture("cmd-capture-1", BOARD, whiteboardRevisionKey(BOARD, "rev_1"));
    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);
    expect(onEmpty).not.toHaveBeenCalled();

    releaseWrite();
    await expect(capture).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);
    await vi.waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
  });

  it("validates edited-page markers against the connected editor and live page frame", async () => {
    const whiteboardRoomId = "meet-page-edit-validation" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    await room.document.open("cmd-open-1", BOARD);
    room.handleConnect(makeSocket(), makeWsData(whiteboardRoomId));
    const pageFrame = liveSnapshot(room).documents.find(
      (document) =>
        document.state.typeName === "shape" &&
        (document.state as { type?: unknown }).type === "whiteboard-page",
    );
    if (!pageFrame) throw new Error("expected a page frame");

    expect(commandStatus(room.validateEditedPageFromClient("user-1", "conn-1", pageFrame.state.id)))
      .toBe(200);
    expect(commandStatus(room.validateEditedPageFromClient("user-1", "conn-1", "shape:not-a-page")))
      .toBe(404);
    expect(commandStatus(room.validateEditedPageFromClient("user-2", "conn-2", pageFrame.state.id)))
      .toBe(403);
    room.close();
  });
});

describe("document commands", () => {
  it("opens a blank document with one page and is idempotent", async () => {
    const room = createTestRoom("meet-open", makeDataDir(), vi.fn());

    const first = await room.document.open("cmd-open-a", BOARD);
    expect(first).toMatchObject({ ok: true, status: "initialized" });
    expect(pageFrameCount(liveSnapshot(room))).toBe(1);

    const second = await room.document.open("cmd-open-b", BOARD);
    expect(second).toMatchObject({ ok: true, status: "already_initialized" });
    expect(pageFrameCount(liveSnapshot(room))).toBe(1);
    room.close();
  });

  it("joins a retry that arrives while the command is still running", async () => {
    const room = createTestRoom("meet-open-retry", makeDataDir(), vi.fn());
    const [first, retried] = await Promise.all([
      room.document.open("cmd-open-same", BOARD),
      room.document.open("cmd-open-same", BOARD),
    ]);
    expect(retried).toEqual(first);
    expect(pageFrameCount(liveSnapshot(room))).toBe(1);
    room.close();
  });

  it("refuses to start a command after its deadline but still reports a recorded capture", async () => {
    const room = createTestRoom("meet-command-deadline", makeDataDir(), vi.fn());
    const captureKey = whiteboardRevisionKey(BOARD, "rev_boundary");
    const captured = await room.document.capture("cmd-capture", BOARD, captureKey, {
      startBefore: Date.now() + 1_000,
    });
    expect(captured).toMatchObject({ ok: true, copy: { key: captureKey } });
    const past = { startBefore: Date.now() - 1 };

    // The board moves on; a late retry reports the capture, never re-copies.
    room.handleConnect(makeSocket(), makeWsData("meet-command-deadline"));
    expect(commandStatus(room.addPage("user-1"))).toBe(200);
    await expect(room.document.capture("cmd-capture", BOARD, captureKey, past)).resolves.toMatchObject({
      ok: true,
      copy: captured.ok ? captured.copy : null,
    });
    await expect(
      room.document.capture("cmd-capture-late", BOARD, whiteboardRevisionKey(BOARD, "rev_late"), past),
    ).resolves.toMatchObject({ ok: false, reason: "expired" });
    room.close();
  });

  it("reports a failed capture and lets a retry succeed", async () => {
    const objects = failingStore();
    const room = createTestRoom("meet-capture-failure", makeDataDir(), vi.fn(), {
      snapshots: new SnapshotStore(objects),
    });
    const revisionKey = whiteboardRevisionKey(BOARD, "rev_1");
    objects.failWrites = true;
    await expect(room.document.capture("cmd-cp-1", BOARD, revisionKey)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    objects.failWrites = false;
    // A failure is not remembered: the same command id runs again.
    await expect(room.document.capture("cmd-cp-1", BOARD, revisionKey)).resolves.toMatchObject({ ok: true });
    room.close();
  });

  it("captures the board to one of its own revisions only", async () => {
    const objects = createMemoryObjectStore();
    const room = createTestRoom("meet-capture-copy", makeDataDir(), vi.fn(), {
      snapshots: new SnapshotStore(objects),
    });
    const revisionKey = whiteboardRevisionKey(BOARD, "rev_1");
    const result = await room.document.capture("cmd-cp-copy", BOARD, revisionKey);
    expect(result).toMatchObject({ ok: true, copy: { key: revisionKey } });
    expect(objects.objects.has(revisionKey)).toBe(true);

    await expect(
      room.document.capture("cmd-cp-foreign", BOARD, whiteboardRevisionKey("wb_other", "rev_1")),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
    room.close();
  });

  it("refuses a command for a different whiteboard than the room hosts", async () => {
    const room = createTestRoom("meet-bound", makeDataDir(), vi.fn());
    await expect(room.document.open("cmd-other-board", "wb_other")).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
    });
    room.close();
  });

  it("archives: stops writes, closes sockets, and stays archived after a restart until reopened", async () => {
    const whiteboardRoomId = "meet-archive" as WhiteboardRoomId;
    const dataDir = makeDataDir();
    const room = createTestRoom(whiteboardRoomId, dataDir, vi.fn());
    await room.document.open("cmd-open", BOARD);
    const socket = makeSocket();
    room.handleConnect(socket, makeWsData(whiteboardRoomId));

    await expect(room.document.archive("cmd-archive-1", BOARD)).resolves.toMatchObject({ ok: true });
    expect(socket.closed.at(-1)?.[1]).toBe(TLSyncErrorCloseEventReason.FORBIDDEN);
    expect(room.canUserAddPages("user-1")).toBe(false);
    // Idempotent under a new command id.
    await expect(room.document.archive("cmd-archive-2", BOARD)).resolves.toMatchObject({ ok: true });
    room.close();

    // A restarted process, with only the room's database.
    const rooms = new RoomManager(dataDir, { objects: createMemoryObjectStore(), authority: fakeAuthority() });
    const restarted = rooms.openRoom(whiteboardRoomId, BOARD)!;
    const refused = makeSocket();
    restarted.handleConnect(refused, makeWsData(whiteboardRoomId));
    expect(refused.closed).toHaveLength(1);
    await expect(restarted.document.open("cmd-open-archived", BOARD)).resolves.toMatchObject({
      ok: false,
      reason: "archived",
    });

    await expect(restarted.document.reopen("cmd-reopen", BOARD)).resolves.toMatchObject({ ok: true });
    await expect(restarted.document.open("cmd-open-reopened", BOARD)).resolves.toMatchObject({ ok: true });
    await rooms.closeAll();
  });

  it("runs a reopen sent during an archive after it, so the board ends writable", async () => {
    const room = createTestRoom("meet-archive-race", makeDataDir(), vi.fn());
    await room.document.open("cmd-open", BOARD);
    const archiving = room.document.archive("cmd-archive", BOARD);
    const reopening = room.document.reopen("cmd-reopen", BOARD);
    await expect(archiving).resolves.toMatchObject({ ok: true });
    await expect(reopening).resolves.toMatchObject({ ok: true });
    await expect(room.document.open("cmd-open-again", BOARD)).resolves.toMatchObject({ ok: true });
    room.close();
  });

});

describe("whiteboard binding", () => {
  it("refuses a socket whose token names another whiteboard once the room is bound", async () => {
    const room = createTestRoom("meet-bound", makeDataDir(), vi.fn());
    await room.document.open("cmd-open", BOARD);

    const foreign = makeSocket();
    room.handleConnect(foreign, makeWsData("meet-bound", { documentId: "wb_other" }));
    expect(foreign.closed).toEqual([[1008, "Token is for a different whiteboard"]]);

    const own = makeSocket();
    room.handleConnect(own, makeWsData("meet-bound", { documentId: BOARD }));
    expect(own.closed).toEqual([]);
    room.close();
  });
});

describe("restore", () => {
  async function roomWithRevision() {
    const objects = createMemoryObjectStore();
    const room = createTestRoom("meet-restore", makeDataDir(), vi.fn(), { snapshots: new SnapshotStore(objects) });
    await room.document.open("cmd-open", BOARD);
    // The revision: the board as it looks with one page.
    const sourceKey = whiteboardRevisionKey(BOARD, "rev_source");
    await room.document.capture("cmd-capture", BOARD, sourceKey);
    // Then the board moves on: a second page.
    room.handleConnect(makeSocket(), makeWsData("meet-restore"));
    expect(commandStatus(room.addPage("user-1"))).toBe(200);
    return { room, objects, sourceKey };
  }

  it("replaces the document, keeps a restore point, and moves the clock forward", async () => {
    const { room, objects, sourceKey } = await roomWithRevision();
    const clockBefore = liveSnapshot(room).documentClock ?? 0;
    expect(pageFrameCount(liveSnapshot(room))).toBe(2);
    const restorePointKey = whiteboardRevisionKey(BOARD, "rev_undo");

    const result = await room.document.restore("cmd-restore", BOARD, sourceKey, restorePointKey);

    expect(result).toMatchObject({ ok: true, restorePoint: { key: restorePointKey } });
    expect(pageFrameCount(liveSnapshot(room))).toBe(1);
    expect(liveSnapshot(room).documentClock ?? 0).toBeGreaterThan(clockBefore);
    expect(objects.objects.has(restorePointKey)).toBe(true);
    room.close();
  });

  it("mints no second restore point when the board already shows the target", async () => {
    const { room, sourceKey } = await roomWithRevision();
    await room.document.restore("cmd-restore-1", BOARD, sourceKey, whiteboardRevisionKey(BOARD, "rev_undo_1"));
    const again = await room.document.restore(
      "cmd-restore-2",
      BOARD,
      sourceKey,
      whiteboardRevisionKey(BOARD, "rev_undo_2"),
    );
    expect(again).toMatchObject({ ok: true, restorePoint: null });
    room.close();
  });

  it("answers a retry with its restore point when the first run died before recording it", async () => {
    const { room, sourceKey } = await roomWithRevision();
    const restorePointKey = whiteboardRevisionKey(BOARD, "rev_undo");
    await room.document.restore("cmd-restore", BOARD, sourceKey, restorePointKey);
    // The process died after replacing the document, before the record landed.
    room.document.store.setMeta("restore:cmd-restore", null);

    const retried = await room.document.restore("cmd-restore", BOARD, sourceKey, restorePointKey);
    expect(retried).toMatchObject({ ok: true, restorePoint: { key: restorePointKey } });
    room.close();
  });

  it("changes nothing when the restore point could not be kept", async () => {
    const objects = failingStore();
    const room = createTestRoom("meet-restore-fail", makeDataDir(), vi.fn(), {
      snapshots: new SnapshotStore(objects),
    });
    await room.document.open("cmd-open", BOARD);
    const sourceKey = whiteboardRevisionKey(BOARD, "rev_source");
    await room.document.capture("cmd-capture", BOARD, sourceKey);
    room.handleConnect(makeSocket(), makeWsData("meet-restore-fail"));
    room.addPage("user-1");

    objects.failWrites = true;
    const result = await room.document.restore("cmd-restore", BOARD, sourceKey, whiteboardRevisionKey(BOARD, "rev_undo"));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(pageFrameCount(liveSnapshot(room))).toBe(2);
    expect(room.canUserAddPages("user-1")).toBe(true);
    room.close();
  });

  it("refuses a source that is not a valid whiteboard document", async () => {
    const { room, objects } = await roomWithRevision();
    const corruptKey = whiteboardRevisionKey(BOARD, "rev_corrupt");
    objects.objects.set(corruptKey, {
      body: new TextEncoder().encode(JSON.stringify({ documents: "nope" })),
      metadata: {},
    });
    await expect(
      room.document.restore("cmd-corrupt", BOARD, corruptKey, whiteboardRevisionKey(BOARD, "rev_undo")),
    ).resolves.toMatchObject({ ok: false, reason: "conflict" });
    expect(pageFrameCount(liveSnapshot(room))).toBe(2);
    room.close();
  });

  it("refuses keys outside the board's revisions and a missing source", async () => {
    const { room } = await roomWithRevision();
    await expect(
      room.document.restore("cmd-a", BOARD, "internal/whiteboards/wb_test/state/current.json", whiteboardRevisionKey(BOARD, "u")),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
    await expect(
      room.document.restore("cmd-b", BOARD, whiteboardRevisionKey(BOARD, "missing"), whiteboardRevisionKey(BOARD, "u")),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    room.close();
  });
});

describe("room storage failures", () => {
  it("finishes closing, without throwing, when its database fails to close", async () => {
    const dir = makeDataDir();
    const manager = new RoomManager(dir, { objects: createMemoryObjectStore(), authority: fakeAuthority() });
    const brokenId = "meet-close-broken" as WhiteboardRoomId;
    const healthyId = "meet-close-healthy" as WhiteboardRoomId;
    manager.withRoom(brokenId, BOARD, () => null);
    manager.withRoom(healthyId, "wb_other", () => null);
    const broken = manager.getRoomIfExists(brokenId)!;
    const healthy = manager.getRoomIfExists(healthyId)!;
    vi.spyOn(broken.document, "close").mockImplementation(() => {
      throw new Error("disk I/O error");
    });

    await manager.closeAll();

    expect(broken.isClosed()).toBe(true);
    expect(healthy.isClosed()).toBe(true);
  });

  it("keeps no binding it could not store", () => {
    const room = createTestRoom("meet-bind-unstored", makeDataDir(), vi.fn(), { whiteboardId: undefined });
    vi.spyOn(room.document.store, "setMeta").mockImplementation(() => {
      throw new Error("disk I/O error");
    });

    expect(() => room.document.bindWhiteboard(BOARD)).toThrow(/disk I\/O/);
    expect(room.document.whiteboardId).toBeNull();
  });
});

describe("room construction failure", () => {
  it("closes the sync room when a later constructor step throws", () => {
    const closeSpy = vi.spyOn(TLSocketRoom.prototype, "close");
    // Adopting legacy navigation is a real constructor step that runs after
    // `new TLSocketRoom` and reads persisted state — exactly the shape of
    // failure the constructor's catch exists to absorb.
    vi.spyOn(RoomNavigation.prototype, "readLegacyNavigation").mockImplementation(() => {
      throw new Error("corrupt persisted room state");
    });

    expect(
      () => createTestRoom("meet-broken", makeDataDir(), () => {}),
    ).toThrow(/corrupt persisted room state/);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});


describe("stale socket eviction", () => {
  it("keeps the replacement indexed when the evicted socket later closes", () => {
    const whiteboardRoomId = "meet-evicted" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const data = makeWsData(whiteboardRoomId);

    const first = makeSocket();
    room.handleConnect(first, data);
    first.readyState = 3;
    const second = makeSocket();
    room.handleConnect(second, data);

    room.handleClose(data.tldrawSessionId, 1006, first);

    expect(room.isEmpty()).toBe(false);
    expect(second.closed).toHaveLength(0);
  });

  it("does not let a superseded socket consume the current refresh marker", () => {
    const whiteboardRoomId = "meet-reconnect-marker" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const ended = vi.spyOn(room.assistant, "connectionEnded");
    const data = makeWsData(whiteboardRoomId);
    const first = makeSocket();
    room.handleConnect(first, data);
    first.readyState = 3;
    const second = makeSocket();
    room.handleConnect(second, data);

    room.connections.reconnect(data.tldrawSessionId);
    room.handleClose(data.tldrawSessionId, 1006, first);
    room.handleClose(data.tldrawSessionId, 4099, second);

    // Neither the eviction (the same connection was arriving) nor the
    // current socket's close (a refresh) is the connection leaving.
    expect(ended).not.toHaveBeenCalled();
    expect(room.connections.isAwaitingRefresh(data.connectionId)).toBe(true);
    room.close();
  });

  it("does not end the connection that is replacing its own stale socket", () => {
    const whiteboardRoomId = "meet-evicted-same-connection" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const ended = vi.spyOn(room.assistant, "connectionEnded");
    const data = makeWsData(whiteboardRoomId);
    const first = makeSocket();
    room.handleConnect(first, data);
    first.readyState = 3;

    room.handleConnect(makeSocket(), data);

    expect(ended).not.toHaveBeenCalled();
    room.close();
  });
});

describe("refresh reconnects", () => {
  it("keeps a connection the server refreshed when its client comes back", async () => {
    const whiteboardRoomId = "meet-refresh-return" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const ended = vi.spyOn(room.assistant, "connectionEnded");
    const data = makeWsData(whiteboardRoomId);
    const before = makeSocket();
    room.handleConnect(before, data);

    room.connections.reconnect(data.tldrawSessionId);
    room.handleClose(data.tldrawSessionId, 4099, before);
    await vi.advanceTimersByTimeAsync(REFRESH_RECONNECT_GRACE_MS / 2);
    // The re-minted token arrives as a new session of the same connection.
    room.handleConnect(makeSocket(), { ...data, tldrawSessionId: "user-1:bbbbbbbb" });
    await vi.advanceTimersByTimeAsync(REFRESH_RECONNECT_GRACE_MS * 4);

    expect(ended).not.toHaveBeenCalled();
    room.close();
  });

  it("ends a refreshed connection whose client never comes back", async () => {
    const whiteboardRoomId = "meet-refresh-gone" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const ended = vi.spyOn(room.assistant, "connectionEnded");
    const data = makeWsData(whiteboardRoomId);
    const socket = makeSocket();
    room.handleConnect(socket, data);

    room.connections.reconnect(data.tldrawSessionId);
    room.handleClose(data.tldrawSessionId, 4099, socket);
    await vi.advanceTimersByTimeAsync(REFRESH_RECONNECT_GRACE_MS - 1);
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(ended).toHaveBeenCalledExactlyOnceWith(data.connectionId);
    room.close();
  });

  it("ends a connection at once when its socket simply closes", () => {
    const whiteboardRoomId = "meet-plain-close" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {});
    const ended = vi.spyOn(room.assistant, "connectionEnded");
    const data = makeWsData(whiteboardRoomId);
    const socket = makeSocket();
    room.handleConnect(socket, data);

    room.handleClose(data.tldrawSessionId, 1001, socket);

    expect(ended).toHaveBeenCalledExactlyOnceWith(data.connectionId);
    room.close();
  });
});

describe("authority", () => {
  const editorData = (whiteboardRoomId: WhiteboardRoomId) =>
    makeWsData(whiteboardRoomId, {
      tldrawSessionId: "editor:aaaaaaaa",
      userId: "editor",
      userName: "Editor",
      capabilities: {
        canEditWhiteboard: true,
        canControlSurface: false,
        canManageWhiteboard: false,
      },
      grantPrincipal: { type: "user", id: "editor" },
      connectionId: "editor-connection",
    });

  it("suspends a principal's writes the moment the Worker narrows its authority", async () => {
    const whiteboardRoomId = "meet-suspend" as WhiteboardRoomId;
    let answer: (verdicts: "active") => void = () => {};
    const authority = {
      calls: 0,
      verdicts: () =>
        new Promise<"active"[]>((resolve) => {
          authority.calls++;
          answer = () => resolve(["active"]);
        }),
    };
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    room.handleConnect(makeSocket(), editorData(whiteboardRoomId));
    expect(room.canUserEditWhiteboard("editor")).toBe(true);

    room.authority.refresh("user:editor");
    expect(room.canUserEditWhiteboard("editor")).toBe(false);

    answer("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(room.canUserEditWhiteboard("editor")).toBe(true);
    room.close();
  });

  it("suspends a managing session too when the narrowing is of its role", async () => {
    const whiteboardRoomId = "meet-suspend-manager" as WhiteboardRoomId;
    let answer: () => void = () => {};
    const authority = {
      verdicts: () => new Promise<"active"[]>((resolve) => { answer = () => resolve(["active"]); }),
    };
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    room.handleConnect(makeSocket(), makeWsData(whiteboardRoomId, {
      tldrawSessionId: "moderator:aaaaaaaa",
      userId: "moderator",
      userName: "Moderator",
      capabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
      grantPrincipal: { type: "user", id: "moderator" },
      connectionId: "moderator-connection",
    }));
    expect(room.authority.canManageWhiteboard("moderator")).toBe(true);

    // The meeting took the moderator role away (a demotion or a removal).
    room.authority.refresh("user:moderator");
    expect(room.authority.canManageWhiteboard("moderator")).toBe(false);
    expect(room.canUserEditWhiteboard("moderator")).toBe(false);

    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.authority.canManageWhiteboard("moderator")).toBe(true);
    room.close();
  });

  it("keeps a revoke when a sweep that started before it answers afterwards", async () => {
    const whiteboardRoomId = "meet-revoke-race" as WhiteboardRoomId;
    const answers: Array<() => void> = [];
    const authority = {
      verdicts: () => new Promise<"active"[]>((resolve) => answers.push(() => resolve(["active"]))),
    };
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    room.handleConnect(makeSocket(), editorData(whiteboardRoomId));

    // The periodic sweep is out asking when the Worker revokes and asks again.
    void room.authority.revalidate();
    room.authority.refresh("user:editor");
    expect(answers).toHaveLength(2);

    // The sweep read D1 before the revoke; its "active" must not lift it.
    answers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.canUserEditWhiteboard("editor")).toBe(false);

    answers[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.canUserEditWhiteboard("editor")).toBe(true);
    room.close();
  });

  it("reconnects a socket whose claims went stale and closes a denied one for good", async () => {
    const whiteboardRoomId = "meet-verdicts" as WhiteboardRoomId;
    const authority = fakeAuthority((claim) => (claim.sub === "editor" ? "refresh" : "denied"));
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    const editor = makeSocket();
    const stranger = makeSocket();
    room.handleConnect(editor, editorData(whiteboardRoomId));
    room.handleConnect(stranger, makeWsData(whiteboardRoomId, {
      tldrawSessionId: "stranger:aaaaaaaa",
      userId: "stranger",
      grantPrincipal: { type: "user", id: "stranger" },
      connectionId: "stranger-connection",
    }));

    await room.authority.revalidate();

    expect(editor.closed.at(-1)?.[1]).toBe(TLSyncErrorCloseEventReason.NOT_AUTHENTICATED);
    expect(stranger.closed.at(-1)?.[1]).toBe(TLSyncErrorCloseEventReason.FORBIDDEN);
    room.close();
  });

  it("asks once per distinct claim, not once per socket", async () => {
    const whiteboardRoomId = "meet-grouped" as WhiteboardRoomId;
    const authority = fakeAuthority();
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    room.handleConnect(makeSocket(), makeWsData(whiteboardRoomId));
    room.handleConnect(makeSocket(), makeWsData(whiteboardRoomId, { tldrawSessionId: "user-1:bbbbbbbb" }));

    await room.authority.revalidate();
    expect(authority.calls).toHaveLength(1);
    expect(authority.calls[0]).toHaveLength(1);
    room.close();
  });

  it("applies verdicts in request order", async () => {
    const whiteboardRoomId = "meet-ordered" as WhiteboardRoomId;
    const pending: Array<(verdict: "active" | "denied") => void> = [];
    const authority = {
      verdicts: () =>
        new Promise<Array<"active" | "denied">>((resolve) => {
          pending.push((verdict) => resolve([verdict]));
        }),
    };
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, { authority });
    const socket = makeSocket();
    room.handleConnect(socket, editorData(whiteboardRoomId));

    const older = room.authority.revalidate();
    const newer = room.authority.revalidate();
    pending[1]("active");
    await newer;
    // The older request started before the D1 change the newer one saw.
    pending[0]("denied");
    await older;
    expect(socket.closed).toHaveLength(0);
    room.close();
  });

  it("keeps serving through a short Worker outage and closes sockets after a long one", async () => {
    const whiteboardRoomId = "meet-outage" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), () => {}, {
      authority: fakeAuthority("unavailable"),
    });
    const socket = makeSocket();
    room.handleConnect(socket, editorData(whiteboardRoomId));

    await room.authority.revalidate();
    expect(socket.closed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(121_000);
    await room.authority.revalidate();
    expect(socket.closed.at(-1)?.[1]).toBe(TLSyncErrorCloseEventReason.UNKNOWN_ERROR);
    room.close();
  });
});

describe("manager lookup fencing", () => {
  it("fences writes but not teardown once shutting down", async () => {
    const whiteboardRoomId = "meet-fenced" as WhiteboardRoomId;
    const manager = new RoomManager(makeDataDir(), {
      objects: createMemoryObjectStore(),
      authority: fakeAuthority(),
    });
    manager.withRoom(whiteboardRoomId, BOARD, () => null);
    const room = manager.getRoomIfExists(whiteboardRoomId);
    expect(room).not.toBeNull();

    manager.beginShutdown();

    expect(manager.getRoomIfExists(whiteboardRoomId)).toBeNull();
    expect(manager.getRoomForTeardown(whiteboardRoomId)).toBe(room);
    await manager.closeAll();
  });

  it("stops room background work immediately when writer ownership is lost", async () => {
    const whiteboardRoomId = "meet-writer-lost" as WhiteboardRoomId;
    const manager = new RoomManager(makeDataDir(), {
      objects: createMemoryObjectStore(),
      authority: fakeAuthority(),
    });
    manager.withRoom(whiteboardRoomId, BOARD, () => null);
    const room = manager.getRoomIfExists(whiteboardRoomId);
    if (!room) throw new Error("room was not prepared");

    (manager as unknown as { handleWriterLockLost(): void }).handleWriterLockLost();

    expect(manager.getRoomIfExists(whiteboardRoomId)).toBeNull();
    await expect(room.document.open("cmd-after-lock-loss", BOARD)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await manager.closeAll();
  });

  it("releases session state for a close that lands during shutdown", async () => {
    const whiteboardRoomId = "meet-late-close" as WhiteboardRoomId;
    const manager = new RoomManager(makeDataDir(), {
      objects: createMemoryObjectStore(),
      authority: fakeAuthority(),
    });
    manager.withRoom(whiteboardRoomId, BOARD, () => null);
    const room = manager.getRoomIfExists(whiteboardRoomId);
    expect(room).not.toBeNull();
    if (!room) throw new Error("room was not prepared");
    const data = makeWsData(whiteboardRoomId);
    const socket = makeSocket();
    room.handleConnect(socket, data);
    expect(room.isEmpty()).toBe(false);

    manager.beginShutdown();
    socket.readyState = 3;
    // What index.ts's websocket `close` handler does. Routed through the fenced
    // lookup this resolved to null and the socket stayed in `activeSockets`.
    manager.getRoomForTeardown(whiteboardRoomId)?.handleClose(
      data.tldrawSessionId,
      1001,
      socket,
    );

    // The socket is no longer reachable through the room: revoking it is a
    // no-op rather than a close on a released connection.
    const closesAfterTeardown = socket.closed.length;
    room.connections.revoke(data.tldrawSessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
    expect(socket.closed).toHaveLength(closesAfterTeardown);

    // And the disconnect handling ran, so the room is now reapable.
    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS + 1);
    await vi.waitFor(() => expect(manager.roomCount).toBe(0));

    await manager.closeAll();
  });
});
