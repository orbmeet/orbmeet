import { describe, expect, it } from "vitest";
import { devices, sessions, users, verifications } from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { cleanupExpiredAuthenticationData } from "./maintenance.server";

describe("authentication maintenance", () => {
  it("purges expired authentication records without touching active ones", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    const createdAt = new Date(now.getTime() - 24 * 60 * 60_000);
    const expiredAt = new Date(now.getTime() - 60_000);
    const activeUntil = new Date(now.getTime() + 60_000);
    await db.insert(users).values({
      id: "user_1",
      name: "User",
      email: "user@example.com",
      normalizedEmail: "user@example.com",
      plan: "free",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(sessions).values([
      {
        id: "session_expired",
        tokenHash: "a".repeat(64),
        userId: "user_1",
        expiresAt: expiredAt,
        absoluteExpiresAt: activeUntil,
        createdAt,
      },
      {
        id: "session_active",
        tokenHash: "b".repeat(64),
        userId: "user_1",
        expiresAt: activeUntil,
        absoluteExpiresAt: activeUntil,
        createdAt,
      },
    ]);
    await db.insert(devices).values([
      {
        id: "device_expired",
        userId: "user_1",
        tokenHash: "c".repeat(64),
        expiresAt: expiredAt,
        createdAt,
      },
      {
        id: "device_active",
        userId: "user_1",
        tokenHash: "d".repeat(64),
        expiresAt: activeUntil,
        createdAt,
      },
    ]);
    await db.insert(verifications).values([
      {
        id: "verification_expired",
        type: "otp_login",
        identifier: "expired@example.com",
        value: "expired",
        expiresAt: expiredAt,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "verification_active",
        type: "otp_login",
        identifier: "active@example.com",
        value: "active",
        expiresAt: activeUntil,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await expect(cleanupExpiredAuthenticationData(db, now)).resolves.toEqual({
      sessions: 1,
      devices: 1,
      verifications: 1,
    });
    expect((await db.select().from(sessions)).map((row) => row.id)).toEqual(["session_active"]);
    expect((await db.select().from(devices)).map((row) => row.id)).toEqual(["device_active"]);
    expect((await db.select().from(verifications)).map((row) => row.id)).toEqual([
      "verification_active",
    ]);
  });
});
