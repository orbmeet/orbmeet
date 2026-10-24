import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { users, whiteboards } from "@orbmeet/db/schema";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {
  installFakeSyncServer,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { archiveWhiteboardImpl, restoreArchivedWhiteboardImpl } from "./api.server";


let db: TestDb;
let context: AuthFnContext;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-07-19T00:00:00.000Z");
  await db.insert(users).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    createdAt: now,
    updatedAt: now,
  });
  const spaceId = await seedPersonalSpace(db, "user_owner", { now });
  await db.insert(whiteboards).values({
    id: "whiteboard_1",
    syncRoomId: "whiteboard_1",
    spaceId,
    title: "Board",
    status: "active",
    createdByUserId: "user_owner",
    createdAt: now,
    updatedAt: now,
  });
  context = {
    db,
    env: { ...TEST_WHITEBOARD_D1_ENV } as unknown as Env,
    user: { id: "user_owner" },
  } as unknown as AuthFnContext;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function boardRow() {
  return db.query.whiteboards.findFirst({
    where: { id: "whiteboard_1" },
    columns: { status: true },
  });
}

describe("archiving a Whiteboard", () => {
  it("archives the sync room first, then records the archive", async () => {
    const { commands } = installFakeSyncServer({
      archive: () => ({ ok: true, status: "archived" }),
    });

    await archiveWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context });

    expect(commands.map((command) => command.name)).toEqual(["archive"]);
    await expect(boardRow()).resolves.toEqual({ status: "archived" });
  });

  it("reopens the sync room when D1 cannot record the archive", async () => {
    const { commands } = installFakeSyncServer({
      archive: async () => {
        // Somebody else archived the board while the room was archiving.
        await db.update(whiteboards)
          .set({ status: "archived", archivedAt: new Date("2026-07-19T00:00:01.000Z") })
          .where(eq(whiteboards.id, "whiteboard_1"));
        return { ok: true, status: "archived" };
      },
      reopen: () => ({ ok: true, status: "reopened" }),
    });

    await expect(
      archiveWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commands.map((command) => command.name)).toEqual(["archive", "reopen"]);
  });

  it("leaves the board active when the sync room refuses to archive", async () => {
    installFakeSyncServer({
      archive: () => ({ ok: false, reason: "unavailable", message: "down" }),
    });

    await expect(
      archiveWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(boardRow()).resolves.toMatchObject({ status: "active" });
  });
});

describe("lifecycle authority", () => {
  it("refuses the board's creator once they have left its Space", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    await db.insert(users).values({
      id: "user_admin",
      name: "Admin",
      email: "admin@example.com",
      normalizedEmail: "admin@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await seedSharedSpace(db, {
      id: "team",
      ownerUserId: "user_admin",
      now,
      members: [{ userId: "user_admin", role: "owner" }],
    });
    await db.update(whiteboards).set({ spaceId: "team" }).where(eq(whiteboards.id, "whiteboard_1"));
    const { commands } = installFakeSyncServer({
      archive: () => ({ ok: true, status: "archived" }),
    });

    await expect(
      archiveWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(commands).toEqual([]);
    await expect(boardRow()).resolves.toEqual({ status: "active" });
  });
});

describe("restoring an archived Whiteboard", () => {
  beforeEach(async () => {
    await db.update(whiteboards)
      .set({ status: "archived", archivedAt: new Date("2026-07-19T00:00:01.000Z") })
      .where(eq(whiteboards.id, "whiteboard_1"));
  });

  it("reopens the sync room once D1 has it active again", async () => {
    const { commands } = installFakeSyncServer({
      reopen: () => ({ ok: true, status: "reopened" }),
    });

    await restoreArchivedWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context });

    expect(commands.map((command) => command.name)).toEqual(["reopen"]);
    await expect(boardRow()).resolves.toMatchObject({ status: "active" });
  });

  it("puts D1 back to archived when the sync room cannot reopen", async () => {
    installFakeSyncServer({
      reopen: () => ({ ok: false, reason: "unavailable", message: "down" }),
    });

    await expect(
      restoreArchivedWhiteboardImpl({ data: { whiteboardId: "whiteboard_1" }, context }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(boardRow()).resolves.toMatchObject({ status: "archived" });
  });
});
