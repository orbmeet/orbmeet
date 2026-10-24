import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { whiteboardRoomCopyKey } from "@orbmeet/whiteboard-core/document-keys";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { dispatchSyncCommand } from "../http/commands.ts";
import { createMemoryObjectStore, type ObjectStore } from "../persistence/r2.ts";
import { openSqliteDatabase } from "../persistence/sqlite.ts";
import { RoomManager } from "./room-manager.ts";
import { fakeAuthority } from "./room-test-support.ts";

const ROOM = "meet-saves" as WhiteboardRoomId;
const managers: RoomManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An object store whose uploads wait until the test lets them through. */
function gatedObjects() {
  const objects = createMemoryObjectStore();
  const waiting: Array<() => void> = [];
  let puts = 0;
  const store: ObjectStore = {
    ...objects,
    async put(key, body, metadata, expectedEtag) {
      puts += 1;
      await new Promise<void>((release) => waiting.push(release));
      await objects.put(key, body, metadata, expectedEtag);
    },
  };
  return {
    store,
    objects,
    puts: () => puts,
    async releaseNext() {
      while (waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      waiting.shift()!();
    },
  };
}

async function openRoom(objects: ObjectStore): Promise<{ dir: string; manager: RoomManager }> {
  const dir = mkdtempSync(join(tmpdir(), "wb-saves-"));
  dirs.push(dir);
  const manager = new RoomManager(dir, { objects, authority: fakeAuthority() });
  managers.push(manager);
  await dispatchSyncCommand(
    "open",
    { whiteboardRoomId: ROOM, whiteboardId: "wb_saves", commandId: "cmd-open-saves", generation: 1 },
    manager,
  );
  return { dir, manager };
}

/** Change the room's database the way a write would, so its fingerprint moves on. */
function touch(dir: string, value: string): void {
  const db = openSqliteDatabase(join(dir, `${ROOM}.db`));
  try {
    db.prepare("INSERT OR REPLACE INTO whiteboard_meta (key, value) VALUES ('test-touch', ?)").run(value);
  } finally {
    db.close();
  }
}

describe("saving rooms to R2", () => {
  it("joins a save already running for a room instead of queueing another behind it", async () => {
    const gated = gatedObjects();
    const { manager } = await openRoom(gated.store);

    const first = manager.saveRooms([ROOM], { fresh: false });
    const second = manager.saveRooms([ROOM], { fresh: false });
    await gated.releaseNext();
    await Promise.all([first, second]);

    expect(gated.puts()).toBe(1);
    expect(gated.objects.objects.has(whiteboardRoomCopyKey(ROOM, 1))).toBe(true);
  });

  it("saves again after a running save when asked for everything written so far", async () => {
    const gated = gatedObjects();
    const { dir, manager } = await openRoom(gated.store);

    const periodic = manager.saveRooms([ROOM], { fresh: false });
    while (gated.puts() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // Written after the running save copied the database.
    touch(dir, "after-the-copy");
    const shutdown = manager.saveRooms([ROOM], { fresh: true });
    await gated.releaseNext();
    await gated.releaseNext();
    await Promise.all([periodic, shutdown]);

    expect(gated.puts()).toBe(2);
  });

  it("lets a save already on its way land before a purge deletes the copies, and starts none after", async () => {
    const gated = gatedObjects();
    const { dir, manager } = await openRoom(gated.store);

    const periodic = manager.saveRooms([ROOM], { fresh: false });
    while (gated.puts() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const purge = dispatchSyncCommand("purge", { whiteboardRoomId: ROOM, whiteboardId: "wb_saves" }, manager);
    // A round that comes due while the purge waits saves nothing.
    touch(dir, "during-the-purge");
    const queued = manager.saveRooms([ROOM], { fresh: true });
    await gated.releaseNext();
    await Promise.all([periodic, purge, queued]);

    expect(gated.puts()).toBe(1);
    expect([...gated.objects.objects.keys()].filter((key) => key.includes(ROOM))).toEqual([]);
  });

  it("skips a room that has not changed since its last saved copy", async () => {
    const objects = createMemoryObjectStore();
    let puts = 0;
    const counting: ObjectStore = { ...objects, put: async (...args) => { puts += 1; await objects.put(...args); } };
    const { manager } = await openRoom(counting);

    await manager.saveRooms([ROOM], { fresh: true });
    await manager.saveRooms([ROOM], { fresh: true });

    expect(puts).toBe(1);
  });
});
