import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { files, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { listFilesImpl } from "./files.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-09-25T10:00:00.000Z");
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
  await seedPersonalSpace(db, "owner");
  await db.insert(files).values(
    [1, 2, 3, 4].map((index) => ({
      id: `file_${index}`,
      spaceId: "owner_space",
      type: "pdf" as const,
      status: "committed" as const,
      r2Key: `spaces/owner_space/uploads/file_${index}.pdf`,
      filename: `file-${index}.pdf`,
      mimeType: "application/pdf" as const,
      size: 100,
      uploadedByUserId: "owner",
      // Newest first: file_4, file_3, file_2, file_1.
      committedAt: new Date(now.getTime() + index * 1000),
      createdAt: new Date(now.getTime() + index * 1000),
    })),
  );
});

function list(cursor?: string) {
  return listFilesImpl({
    data: { spaceId: "owner_space", limit: 2, cursor },
    context: { user: { id: "owner" }, db } as unknown as AuthFnContext,
  });
}

describe("listFilesImpl", () => {
  it("keeps paging after the file a page ended on is deleted", async () => {
    const first = await list();
    expect(first.files.map((file) => file.id)).toEqual(["file_4", "file_3"]);

    await db
      .update(files)
      .set({ status: "deleting", expiresAt: new Date("2026-09-26T10:00:00.000Z") })
      .where(eq(files.id, "file_3"));

    const second = await list(first.nextCursor);
    expect(second.files.map((file) => file.id)).toEqual(["file_2", "file_1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(list("file_3")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
