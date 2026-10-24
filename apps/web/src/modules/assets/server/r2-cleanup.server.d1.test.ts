import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@orbmeet/db/schema";
import { files, r2ObjectCleanupTasks, spaces, users } from "@orbmeet/db/schema";
import { eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createTestDb, type TestDb } from "@/test/db";
import {
  cleanupQueuedR2Objects,
  createR2CleanupBudget,
  deleteR2Prefix,
  enqueueR2ObjectCleanup,
  keepR2ObjectStatement,
  r2CleanupRetryDelayMs,
  r2KeyBeingDeletedSql,
  r2ReferencedRecheckDelayMs,
} from "./r2-cleanup.server";

let db: TestDb;
const appDb = () => db;

/** Whether a reference to `key` would be refused right now. */
async function beingDeleted(key: string): Promise<boolean> {
  const row = await db.get<{ deleting: number }>(sql`select ${r2KeyBeingDeletedSql(key)} as deleting`);
  return row?.deleting === 1;
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("deleteR2Prefix progress", () => {
  it("marks and forgets more keys than one D1 parameter chunk", async () => {
    const keys = Array.from(
      { length: 60 },
      (_, index) => `meetings/one/assets/${String(index).padStart(2, "0")}.png`,
    );
    const bucket = {
      list: vi.fn(async () => ({
        objects: keys.map((key) => ({ key })),
        truncated: false,
      })),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket;

    await expect(deleteR2Prefix(appDb(), bucket, "meetings/one/"))
      .resolves.toBeUndefined();

    expect(bucket.delete).toHaveBeenCalledWith(keys);
    await expect(db.select().from(r2ObjectCleanupTasks)).resolves.toEqual([]);
  });

  it("resumes from a durable cursor after an operation budget is exhausted", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        objects: [{ key: "meetings/one/first" }],
        truncated: true,
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        objects: [{ key: "meetings/one/second" }],
        truncated: false,
      });
    const remove = vi.fn(async () => undefined);
    const bucket = { list, delete: remove } as unknown as R2Bucket;

    await expect(deleteR2Prefix(
      appDb(),
      bucket,
      "meetings/one/",
      createR2CleanupBudget(2),
    )).rejects.toThrow("operation budget exhausted");
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: 1000 });
    await expect(db.query.maintenanceCursors.findFirst({
      where: { job: "r2:meetings/one/" },
    })).resolves.toMatchObject({ cursorId: "page-2" });

    await expect(deleteR2Prefix(
      appDb(),
      bucket,
      "meetings/one/",
      createR2CleanupBudget(2),
    )).resolves.toBeUndefined();

    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: "page-2" });
    expect(remove).toHaveBeenNthCalledWith(1, ["meetings/one/first"]);
    expect(remove).toHaveBeenNthCalledWith(2, ["meetings/one/second"]);
    await expect(db.query.maintenanceCursors.findFirst({
      where: { job: "r2:meetings/one/" },
    })).resolves.toBeUndefined();
  });

  it("refuses new references to a key while its object is being deleted", async () => {
    const key = "whiteboards/source/assets/image.png";
    const refusedDuringDelete: boolean[] = [];
    const bucket = {
      list: vi.fn(async () => ({ objects: [{ key }], truncated: false })),
      delete: vi.fn(async () => {
        refusedDuringDelete.push(await beingDeleted(key));
      }),
    } as unknown as R2Bucket;

    await deleteR2Prefix(appDb(), bucket, "whiteboards/source/");

    expect(refusedDuringDelete).toEqual([true]);
    await expect(beingDeleted(key)).resolves.toBe(false);
  });
});

describe("durable object cleanup", () => {
  it("waits through the mutation grace period and then deletes an unreferenced key", async () => {
    const bucket = { delete: vi.fn(async () => undefined) } as unknown as R2Bucket;
    const queuedAt = new Date("2026-08-22T00:00:00Z");
    await enqueueR2ObjectCleanup(appDb(), ["whiteboards/source/assets/image.png"], queuedAt);

    await expect(cleanupQueuedR2Objects(
      appDb(),
      bucket,
      new Date(queuedAt.getTime() + 9 * 60_000),
    )).resolves.toBe(0);
    await expect(cleanupQueuedR2Objects(
      appDb(),
      bucket,
      new Date(queuedAt.getTime() + 11 * 60_000),
    )).resolves.toBe(1);
    expect(bucket.delete).toHaveBeenCalledWith("whiteboards/source/assets/image.png");
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toBeUndefined();
  });

  it("marks an unreferenced key deleting before its object goes, and forgets it after", async () => {
    const key = "whiteboards/source/assets/image.png";
    const queuedAt = new Date("2026-08-22T00:00:00Z");
    await enqueueR2ObjectCleanup(appDb(), [key], queuedAt);
    const refusedDuringDelete: boolean[] = [];
    const bucket = {
      delete: vi.fn(async () => {
        refusedDuringDelete.push(await beingDeleted(key));
      }),
    } as unknown as R2Bucket;

    await expect(cleanupQueuedR2Objects(appDb(), bucket, new Date(queuedAt.getTime() + 11 * 60_000)))
      .resolves.toBe(1);

    expect(refusedDuringDelete).toEqual([true]);
    await expect(beingDeleted(key)).resolves.toBe(false);
  });

  it("finishes a deletion an earlier pass marked but did not complete", async () => {
    const key = "whiteboards/source/assets/image.png";
    const queuedAt = new Date("2026-08-22T00:00:00Z");
    await enqueueR2ObjectCleanup(appDb(), [key], queuedAt);
    await db.update(r2ObjectCleanupTasks).set({ deletingAt: queuedAt }).where(eq(r2ObjectCleanupTasks.r2Key, key));
    const bucket = { delete: vi.fn(async () => undefined) } as unknown as R2Bucket;

    await expect(cleanupQueuedR2Objects(appDb(), bucket, new Date(queuedAt.getTime() + 11 * 60_000)))
      .resolves.toBe(1);
    expect(bucket.delete).toHaveBeenCalledWith(key);
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toBeUndefined();
  });

  it("backs failed deletes out of the head of the queue", async () => {
    const queuedAt = new Date("2026-08-22T00:00:00Z");
    const dueAt = new Date(queuedAt.getTime() + 11 * 60_000);
    const bucket = {
      delete: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    } as unknown as R2Bucket;
    await enqueueR2ObjectCleanup(appDb(), ["whiteboards/source/assets/image.png"], queuedAt);

    await expect(cleanupQueuedR2Objects(appDb(), bucket, dueAt)).resolves.toBe(0);
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toMatchObject({
      attempts: 1,
      lastError: "R2 unavailable",
      notBefore: new Date(dueAt.getTime() + r2CleanupRetryDelayMs(1)),
    });
  });

  it("resets retry history when a fresh deletion intent re-enqueues a key", async () => {
    const queuedAt = new Date("2026-08-22T00:00:00Z");
    const failedAt = new Date(queuedAt.getTime() + 11 * 60_000);
    const bucket = {
      delete: vi.fn(async () => { throw new Error("R2 unavailable"); }),
    } as unknown as R2Bucket;
    await enqueueR2ObjectCleanup(appDb(), ["whiteboards/source/assets/image.png"], queuedAt);
    await cleanupQueuedR2Objects(appDb(), bucket, failedAt);

    await enqueueR2ObjectCleanup(
      appDb(),
      ["whiteboards/source/assets/image.png"],
      new Date(failedAt.getTime() + 1),
    );

    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toMatchObject({
      attempts: 0,
      lastError: null,
    });
  });

  it("moves referenced objects out of the hot queue with stable jitter", async () => {
    const now = new Date("2026-08-23T00:00:00Z");
    const key = "spaces/space_1/uploads/file_1.pdf";
    await db.insert(users).values({
      id: "owner",
      name: "Owner",
      email: "owner@example.com",
      normalizedEmail: "owner@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      id: "space_1",
      slug: "space-1",
      name: "Space",
      kind: "shared",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(files).values({
      id: "file_1",
      spaceId: "space_1",
      type: "pdf",
      status: "committed",
      r2Key: key,
      filename: "file.pdf",
      mimeType: "application/pdf",
      size: 10,
      uploadedByUserId: "owner",
      committedAt: now,
      createdAt: now,
    });
    await enqueueR2ObjectCleanup(appDb(), [key], new Date(now.getTime() - 11 * 60_000));
    const bucket = { delete: vi.fn(async () => undefined) } as unknown as R2Bucket;

    await expect(cleanupQueuedR2Objects(appDb(), bucket, now)).resolves.toBe(0);
    expect(bucket.delete).not.toHaveBeenCalled();
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toMatchObject({
      r2Key: key,
      notBefore: new Date(now.getTime() + r2ReferencedRecheckDelayMs(key)),
      lastError: null,
    });
  });
});

describe("what the cleanup queue counts as a reference", () => {
  // A column holding an R2 key the queue does not know of is a reference it
  // would delete the object under. Not references: the queue's own rows, and
  // a retired column nothing writes (see its note in the schema).
  const NOT_REFERENCES = new Set(["r2_object_cleanup_tasks.r2_key", "whiteboards.current_snapshot_r2_key"]);

  it("knows every column that holds an R2 key", () => {
    const columns = (Object.values(schema) as unknown[])
      .filter((value): value is SQLiteTable => is(value, SQLiteTable))
      .flatMap((table) => Object.values(getTableColumns(table))
        .filter((column) => column.name.endsWith("r2_key"))
        .map((column) => `${getTableName(table)}.${column.name}`))
      .filter((column) => !NOT_REFERENCES.has(column));
    const predicate = keepR2ObjectStatement(appDb(), "key").toSQL().sql.replaceAll('"', "");

    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((column) => !predicate.includes(column))).toEqual([]);
  });

  it("takes back an owed object only once a row refers to it", async () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const key = "spaces/space_1/uploads/file_1.pdf";
    await db.insert(users).values({
      id: "owner", name: "Owner", email: "owner@example.com", normalizedEmail: "owner@example.com",
      plan: "free", role: "user", createdAt: now, updatedAt: now,
    });
    await db.insert(spaces).values({
      id: "space_1", slug: "space-1", name: "Space", kind: "shared", ownerUserId: "owner", createdAt: now, updatedAt: now,
    });
    await enqueueR2ObjectCleanup(appDb(), [key], now);

    await keepR2ObjectStatement(appDb(), key);
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toMatchObject({ r2Key: key });

    await db.insert(files).values({
      id: "file_1", spaceId: "space_1", type: "pdf", status: "committed", r2Key: key, filename: "file.pdf",
      mimeType: "application/pdf", size: 10, uploadedByUserId: "owner", committedAt: now, createdAt: now,
    });
    await keepR2ObjectStatement(appDb(), key);
    await expect(db.query.r2ObjectCleanupTasks.findFirst()).resolves.toBeUndefined();
  });
});
