import { beforeEach, describe, expect, it } from "vitest";
import { devices, sessions, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { revokeAccountAuthenticationExceptCurrent } from "./account-deletion-auth.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

describe("revokeAccountAuthenticationExceptCurrent", () => {
  it("keeps only the deletion continuation session and removes remembered devices", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await db.insert(users).values({
      id: "deleting_user",
      name: "Deleting user",
      email: "deleting@example.com",
      normalizedEmail: "deleting@example.com",
      plan: "free",
      role: "user",
      deletionStartedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values([
      {
        id: "current_session",
        userId: "deleting_user",
        tokenHash: "a".repeat(64),
        expiresAt,
        absoluteExpiresAt: expiresAt,
        createdAt: now,
      },
      {
        id: "other_session",
        userId: "deleting_user",
        tokenHash: "b".repeat(64),
        expiresAt,
        absoluteExpiresAt: expiresAt,
        createdAt: now,
      },
    ]);
    await db.insert(devices).values({
      id: "remembered_device",
      userId: "deleting_user",
      tokenHash: "c".repeat(64),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    });

    await revokeAccountAuthenticationExceptCurrent(
      db,
      "deleting_user",
      "current_session",
    );

    await expect(db.select({ id: sessions.id }).from(sessions)).resolves.toEqual([
      { id: "current_session" },
    ]);
    await expect(db.select().from(devices)).resolves.toEqual([]);
  });
});
