import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { devices, sessions, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";

let db: TestDb;
const now = new Date("2026-05-04T10:00:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
});

describe("remembered device lifetime", () => {
  it("dies with the session that issued it", async () => {
    // A remembered device resolves the account's name, email and avatar on the
    // sign-in screen. Revoking a session from the signed-in devices list used
    // to leave that cookie working, so "sign this device out" did not stop the
    // browser from re-identifying the person who used it.
    await db.insert(users).values({
      id: "usr_1",
      name: "Person",
      email: "person@example.com",
      normalizedEmail: "person@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: "session_1",
      userId: "usr_1",
      tokenHash: "a".repeat(64),
      expiresAt: new Date(now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000 * 30),
      createdAt: now,
    });
    await db.insert(devices).values({
      id: "device_1",
      userId: "usr_1",
      sessionId: "session_1",
      tokenHash: "b".repeat(64),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000 * 30),
    });

    await db.delete(sessions).where(eq(sessions.id, "session_1"));

    await expect(
      db.query.devices.findFirst({ where: { id: "device_1" } }),
    ).resolves.toBeUndefined();
  });
});
