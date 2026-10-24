import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { users, sessions } from "@orbmeet/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  maybeRefreshSession,
} from "@/modules/identity/server/session";
import { getSessionIdsFromCookie } from "@/platform/http/cookies.server";
import { hashSessionToken, generateSessionToken } from "@/platform/crypto/tokens.server";
import {
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

async function seedUser(userId = "usr_adv_session") {
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    name: "Adversarial Tester",
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
  const userId = opts.userId ?? "usr_adv_session";
  const now = new Date();
  const tokenHash = opts.tokenHash ?? (await hashSessionToken(generateSessionToken()));

  await db.insert(sessions).values({
    id,
    userId,
    tokenHash,
    previousTokenHash: opts.previousTokenHash ?? null,
    previousTokenExpiresAt: opts.previousTokenExpiresAt ?? null,
    expiresAt: opts.expiresAt,
    absoluteExpiresAt:
      opts.absoluteExpiresAt ?? new Date(opts.expiresAt.getTime() + 30 * 86_400_000),
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

describe("Adversarial Stress Testing: Session CAS & Concurrency Invariants", () => {
  describe("1. High-Concurrency CAS Refresh Collision", () => {
    it("handles 10 simultaneous refresh requests on the same rotationVersion: exactly 1 wins, 9 fail safely with changes=0", async () => {
      await seedUser();
      const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 30_000);
      const originalToken = generateSessionToken();
      const originalHash = await hashSessionToken(originalToken);

      const session = await seedSession({
        expiresAt: nearExpiry,
        tokenHash: originalHash,
        rotationVersion: 1,
      });

      const mockEnv = createMockEnv();

      // Launch 10 concurrent maybeRefreshSession calls with cloned session state (all having rotationVersion = 1)
      const results = await Promise.all(
        Array.from({ length: 10 }).map(() =>
          maybeRefreshSession({ ...session }, mockEnv, db, false),
        ),
      );

      const winningRefreshes = results.filter((r) => r.setCookie !== null);
      const losingRefreshes = results.filter((r) => r.setCookie === null);

      // Invariants:
      // 1. Exactly one transaction successfully rotated the token and produced a new cookie
      expect(winningRefreshes).toHaveLength(1);
      // 2. Exactly 9 requests detected the CAS conflict (changes === 0) and failed closed to setCookie: null
      expect(losingRefreshes).toHaveLength(9);

      // Verify the final database state
      const [finalDbRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .limit(1);

      expect(finalDbRow.rotationVersion).toBe(2); // Incremented exactly once from 1 to 2
      expect(finalDbRow.previousTokenHash).toBe(originalHash); // Preserved previous token
      expect(finalDbRow.tokenHash).not.toBe(originalHash); // New token hash committed
      expect(finalDbRow.expiresAt.getTime()).toBeGreaterThan(nearExpiry.getTime());
    });

    it("concurrently rejects stale-version requests while allowing current-version requests to race", async () => {
      await seedUser();
      const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 30_000);
      const originalToken = generateSessionToken();
      const originalHash = await hashSessionToken(originalToken);

      const session = await seedSession({
        expiresAt: nearExpiry,
        tokenHash: originalHash,
        rotationVersion: 5,
      });

      const mockEnv = createMockEnv();

      // Mix 5 requests with stale rotationVersion (v4) and 5 requests with current version (v5)
      const mixedRequests = [
        ...Array.from({ length: 5 }).map(() =>
          maybeRefreshSession({ ...session, rotationVersion: 4 }, mockEnv, db, false),
        ),
        ...Array.from({ length: 5 }).map(() =>
          maybeRefreshSession({ ...session, rotationVersion: 5 }, mockEnv, db, false),
        ),
      ];

      const results = await Promise.all(mixedRequests);
      const winners = results.filter((r) => r.setCookie !== null);
      const losers = results.filter((r) => r.setCookie === null);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(9);

      const [finalDbRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .limit(1);
      expect(finalDbRow.rotationVersion).toBe(6);
    });
  });

  describe("2. Multi-Generation Grace Lookups & Interleaved Rotations", () => {
    it("enforces strict single-generation grace window: T1 (v1) valid, T0 (v0) invalidated after rotation to v2", async () => {
      await seedUser();
      const now = Date.now();
      const nearExpiry = new Date(now + SESSION_REFRESH_THRESHOLD_MS - 30_000);

      const t0 = generateSessionToken();
      const t0Hash = await hashSessionToken(t0);
      const t1 = generateSessionToken();
      const t1Hash = await hashSessionToken(t1);

      // Session was at v0 (t0), rotated to v1 (t1), so previousTokenHash = t0Hash
      const session = await seedSession({
        tokenHash: t1Hash,
        previousTokenHash: t0Hash,
        previousTokenExpiresAt: new Date(now + SESSION_ROTATION_GRACE_MS),
        expiresAt: nearExpiry,
        rotationVersion: 1,
      });

      const mockEnv = createMockEnv();

      // Rotate from v1 (t1) to v2 (t2)
      const { session: refreshedV2, setCookie } = await maybeRefreshSession(
        session,
        mockEnv,
        db,
        false,
      );
      expect(setCookie).not.toBeNull();
      expect(refreshedV2.rotationVersion).toBe(2);
      expect(refreshedV2.previousTokenHash).toBe(t1Hash);

      // Case A: Request arrives with t1 (the previous token from v1) within grace period
      const resolvedWithT1 = await db
        .select()
        .from(sessions)
        .where(eq(sessions.previousTokenHash, t1Hash))
        .limit(1);
      expect(resolvedWithT1).toHaveLength(1);

      // Case B: Request arrives with t0 (the ancient token from v0)
      // Since previousTokenHash was overwritten with t1Hash, t0 is completely purged
      const resolvedWithT0 = await db
        .select()
        .from(sessions)
        .where(
          sql`${sessions.tokenHash} = ${t0Hash} OR ${sessions.previousTokenHash} = ${t0Hash}`,
        );
      expect(resolvedWithT0).toHaveLength(0); // Fails closed, no access!

      // Case C: Calling maybeRefreshSession with matchedViaPrevious = true must NEVER rotate
      const noopRefresh = await maybeRefreshSession(
        { ...refreshedV2, tokenHash: t1Hash },
        mockEnv,
        db,
        true, // matchedViaPrevious
      );
      expect(noopRefresh.setCookie).toBeNull();
      expect(noopRefresh.session.rotationVersion).toBe(2); // Unchanged
    });
  });

  describe("3. Adversarial Cookie Parsing & Header Fuzzing", () => {
    it("bounds cookie token extraction to COOKIE_MAX_TOKENS (100) preventing DoS on oversized headers", () => {
      // Construct a huge cookie header with 150 fake tokens
      const fakeTokens = Array.from({ length: 150 }).map(
        (_, i) => `__Host-session=fake_token_adversarial_probe_${i}_${crypto.randomUUID()}`,
      );
      const maliciousCookieHeader = fakeTokens.join("; ");

      const extracted = getSessionIdsFromCookie(maliciousCookieHeader);
      // Invariant: Parser bounds to strictly 100 items to prevent unbounded iteration / DoS
      expect(extracted).toHaveLength(100);
    });

    it("handles malformed URI sequences, null bytes, and SQL payloads in cookie values safely without crashing", async () => {
      const maliciousTokens = [
        "__Host-session=%E0%A4%A", // Malformed UTF-8 URI percent encoding
        "__Host-session=%00admin_null_byte", // Null byte injection
        "__Host-session=' OR '1'='1' --", // SQL injection payload
        "__Host-session=normal_token_123",
      ];

      const rawCookieString = maliciousTokens.join("; ");
      const parsed = getSessionIdsFromCookie(rawCookieString);
      expect(parsed).toHaveLength(4);

      // All parsed tokens must safely hash to 64-char hex strings and parameterized queries run without error
      for (const token of parsed) {
        const hash = await hashSessionToken(token);
        expect(typeof hash).toBe("string");
        expect(hash).toHaveLength(64); // SHA-256 hex length

        const queryResult = await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, hash));
        expect(queryResult).toHaveLength(0); // Safe lookup
      }
    });
  });

  describe("4. Absolute Expiry Ceiling Under Continuous Refresh Pressure", () => {
    it("strictly clamps sliding expiration at absoluteExpiresAt and ceases rotation once reached", async () => {
      await seedUser();
      const now = Date.now();
      const absoluteExpiresAt = new Date(now + 100_000); // Absolute cap in 100s
      const nearExpiry = new Date(now + 10_000); // 10s from now (well within refresh threshold)

      const token = generateSessionToken();
      const hash = await hashSessionToken(token);

      let currentSession = await seedSession({
        tokenHash: hash,
        expiresAt: nearExpiry,
        absoluteExpiresAt,
        rotationVersion: 1,
      });

      const mockEnv = createMockEnv();

      // First refresh: extends expiresAt up to absoluteExpiresAt
      const refresh1 = await maybeRefreshSession(currentSession, mockEnv, db, false);
      expect(refresh1.setCookie).not.toBeNull();
      expect(refresh1.session.expiresAt.getTime()).toBeLessThanOrEqual(
        absoluteExpiresAt.getTime(),
      );
      expect(refresh1.session.rotationVersion).toBe(2);

      currentSession = refresh1.session;

      // Second immediate refresh: expiresAt is already equal to absoluteExpiresAt
      // Invariant: newExpiresAt <= expiresAtMs -> returns setCookie: null without rotating!
      const refresh2 = await maybeRefreshSession(currentSession, mockEnv, db, false);
      expect(refresh2.setCookie).toBeNull();
      expect(refresh2.session.rotationVersion).toBe(2); // Did NOT increment!
    });
  });
});
