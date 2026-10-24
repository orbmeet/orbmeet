import { beforeEach, describe, expect, it } from "vitest";
import { files, users, whiteboards } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { finalizePdfFileUploadImpl, grantPdfFileUploadImpl } from "./files.server";

let db: TestDb;

const env = {
  R2_BUCKET_NAME: "bucket",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;

const contextFor = (userId: string) => ({ user: { id: userId }, db, env }) as unknown as AuthFnContext;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-09-25T10:00:00.000Z");
  for (const id of ["uploader", "other"]) {
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      plan: "pro",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
  }
  await seedSharedSpace(db, {
    id: "team",
    ownerUserId: "uploader",
    now,
    members: [{ userId: "uploader", role: "owner" }, { userId: "other" }],
  });
  await db.insert(whiteboards).values({
    id: "whiteboard_1",
    syncRoomId: "whiteboard_1",
    spaceId: "team",
    title: "Board",
    status: "active",
    createdByUserId: "uploader",
    createdAt: now,
    updatedAt: now,
  });
});

describe("finalizePdfFileUploadImpl", () => {
  it("lets only the member who was granted the upload finalize it", async () => {
    const { assetId } = await grantPdfFileUploadImpl({
      data: { whiteboardId: "whiteboard_1", filename: "notes.pdf", fileSize: 1_024 },
      context: contextFor("uploader"),
    });

    await expect(finalizePdfFileUploadImpl({
      data: { whiteboardId: "whiteboard_1", assetId, filename: "notes.pdf" },
      context: contextFor("other"),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.select().from(files)).resolves.toEqual([]);
    // The grant is still the uploader's to finalize.
    await expect(db.query.uploadReservations.findFirst({ where: { id: assetId } })).resolves.toBeDefined();
  });
});
