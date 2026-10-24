import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sessions, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { verifySessionFromRawRequest } from "./session";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

describe("account deletion session boundary", () => {
  it("rejects an otherwise-valid raw session once deletion starts", async () => {
    const now = new Date();
    const rawToken = "deletion-boundary-session-token";
    await db.insert(users).values({
      id: "user_deleting",
      name: "Deleting user",
      email: "deleting@example.com",
      normalizedEmail: "deleting@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: "session_deleting",
      userId: "user_deleting",
      tokenHash: await hashSessionToken(rawToken),
      expiresAt: new Date(now.getTime() + 60_000),
      absoluteExpiresAt: new Date(now.getTime() + 120_000),
      createdAt: now,
    });
    const request = new Request("https://example.com/api/test", {
      headers: { Cookie: `__Host-session=${rawToken}` },
    });

    await expect(verifySessionFromRawRequest(request, env as Env)).resolves.toEqual({
      sessionId: "session_deleting",
      userId: "user_deleting",
    });

    await db
      .update(users)
      .set({ deletionStartedAt: new Date() })
      .where(eq(users.id, "user_deleting"));
    await expect(verifySessionFromRawRequest(request, env as Env)).resolves.toBeNull();
  });
});
