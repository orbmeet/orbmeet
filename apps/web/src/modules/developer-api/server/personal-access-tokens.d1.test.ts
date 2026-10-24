import { beforeEach, describe, expect, it } from "vitest";
import { personalAccessTokens, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  insertPersonalAccessTokenWithinCap,
} from "./personal-access-tokens.server";
import { revokeAllPersonalAccessTokens } from "@/modules/identity/server/credential-revocation";

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
});

describe("personal access token cap", () => {
  it("admits only one concurrent insert at the final available slot", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    await db.insert(personalAccessTokens).values(
      Array.from({ length: 9 }, (_, index) => ({
        id: `token-${index}`,
        userId: "owner",
        name: `Token ${index}`,
        tokenHash: `hash-${index}`.padEnd(64, "x"),
        tokenPrefix: `prefix-${index}`,
        scopes: ["meetings:read" as const],
        createdAt: now,
      })),
    );

    const makeToken = (id: string) => ({
      id,
      userId: "owner",
      name: id,
      tokenHash: `hash-${id}`.padEnd(64, "x"),
      tokenPrefix: `prefix-${id}`,
      scopes: ["meetings:read" as const],
      createdAt: now,
    });
    const results = await Promise.all([
      insertPersonalAccessTokenWithinCap(appDb(), makeToken("candidate-a"), now),
      insertPersonalAccessTokenWithinCap(appDb(), makeToken("candidate-b"), now),
    ]);

    expect(results.sort()).toEqual([false, true]);
    await expect(db.select().from(personalAccessTokens)).resolves.toHaveLength(10);
  });
});

describe("revokeAllPersonalAccessTokens", () => {
  const seed = async (rows: Array<{ id: string; userId: string; revokedAt?: Date }>) => {
    await db.insert(personalAccessTokens).values(
      rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.id,
        tokenHash: `hash-${row.id}`.padEnd(64, "x"),
        tokenPrefix: `prefix-${row.id}`,
        scopes: ["meetings:read" as const, "meetings:write" as const],
        revokedAt: row.revokedAt ?? null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    );
  };

  it("revokes every live key for the user and leaves other accounts alone", async () => {
    const now = new Date();
    await db.insert(users).values({
      id: "other",
      name: "Other",
      email: "other@example.com",
      normalizedEmail: "other@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await seed([
      { id: "live-1", userId: "owner" },
      { id: "live-2", userId: "owner" },
      { id: "bystander", userId: "other" },
    ]);

    const revokedAt = new Date("2026-09-03T10:00:00.000Z");
    expect(await revokeAllPersonalAccessTokens(appDb(), "owner", revokedAt)).toBe(2);

    const rows = await db.select().from(personalAccessTokens);
    const byId = new Map(rows.map((row) => [row.id, row.revokedAt]));
    expect(byId.get("live-1")).toEqual(revokedAt);
    expect(byId.get("live-2")).toEqual(revokedAt);
    // A key belonging to another account is not part of this user's recovery.
    expect(byId.get("bystander")).toBeNull();
  });

  it("is idempotent and does not re-stamp an already revoked key", async () => {
    const firstRevocation = new Date("2026-08-01T00:00:00.000Z");
    await seed([{ id: "already", userId: "owner", revokedAt: firstRevocation }]);

    expect(
      await revokeAllPersonalAccessTokens(appDb(), "owner", new Date("2026-09-03T10:00:00.000Z")),
    ).toBe(0);

    const [row] = await db.select().from(personalAccessTokens);
    expect(row.revokedAt).toEqual(firstRevocation);
  });
});
