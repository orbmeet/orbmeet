import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWhiteboardRoomSnapshot } from "@orbmeet/whiteboard-core/room-snapshot-validation";
import { whiteboardRevisionKey, whiteboardRoomCopyKey } from "@orbmeet/whiteboard-core/document-keys";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { RoomManager } from "../rooms/room-manager.ts";
import { fakeAuthority } from "../rooms/room-test-support.ts";
import { createMemoryObjectStore, type ObjectStore } from "../persistence/r2.ts";
import { roomDatabaseExists } from "../persistence/room-storage.ts";
import { SnapshotStore } from "../persistence/snapshot-store.ts";
import { dispatchSyncCommand } from "./commands.ts";
import { createAuthorityClient } from "./authority-client.ts";
import { TEST_CALLBACK_KEYRING } from "./test-keyrings.ts";

const managers: RoomManager[] = [];
const dirs: string[] = [];

function startManager(dir: string, objects: ObjectStore): RoomManager {
  const manager = new RoomManager(dir, { objects, authority: fakeAuthority() });
  managers.push(manager);
  return manager;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-commands-"));
  dirs.push(dir);
  const objects = createMemoryObjectStore();
  const manager = startManager(dir, objects);
  /** Stop this process and start another on the same disk. */
  const restart = async () => {
    await manager.closeAll();
    return startManager(dir, objects);
  };
  return { dir, manager, objects, snapshots: new SnapshotStore(objects), restart };
}

const target = (room: string, board: string, commandId: string) => ({
  whiteboardRoomId: room,
  whiteboardId: board,
  commandId,
});

function pageCount(manager: RoomManager, room: string, board: string): number {
  const snapshot = manager.openRoom(room as WhiteboardRoomId, board)!.document.currentSnapshot();
  return snapshot.documents.filter((document) => document.state.typeName === "shape").length;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("live commands", () => {
  it("answers retryably for a board nobody has reconnected to since a restart", async () => {
    const { manager, restart } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);
    const restarted = await restart();
    await expect(dispatchSyncCommand("pagePresentValidate", {
      whiteboardRoomId: "meet-a",
      userId: "user_a",
      connectionId: "connection_a",
      pageId: "shape:page",
    }, restarted)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("document commands", () => {
  it("keeps a board in its room database across a restart, saving a copy to R2 as it stops", async () => {
    const { manager, objects, restart } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);
    expect(pageCount(manager, "meet-a", "wb_a")).toBe(1);

    const next = await restart();
    expect([...objects.objects.keys()]).toEqual([whiteboardRoomCopyKey("meet-a", 0)]);
    // Served from its database, not the copy.
    objects.objects.clear();
    expect(pageCount(next, "meet-a", "wb_a")).toBe(1);
  });

  it("keeps an archived board archived across a restart", async () => {
    const { manager, restart } = setup();
    await dispatchSyncCommand("archive", target("meet-a", "wb_a", "cmd-archive-a"), manager);

    const next = await restart();
    await expect(dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), next))
      .resolves.toMatchObject({ ok: false, reason: "archived" });
    await dispatchSyncCommand("reopen", target("meet-a", "wb_a", "cmd-reopen-a"), next);
    await expect(dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a2"), next))
      .resolves.toMatchObject({ ok: true });
  });

  it("returns a restore's first outcome to a retry after a restart", async () => {
    const { manager, restart } = setup();
    const empty = whiteboardRevisionKey("wb_a", "rev_empty");
    const kept = whiteboardRevisionKey("wb_a", "rev_kept");
    await dispatchSyncCommand("capture", { ...target("meet-a", "wb_a", "cmd-capture-a"), toKey: empty }, manager);
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);

    const restore = { ...target("meet-a", "wb_a", "cmd-restore-a"), sourceKey: empty, restorePointKey: kept };
    await expect(dispatchSyncCommand("restore", restore, manager))
      .resolves.toMatchObject({ ok: true, restorePoint: { key: kept } });
    expect(pageCount(manager, "meet-a", "wb_a")).toBe(0);

    const next = await restart();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a2"), next);
    await expect(dispatchSyncCommand("restore", restore, next))
      .resolves.toMatchObject({ ok: true, restorePoint: { key: kept } });
    // The retry answered from the record; it did not restore again.
    expect(pageCount(next, "meet-a", "wb_a")).toBe(1);
  });

  it("seeds a new board from a revision, and answers a retry the same way", async () => {
    const { manager, snapshots } = setup();
    const source = whiteboardRevisionKey("wb_source", "rev_1");
    await snapshots.writeAt(source, createEmptyWhiteboardRoomSnapshot());
    const seed = { ...target("meet-copy", "wb_copy", "cmd-seed-copy"), source: { key: source } };

    await expect(dispatchSyncCommand("seed", seed, manager)).resolves.toEqual({ ok: true, assetKeys: [] });
    await expect(dispatchSyncCommand("seed", seed, manager)).resolves.toEqual({ ok: true, assetKeys: [] });
    await expect(dispatchSyncCommand("seed", { ...seed, commandId: "cmd-seed-other" }, manager))
      .resolves.toMatchObject({ ok: false, reason: "conflict" });
  });

  it("seeds a new board from another board's live state", async () => {
    const { manager } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);

    const seed = {
      ...target("meet-b", "wb_b", "cmd-seed-b"),
      source: { whiteboardRoomId: "meet-a", whiteboardId: "wb_a" },
    };
    await expect(dispatchSyncCommand("seed", seed, manager)).resolves.toMatchObject({ ok: true });
    expect(pageCount(manager, "meet-b", "wb_b")).toBe(1);
  });

  it("never seeds over a board that already has state", async () => {
    const { manager } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);
    await dispatchSyncCommand("open", target("meet-b", "wb_b", "cmd-open-b"), manager);

    const seed = {
      ...target("meet-b", "wb_b", "cmd-seed-b"),
      source: { whiteboardRoomId: "meet-a", whiteboardId: "wb_a" },
    };
    await expect(dispatchSyncCommand("seed", seed, manager))
      .resolves.toMatchObject({ ok: false, reason: "conflict" });
  });

  it("seeds an empty board from one nobody has opened, and leaves that board without a database", async () => {
    const { dir, manager } = setup();
    const seed = {
      ...target("meet-b", "wb_b", "cmd-seed-b"),
      source: { whiteboardRoomId: "meet-a", whiteboardId: "wb_a" },
    };
    await expect(dispatchSyncCommand("seed", seed, manager)).resolves.toEqual({ ok: true, assetKeys: [] });
    expect(roomDatabaseExists(dir, "meet-b")).toBe(true);
    expect(roomDatabaseExists(dir, "meet-a")).toBe(false);
  });

  it("lets a running capture finish before a purge deletes the board, and takes no work meanwhile", async () => {
    const { dir, manager, objects } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);
    // Hold the capture's upload open until the purge has been asked for.
    let releaseUpload!: () => void;
    const uploadHeld = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const put = objects.put.bind(objects);
    objects.put = async (...args) => {
      await uploadHeld;
      return put(...args);
    };
    const toKey = whiteboardRevisionKey("wb_a", "rev_1");
    const capture = dispatchSyncCommand("capture", { ...target("meet-a", "wb_a", "cmd-capture-a"), toKey }, manager);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const purge = dispatchSyncCommand("purge", { whiteboardRoomId: "meet-a", whiteboardId: "wb_a" }, manager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The database is still there while the capture runs, and the board takes nothing new.
    expect(roomDatabaseExists(dir, "meet-a")).toBe(true);
    expect(manager.openRoom("meet-a", "wb_a")).toBeNull();
    // Live work too: sockets and live commands find no room while it drains.
    expect(manager.getRoomIfExists("meet-a")).toBeNull();
    await expect(dispatchSyncCommand("refreshAuthority", { whiteboardRoomId: "meet-a" }, manager))
      .resolves.toEqual({ ok: true, status: "not_resident" });
    await expect(dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-again"), manager))
      .resolves.toMatchObject({ ok: false, reason: "unavailable" });

    releaseUpload();
    await expect(capture).resolves.toMatchObject({ ok: true, copy: { key: toKey } });
    await expect(purge).resolves.toEqual({ ok: true, status: "purged" });
    expect(roomDatabaseExists(dir, "meet-a")).toBe(false);
  });

  it("purges a board: its room closes and its database is deleted", async () => {
    const { dir, manager } = setup();
    await dispatchSyncCommand("open", target("meet-a", "wb_a", "cmd-open-a"), manager);

    const purge = { whiteboardRoomId: "meet-a", whiteboardId: "wb_a" };
    await expect(dispatchSyncCommand("purge", purge, manager)).resolves.toEqual({ ok: true, status: "purged" });
    expect(manager.roomCount).toBe(0);
    expect(roomDatabaseExists(dir, "meet-a")).toBe(false);
    await expect(dispatchSyncCommand("purge", purge, manager)).resolves.toEqual({ ok: true, status: "purged" });
  });

  it("leaves a database it cannot open where it is, and does not serve it", async () => {
    const { dir, manager } = setup();
    const path = join(dir, "meet-bad.db");
    writeFileSync(path, "not a database");

    await expect(dispatchSyncCommand("open", target("meet-bad", "wb_bad", "cmd-open-bad"), manager))
      .resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(readFileSync(path, "utf8")).toBe("not a database");
  });

  it("copies stored snapshots only into revision keys", async () => {
    const { manager, snapshots } = setup();
    const source = whiteboardRevisionKey("wb_a", "rev_1");
    await snapshots.writeAt(source, createEmptyWhiteboardRoomSnapshot());

    await expect(dispatchSyncCommand(
      "copySnapshot",
      { sourceKey: source, destinationKey: whiteboardRevisionKey("wb_b", "rev_2") },
      manager,
    )).resolves.toMatchObject({ ok: true, copy: { key: whiteboardRevisionKey("wb_b", "rev_2") } });
    await expect(dispatchSyncCommand(
      "copySnapshot",
      { sourceKey: source, destinationKey: "internal/whiteboards/wb_b/state/current.json" },
      manager,
    )).resolves.toMatchObject({ ok: false, reason: "invalid" });
  });

  it("only reads whiteboard snapshot keys", async () => {
    const { manager } = setup();
    await expect(
      dispatchSyncCommand("readSnapshot", { key: "spaces/s1/uploads/secret.pdf" }, manager),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
  });

  it("validates document command targets at the boundary", async () => {
    const { manager } = setup();
    await expect(
      dispatchSyncCommand(
        "archive",
        { whiteboardRoomId: "meet-x", whiteboardId: "../escape", commandId: "cmd-archive-x" },
        manager,
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
    await expect(
      dispatchSyncCommand(
        "archive",
        { whiteboardRoomId: "meet-x", whiteboardId: "wb_x", commandId: "short" },
        manager,
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
  });

  it("answers a live command for a cold room without opening it", async () => {
    const { manager } = setup();
    await expect(
      dispatchSyncCommand("refreshAuthority", { whiteboardRoomId: "meet-cold" }, manager),
    ).resolves.toEqual({ ok: true, status: "not_resident" });
    expect(manager.roomCount).toBe(0);
  });
});

describe("authority client", () => {
  const claim = {
    sub: "user-1",
    role: "participant",
    connectionId: "conn-1",
    grantPrincipalKey: "user:user-1",
    capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
  };

  function client(respond: (request: Request) => Response | Promise<Response>) {
    const requests: Request[] = [];
    const authority = createAuthorityClient({
      appUrl: "https://app.example",
      keyring: TEST_CALLBACK_KEYRING,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return respond(request);
      },
    });
    return { authority, requests };
  }

  it("signs its request and returns the Worker's verdicts", async () => {
    const { authority, requests } = client(() => Response.json({ verdicts: ["refresh"] }));
    await expect(authority.verdicts("meet-a", [claim])).resolves.toEqual(["refresh"]);
    expect(requests[0].headers.get("X-Orbmeet-Signature")).toMatch(/^v1,kid=cb1,/);
  });

  it("reads a failure, a malformed answer, or a mismatched count as unavailable", async () => {
    await expect(client(() => new Response("no", { status: 500 })).authority.verdicts("meet-a", [claim]))
      .resolves.toBe("unavailable");
    await expect(client(() => Response.json({ verdicts: ["maybe"] })).authority.verdicts("meet-a", [claim]))
      .resolves.toBe("unavailable");
    await expect(client(() => Response.json({ verdicts: [] })).authority.verdicts("meet-a", [claim]))
      .resolves.toBe("unavailable");
  });
});
