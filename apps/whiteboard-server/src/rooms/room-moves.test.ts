import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whiteboardRoomCopyKey } from "@orbmeet/whiteboard-core/document-keys";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { dispatchSyncCommand } from "../http/commands.ts";
import { createMemoryObjectStore, type ObjectStore } from "../persistence/r2.ts";
import { roomDatabaseExists } from "../persistence/room-storage.ts";
import { RoomManager } from "./room-manager.ts";
import { Room } from "./room.ts";
import { fakeAuthority } from "./room-test-support.ts";

// Two nodes sharing one R2 bucket, as production's do: a board moves between
// them by its generation.

const managers: RoomManager[] = [];
const dirs: string[] = [];

function node(objects: ObjectStore): { dir: string; manager: RoomManager } {
  const dir = mkdtempSync(join(tmpdir(), "wb-moves-"));
  dirs.push(dir);
  const manager = new RoomManager(dir, { objects, authority: fakeAuthority() });
  managers.push(manager);
  return { dir, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOM = "meet-a" as WhiteboardRoomId;
let commands = 0;
const open = (generation?: number) => ({
  whiteboardRoomId: ROOM,
  whiteboardId: "wb_a",
  commandId: `cmd-open-${++commands}`,
  ...(generation === undefined ? {} : { generation }),
});

function shapes(manager: RoomManager): number {
  const snapshot = manager.openRoom(ROOM, "wb_a")!.document.currentSnapshot();
  return snapshot.documents.filter((document) => document.state.typeName === "shape").length;
}

describe("moving a board between nodes", () => {
  it("creates a new board at the generation it is first used at", async () => {
    const objects = createMemoryObjectStore();
    const { manager } = node(objects);

    await expect(dispatchSyncCommand("open", open(1), manager)).resolves.toMatchObject({ ok: true });

    expect(manager.openRoom(ROOM, "wb_a")!.document.generation).toBe(1);
  });

  it("hands a board off and loads it on the next node at the next generation", async () => {
    const objects = createMemoryObjectStore();
    const singapore = node(objects);
    const amsterdam = node(objects);
    await dispatchSyncCommand("open", open(1), singapore.manager);

    await expect(dispatchSyncCommand("handoff", { whiteboardRoomId: ROOM, whiteboardId: "wb_a", generation: 1 }, singapore.manager))
      .resolves.toEqual({ ok: true, savedGeneration: 1 });
    expect(roomDatabaseExists(singapore.dir, ROOM)).toBe(false);
    expect(objects.objects.has(whiteboardRoomCopyKey(ROOM, 1))).toBe(true);

    await expect(dispatchSyncCommand("open", open(2), amsterdam.manager)).resolves.toMatchObject({ ok: true });
    expect(shapes(amsterdam.manager)).toBe(1);
    expect(amsterdam.manager.openRoom(ROOM, "wb_a")!.document.generation).toBe(2);
  });

  it("refuses a request made for a generation the board has moved on from", async () => {
    const objects = createMemoryObjectStore();
    const { manager } = node(objects);
    await dispatchSyncCommand("open", open(3), manager);

    await expect(dispatchSyncCommand("open", open(2), manager))
      .resolves.toMatchObject({ ok: false, reason: "conflict" });
    await expect(dispatchSyncCommand("handoff", { whiteboardRoomId: ROOM, whiteboardId: "wb_a", generation: 2 }, manager))
      .resolves.toMatchObject({ ok: false, reason: "conflict" });
  });

  it("keeps a copy of its own that is newer than the newest saved one", async () => {
    const objects = createMemoryObjectStore();
    const { manager } = node(objects);
    await dispatchSyncCommand("open", open(1), manager);
    await manager.saveAllRooms();
    // A save that never reached R2: what this node holds is newer.
    objects.objects.clear();

    await dispatchSyncCommand("open", open(2), manager);

    expect(shapes(manager)).toBe(1);
    expect(manager.openRoom(ROOM, "wb_a")!.document.generation).toBe(2);
  });

  it("never lets a node the board moved on from overwrite the newer copy", async () => {
    const objects = createMemoryObjectStore();
    const stale = node(objects);
    const current = node(objects);
    await dispatchSyncCommand("open", open(1), stale.manager);
    await stale.manager.saveAllRooms();
    // The board moves without the stale node hearing (it was unreachable).
    await dispatchSyncCommand("open", open(2), current.manager);
    current.manager.openRoom(ROOM, "wb_a")!.document.store.setMeta("written-by", "current");
    await current.manager.saveAllRooms();

    // The stale node keeps writing, and saves: only under its own generation.
    stale.manager.openRoom(ROOM, "wb_a")!.document.store.setMeta("written-by", "stale");
    await stale.manager.saveAllRooms();
    expect(objects.objects.has(whiteboardRoomCopyKey(ROOM, 1))).toBe(true);

    const third = node(objects);
    await dispatchSyncCommand("open", open(3), third.manager);
    expect(third.manager.openRoom(ROOM, "wb_a")!.document.store.getMeta("written-by")).toBe("current");
  });

  it("deletes older generations once a newer one is saved", async () => {
    const objects = createMemoryObjectStore();
    const singapore = node(objects);
    const amsterdam = node(objects);
    await dispatchSyncCommand("open", open(1), singapore.manager);
    await dispatchSyncCommand("handoff", { whiteboardRoomId: ROOM, whiteboardId: "wb_a", generation: 1 }, singapore.manager);
    await dispatchSyncCommand("open", open(2), amsterdam.manager);

    await amsterdam.manager.saveAllRooms();

    expect([...objects.objects.keys()]).toEqual([whiteboardRoomCopyKey(ROOM, 2)]);
  });

  it("hands an idle board off only while no one is connected to it", async () => {
    const objects = createMemoryObjectStore();
    const singapore = node(objects);
    await dispatchSyncCommand("open", open(1), singapore.manager);
    const handoff = { whiteboardRoomId: ROOM, whiteboardId: "wb_a", generation: 1, ifIdle: true };

    const connected = vi.spyOn(Room.prototype, "isEmpty").mockReturnValue(false);
    await expect(dispatchSyncCommand("handoff", handoff, singapore.manager))
      .resolves.toMatchObject({ ok: false, reason: "busy" });
    // Refused before anything changed: the board stays open here.
    expect(singapore.manager.openRoom(ROOM, "wb_a")).not.toBeNull();
    expect(roomDatabaseExists(singapore.dir, ROOM)).toBe(true);

    connected.mockReturnValue(true);
    await expect(dispatchSyncCommand("handoff", handoff, singapore.manager))
      .resolves.toEqual({ ok: true, savedGeneration: 1 });
    connected.mockRestore();
  });

  it("answers a handoff of a board this node does not hold", async () => {
    const { manager } = node(createMemoryObjectStore());

    await expect(dispatchSyncCommand("handoff", { whiteboardRoomId: ROOM, whiteboardId: "wb_a" }, manager))
      .resolves.toEqual({ ok: true, savedGeneration: null });
  });

  it("deletes a purged board's saved copies", async () => {
    const objects = createMemoryObjectStore();
    const { manager } = node(objects);
    await dispatchSyncCommand("open", open(1), manager);
    await manager.saveAllRooms();

    await dispatchSyncCommand("purge", { whiteboardRoomId: ROOM, whiteboardId: "wb_a" }, manager);

    expect(objects.objects.size).toBe(0);
  });
});
