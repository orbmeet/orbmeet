import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  files,
  spaces,
  users,
  whiteboardFileReferences,
  whiteboards,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { cleanupFileOperations } from "./file-maintenance";

// The maintenance path also runs the promotion-intent reconciliation sweep,
// which enumerates its prefix; these tests only exercise the deletion half, so
// an empty listing keeps the fake bucket honest about that contract.
const emptyIntentListing = {
  list: vi.fn(async () => ({ objects: [], truncated: false })),
};

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
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
  await db.insert(whiteboards).values({
    id: "whiteboard_1",
    syncRoomId: "whiteboard_1",
    spaceId: "space_1",
    title: "Board",
    createdByUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
});

async function insertDeletingFile(now: Date) {
  const createdAt = new Date(now.getTime() - 2_000);
  await db.insert(files).values({
    id: "file_1",
    spaceId: "space_1",
    type: "pdf",
    status: "deleting",
    r2Key: "spaces/space_1/uploads/file_1.pdf",
    filename: "source.pdf",
    mimeType: "application/pdf",
    size: 100,
    uploadedByUserId: "owner",
    expiresAt: new Date(now.getTime() - 1_000),
    committedAt: createdAt,
    createdAt,
  });
  await db.insert(whiteboardFileReferences).values({
    whiteboardId: "whiteboard_1",
    fileId: "file_1",
    spaceId: "space_1",
    role: "source",
    createdAt,
  });
}

describe("cleanupFileOperations", () => {
  it("removes the object, File row, and its source provenance", async () => {
    const now = new Date();
    await insertDeletingFile(now);
    const remove = vi.fn(async () => undefined);

    await cleanupFileOperations(appDb(), {
      R2_BUCKET: { delete: remove, ...emptyIntentListing } as unknown as R2Bucket,
    } as Env, now);

    expect(remove).toHaveBeenCalledWith("spaces/space_1/uploads/file_1.pdf");
    await expect(db.query.files.findFirst({ where: { id: "file_1" } })).resolves.toBeUndefined();
    await expect(db.select().from(whiteboardFileReferences)).resolves.toEqual([]);
    await expect(db.query.whiteboards.findFirst({ where: { id: "whiteboard_1" } })).resolves.toBeDefined();
  });

  it("keeps the durable deletion intent when object removal fails", async () => {
    const now = new Date();
    await insertDeletingFile(now);
    const failure = new Error("R2 unavailable");

    await expect(cleanupFileOperations(appDb(), {
      R2_BUCKET: { delete: vi.fn(async () => { throw failure; }), ...emptyIntentListing } as unknown as R2Bucket,
    } as Env, now)).rejects.toThrow("File cleanup failed");

    await expect(db.query.files.findFirst({ where: { id: "file_1" } })).resolves.toMatchObject({
      status: "deleting",
    });
    await expect(db.select().from(whiteboardFileReferences)).resolves.toHaveLength(1);
  });
});
