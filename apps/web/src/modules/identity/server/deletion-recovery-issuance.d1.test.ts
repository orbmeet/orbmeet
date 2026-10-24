import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sessions, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { generateId } from "@/lib/ids";
import {
  DELETION_RECOVERY_SESSION_TTL_SECONDS,
  insertActiveAccountSessionStatement,
  insertDeletionResumeSessionStatement,
} from "./session-issuance";
import { getRunChanges } from "@/platform/database/db-utils";

let db: TestDb;
const now = new Date();
const nowSeconds = Math.floor(now.getTime() / 1000);

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values([
    {
      id: "user_active",
      name: "Active",
      email: "active@example.com",
      normalizedEmail: "active@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "user_deleting",
      name: "Deleting",
      email: "deleting@example.com",
      normalizedEmail: "deleting@example.com",
      plan: "free",
      role: "user",
      deletionStartedAt: new Date(now.getTime() - 60_000),
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

async function sessionInput(userId: string) {
  return {
    id: generateId("SESSION"),
    tokenHash: await hashSessionToken(`token-for-${userId}`),
    userId,
    expiresAtSeconds: nowSeconds + DELETION_RECOVERY_SESSION_TTL_SECONDS,
    absoluteExpiresAtSeconds: nowSeconds + DELETION_RECOVERY_SESSION_TTL_SECONDS,
    ipAddress: "203.0.113.9",
    userAgent: "vitest",
    createdAtSeconds: nowSeconds,
  };
}

describe("deletion-resume session issuance", () => {
  it("issues a recovery session only while the deletion gate is closed", async () => {
    const input = await sessionInput("user_deleting");
    const [result] = await db.batch([insertDeletionResumeSessionStatement(db, input)]);
    expect(getRunChanges(result)).toBe(1);

    const row = await db.query.sessions.findFirst();
    expect(row?.userId).toBe("user_deleting");
    // Both expiries are capped at the recovery TTL: nothing ever refreshes or
    // rotates this session, so the row is reclaimable by the daily purge.
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(
      nowSeconds * 1000 + (DELETION_RECOVERY_SESSION_TTL_SECONDS + 5) * 1000,
    );
    expect(row?.absoluteExpiresAt.getTime()).toBe(row?.expiresAt.getTime());
  });

  it("refuses to issue one for an account that is not deletion-gated", async () => {
    const input = await sessionInput("user_active");
    const [result] = await db.batch([insertDeletionResumeSessionStatement(db, input)]);
    expect(getRunChanges(result)).toBe(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("refuses to issue one once the deletion completes between verify and insert", async () => {
    await db.delete(users).where(eq(users.id, "user_deleting"));
    const input = await sessionInput("user_deleting");
    const [result] = await db.batch([insertDeletionResumeSessionStatement(db, input)]);
    expect(getRunChanges(result)).toBe(0);
  });

  it("keeps the ordinary issuance fenced the opposite way", async () => {
    const activeInput = await sessionInput("user_active");
    const [activeResult] = await db.batch([insertActiveAccountSessionStatement(db, activeInput)]);
    expect(getRunChanges(activeResult)).toBe(1);

    // The sign-in statement an authenticated (non-gated) flow uses must never
    // mint a session for a gated account — that fence is what makes the
    // recovery session the only kind a gated sign-in can produce.
    const gatedInput = await sessionInput("user_deleting");
    const [gatedResult] = await db.batch([insertActiveAccountSessionStatement(db, gatedInput)]);
    expect(getRunChanges(gatedResult)).toBe(0);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("user_active");
  });

  it("leaves the recovery session invisible to raw-request session verification", async () => {
    const input = await sessionInput("user_deleting");
    await db.batch([insertDeletionResumeSessionStatement(db, input)]);
    const { verifySessionFromRawRequest } = await import("./session");
    const request = new Request("https://example.com/api/billing/checkout", {
      headers: { Cookie: "session=token-for-user_deleting" },
    });
    // The recovery credential must not reach checkout, portal, or any other
    // raw-API surface: those verify through the ordinary (gated-excluding)
    // path even though a session row exists.
    await expect(verifySessionFromRawRequest(request, env as Env)).resolves.toBeNull();
  });
});
