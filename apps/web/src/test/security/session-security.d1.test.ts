import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { users, sessions } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import {
  maybeRefreshSession,
  verifySessionFromRawRequest,
} from "@/modules/identity/server/session";
import { hashSessionToken, generateSessionToken } from "@/platform/crypto/tokens.server";
import {
  SESSION_EXPIRY_MS,
  SESSION_REFRESH_THRESHOLD_MS,
  SESSION_ROTATION_GRACE_MS,
} from "@/modules/identity/contract/auth/constants";
import { env } from "cloudflare:workers";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

function createMockEnv(): Env {
  return {
    ...env,
    APP_URL: "https://app.orbmeet.com",
    ENVIRONMENT: "production",
  };
}

async function seedUser(userId = "usr_sec_test") {
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    name: "Security Tester",
    email: `${userId}@example.com`,
    normalizedEmail: `${userId}@example.com`,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSession(opts: {
  id?: string;
  userId?: string;
  tokenHash?: string;
  previousTokenHash?: string | null;
  previousTokenExpiresAt?: Date | null;
  expiresAt: Date;
  absoluteExpiresAt?: Date;
  rotationVersion?: number;
}) {
  const id = opts.id ?? `ses_${crypto.randomUUID()}`;
  const userId = opts.userId ?? "usr_sec_test";
  const now = new Date();
  const tokenHash = opts.tokenHash ?? (await hashSessionToken(generateSessionToken()));

  await db.insert(sessions).values({
    id,
    userId,
    tokenHash,
    previousTokenHash: opts.previousTokenHash ?? null,
    previousTokenExpiresAt: opts.previousTokenExpiresAt ?? null,
    expiresAt: opts.expiresAt,
    absoluteExpiresAt: opts.absoluteExpiresAt ?? new Date(opts.expiresAt.getTime() + 30 * 86_400_000),
    rotationVersion: opts.rotationVersion ?? 0,
    createdAt: now,
  });

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);

  if (!row) throw new Error("Failed to seed session");
  return { ...row.session, user: row.user };
}

describe("Empirical Session Security & Isolation Verification", () => {
  describe("a. CAS rotationVersion Token Rotation", () => {
    it("atomically increments rotationVersion and swaps tokenHash while preserving previousTokenHash", async () => {
      await seedUser();
      const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000);
      const originalToken = generateSessionToken();
      const originalHash = await hashSessionToken(originalToken);
      const session = await seedSession({
        expiresAt: nearExpiry,
        tokenHash: originalHash,
        rotationVersion: 1,
      });

      const mockEnv = createMockEnv();
      const { session: refreshedSession, setCookie } = await maybeRefreshSession(
        session,
        mockEnv,
        db,
        false,
      );

      // Verify cookie was issued with new token
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain("__Host-session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");

      // Verify in-memory and database state
      expect(refreshedSession.rotationVersion).toBe(2);
      expect(refreshedSession.previousTokenHash).toBe(originalHash);
      expect(refreshedSession.tokenHash).not.toBe(originalHash);

      const dbRow = await db.query.sessions.findFirst({
        where: { id: session.id },
      });
      expect(dbRow?.rotationVersion).toBe(2);
      expect(dbRow?.previousTokenHash).toBe(originalHash);
      expect(dbRow?.tokenHash).toBe(refreshedSession.tokenHash);
    });

    it("prevents race condition token overwrite by failing closed when rotationVersion is stale (CAS conflict)", async () => {
      await seedUser();
      const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000);
      const session = await seedSession({
        expiresAt: nearExpiry,
        rotationVersion: 1,
      });

      // Simulate a winning concurrent request bumping rotationVersion in DB first
      const concurrentWinnerNewHash = await hashSessionToken(generateSessionToken());
      await db
        .update(sessions)
        .set({
          rotationVersion: 2,
          tokenHash: concurrentWinnerNewHash,
        })
        .where(eq(sessions.id, session.id));

      // The losing request with stale rotationVersion=1 attempts rotation
      const mockEnv = createMockEnv();
      const { setCookie } = await maybeRefreshSession(session, mockEnv, db, false);

      // CAS conflict: loser emits NO cookie and does NOT overwrite winner's token
      expect(setCookie).toBeNull();
      const dbRow = await db.query.sessions.findFirst({
        where: { id: session.id },
      });
      expect(dbRow?.rotationVersion).toBe(2);
      expect(dbRow?.tokenHash).toBe(concurrentWinnerNewHash);
    });
  });

  describe("b. 60s Previous Token Grace Window", () => {
    it("resolves valid session when client authenticates with previousTokenHash within grace window", async () => {
      await seedUser();
      const rawCurrentToken = generateSessionToken();
      const rawPreviousToken = generateSessionToken();
      const currentHash = await hashSessionToken(rawCurrentToken);
      const previousHash = await hashSessionToken(rawPreviousToken);
      const now = Date.now();

      await seedSession({
        tokenHash: currentHash,
        previousTokenHash: previousHash,
        previousTokenExpiresAt: new Date(now + SESSION_ROTATION_GRACE_MS),
        expiresAt: new Date(now + SESSION_EXPIRY_MS),
      });

      const requestWithPreviousToken = new Request("https://app.orbmeet.com/api/test", {
        headers: { Cookie: `__Host-session=${rawPreviousToken}` },
      });

      const resolved = await verifySessionFromRawRequest(requestWithPreviousToken, createMockEnv());
      expect(resolved).not.toBeNull();
      expect(resolved?.userId).toBe("usr_sec_test");
    });

    it("rejects previous token once grace window expires", async () => {
      await seedUser();
      const rawCurrentToken = generateSessionToken();
      const rawPreviousToken = generateSessionToken();
      const currentHash = await hashSessionToken(rawCurrentToken);
      const previousHash = await hashSessionToken(rawPreviousToken);
      const now = Date.now();

      // Grace period expired 10 seconds ago
      await seedSession({
        tokenHash: currentHash,
        previousTokenHash: previousHash,
        previousTokenExpiresAt: new Date(now - 10_000),
        expiresAt: new Date(now + SESSION_EXPIRY_MS),
      });

      const requestWithExpiredPrevious = new Request("https://app.orbmeet.com/api/test", {
        headers: { Cookie: `__Host-session=${rawPreviousToken}` },
      });

      const resolved = await verifySessionFromRawRequest(requestWithExpiredPrevious, createMockEnv());
      expect(resolved).toBeNull();
    });

    it("does NOT trigger further rotation or extend expiry when matched via previous token", async () => {
      await seedUser();
      const rawPrevious = generateSessionToken();
      const previousHash = await hashSessionToken(rawPrevious);
      const currentHash = await hashSessionToken(generateSessionToken());
      const farFuture = new Date(Date.now() + SESSION_EXPIRY_MS);

      const session = await seedSession({
        tokenHash: currentHash,
        previousTokenHash: previousHash,
        previousTokenExpiresAt: new Date(Date.now() + 30_000),
        expiresAt: farFuture,
      });

      const { setCookie } = await maybeRefreshSession(session, createMockEnv(), db, true);
      expect(setCookie).toBeNull();

      const dbRow = await db.query.sessions.findFirst({
        where: { id: session.id },
      });
      expect(dbRow?.tokenHash).toBe(currentHash);
      expect(dbRow?.previousTokenHash).toBe(previousHash);
    });
  });

  describe("c. Absolute Expiry Clamping", () => {
    it("clamps refreshed session expiry to absoluteExpiresAt", async () => {
      await seedUser();
      const now = Date.now();
      const nearExpiry = new Date(now + 30_000);
      const absoluteExpiresAt = new Date(now + 120_000); // 2 minutes max
      const session = await seedSession({
        expiresAt: nearExpiry,
        absoluteExpiresAt,
      });

      const { session: refreshedSession, setCookie } = await maybeRefreshSession(
        session,
        createMockEnv(),
        db,
        false,
      );

      expect(refreshedSession.expiresAt.getTime()).toBeLessThanOrEqual(absoluteExpiresAt.getTime());
      expect(refreshedSession.expiresAt.getTime()).toBeGreaterThanOrEqual(absoluteExpiresAt.getTime() - 1000);
      expect(setCookie).toContain("Max-Age=");
    });

    it("ceases rotation once session has reached absolute expiry cap", async () => {
      await seedUser();
      const now = Date.now();
      const absoluteExpiresAt = new Date(now + 60_000);
      const initialHash = await hashSessionToken(generateSessionToken());
      const session = await seedSession({
        expiresAt: absoluteExpiresAt,
        absoluteExpiresAt,
        tokenHash: initialHash,
        rotationVersion: 5,
      });

      const { setCookie } = await maybeRefreshSession(session, createMockEnv(), db, false);
      expect(setCookie).toBeNull();

      const dbRow = await db.query.sessions.findFirst({
        where: { id: session.id },
      });
      expect(dbRow?.tokenHash).toBe(initialHash);
      expect(dbRow?.rotationVersion).toBe(5);
    });
  });

  describe("d. Account Deletion Session Boundary", () => {
    it("rejects all standard sessions immediately when deletionStartedAt is set", async () => {
      const userId = "usr_deletion_test";
      const rawToken = generateSessionToken();
      const tokenHash = await hashSessionToken(rawToken);
      const now = new Date();

      await db.insert(users).values({
        id: userId,
        name: "Deletion Boundary User",
        email: `${userId}@example.com`,
        normalizedEmail: `${userId}@example.com`,
        plan: "free",
        role: "user",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(sessions).values({
        id: "ses_deletion_test",
        userId,
        tokenHash,
        expiresAt: new Date(now.getTime() + SESSION_EXPIRY_MS),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
        createdAt: now,
      });

      const request = new Request("https://app.orbmeet.com/api/test", {
        headers: { Cookie: `__Host-session=${rawToken}` },
      });

      // Before deletion: valid
      const validSession = await verifySessionFromRawRequest(request, createMockEnv());
      expect(validSession).not.toBeNull();
      expect(validSession?.userId).toBe(userId);

      // Start account deletion
      await db
        .update(users)
        .set({ deletionStartedAt: new Date() })
        .where(eq(users.id, userId));

      // After deletion: session resolution strictly fails closed
      const rejectedSession = await verifySessionFromRawRequest(request, createMockEnv());
      expect(rejectedSession).toBeNull();
    });
  });
});
