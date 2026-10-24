import { beforeEach, describe, expect, it } from "vitest";
import { personalAccessTokens, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { createTestDb, type TestDb } from "@/test/db";
import { authenticateAutomationToken, tokenIdFromRaw } from "./bearer-auth";

let db: TestDb;
const now = new Date("2026-07-14T09:00:00.000Z");
const tokenId = "pat_11111111-1111-4111-8111-111111111111";
const rawToken = `orbmeet_${tokenId}.${"a".repeat(64)}`;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values({
    id: "usr_api",
    name: "API User",
    email: "api@example.com",
    normalizedEmail: "api@example.com",
    image: null,
    timeZone: "Asia/Dhaka",
    plan: "pro",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(personalAccessTokens).values({
    id: tokenId,
    userId: "usr_api",
    name: "Codex",
    tokenHash: await hashSessionToken(rawToken),
    tokenPrefix: "orbmeet_pat_1111…",
    scopes: ["meetings:read", "meetings:write"],
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    createdAt: now,
  });
});

describe("automation bearer authentication", () => {
  it("parses the opaque token id without treating the secret as an identifier", () => {
    expect(tokenIdFromRaw(rawToken)).toBe(tokenId);
    expect(tokenIdFromRaw(`orbmeet_${tokenId}.short`)).toBeNull();
    expect(tokenIdFromRaw(`orbmeet_pat_01k0a6vp6wf5x8akz7e3r21n9c.${"a".repeat(64)}`))
      .toBe("pat_01k0a6vp6wf5x8akz7e3r21n9c");
  });

  it("authenticates a valid scoped token and records last use", async () => {
    await expect(
      authenticateAutomationToken(db, rawToken, "meetings:write", now),
    ).resolves.toMatchObject({
      tokenId,
      user: { id: "usr_api", email: "api@example.com", timeZone: "Asia/Dhaka" },
      scopes: ["meetings:read", "meetings:write"],
    });
    await expect(db.query.personalAccessTokens.findFirst({ where: { id: tokenId } })).resolves.toMatchObject({
      lastUsedAt: now,
    });
  });

  it("keeps valid authentication independent from advisory usage telemetry", async () => {
    const failingTelemetryDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => ({
            set: () => ({
              where: () => Promise.reject(new Error("D1 telemetry unavailable")),
            }),
          });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(authenticateAutomationToken(
      failingTelemetryDb,
      rawToken,
      "meetings:read",
      now,
    )).resolves.toMatchObject({ tokenId, user: { id: "usr_api" } });
  });

  it("authenticates without a scope requirement regardless of granted scopes", async () => {
    await db
      .update(personalAccessTokens)
      .set({ scopes: ["meetings:write"] })
      .where(eq(personalAccessTokens.id, tokenId));
    await expect(
      authenticateAutomationToken(db, rawToken, null, now),
    ).resolves.toMatchObject({ tokenId, scopes: ["meetings:write"] });

    const wrongSecret = `orbmeet_${tokenId}.${"b".repeat(64)}`;
    await expect(
      authenticateAutomationToken(db, wrongSecret, null, now),
    ).rejects.toThrow(/authenticated/i);
  });

  it("rejects a wrong secret, missing scope, expiration, and revocation", async () => {
    const wrongSecret = `orbmeet_${tokenId}.${"b".repeat(64)}`;
    await expect(
      authenticateAutomationToken(db, wrongSecret, "meetings:read", now),
    ).rejects.toThrow(/authenticated/i);

    await db
      .update(personalAccessTokens)
      .set({ scopes: ["meetings:read"] })
      .where(eq(personalAccessTokens.id, tokenId));
    await expect(
      authenticateAutomationToken(db, rawToken, "meetings:write", now),
    ).rejects.toThrow(/missing/i);

    await db
      .update(personalAccessTokens)
      .set({ scopes: ["meetings:read"], expiresAt: new Date(now.getTime() + 1_000) })
      .where(eq(personalAccessTokens.id, tokenId));
    await expect(
      authenticateAutomationToken(
        db,
        rawToken,
        "meetings:read",
        new Date(now.getTime() + 2_000),
      ),
    ).rejects.toThrow(/authenticated/i);

    await db
      .update(personalAccessTokens)
      .set({ expiresAt: null, revokedAt: now })
      .where(eq(personalAccessTokens.id, tokenId));
    await expect(
      authenticateAutomationToken(db, rawToken, "meetings:read", now),
    ).rejects.toThrow(/authenticated/i);
  });
});
