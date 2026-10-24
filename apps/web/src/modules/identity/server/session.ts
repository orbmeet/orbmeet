import { getRequest } from "@tanstack/react-start/server";
import { createDb, type Database } from "@orbmeet/db";
import { sessions, devices, users } from "@orbmeet/db/schema";
import { eq, or, inArray, and, gte, isNull, sql } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import { SESSION_EXPIRY_MS, SESSION_REFRESH_THRESHOLD_MS, SESSION_ROTATION_GRACE_MS } from "@/modules/identity/contract/auth/constants";
import { generateId } from "@/lib/ids";
import { hashSessionToken, generateSessionToken } from "@/platform/crypto/tokens.server";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import type { User } from "@orbmeet/db/schema";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";
import { createCookieString, appendCookies, getCookieValue, sessionTokensFromCookie } from "@/platform/http/cookies.server";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { hasManagedPaddleSubscription } from "@/modules/billing/contract/subscription";

export type { AuthenticatedUser };

export function sanitizeUser(user: User | null): AuthenticatedUser | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    timeZone: user.timeZone,
    transcribeMeetings: user.transcribeMeetings,
    appearance: user.appearance,
    plan: user.plan,
    role: user.role,
    subscriptionStatus: user.subscriptionStatus ?? null,
    hasManagedSubscription: hasManagedPaddleSubscription({
      subscriptionId: user.paddleSubscriptionId,
      subscriptionStatus: user.subscriptionStatus,
    }),
  };
}

const REMEMBERED_DEVICE_COOKIE = "device";
const REMEMBERED_DEVICE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days
const MAX_DEVICES_PER_USER = 8;

// ─── Session resolution ──────────────────────────────────────────────

type SessionWithUser = typeof sessions.$inferSelect & { user: User };
type SessionWithPublicUser = Omit<SessionWithUser, "user"> & {
  user: AuthenticatedUser;
};

type CachedSession = {
  session: SessionWithPublicUser | null;
  user: AuthenticatedUser | null;
};

const sessionCache = new WeakMap<Request, Promise<CachedSession>>();
const accountDeletionSessionCache = new WeakMap<Request, Promise<CachedSession>>();

// Extend session expiry and rotate token when approaching threshold (sliding window).
// Stores old token hash in previousTokenHash so clients that missed the rotation
// cookie can still authenticate on the next request.
export async function maybeRefreshSession(
  session: SessionWithUser,
  env: Env,
  db: Database,
  matchedViaPrevious: boolean,
): Promise<{ session: SessionWithUser; setCookie: string | null }> {
  const now = Date.now();
  const absoluteExpiresAtMs = session.absoluteExpiresAt.getTime();
  if (absoluteExpiresAtMs <= now) {
    return { session, setCookie: null };
  }
  const expiresAtMs = session.expiresAt.getTime();
  if (!matchedViaPrevious && expiresAtMs - now > SESSION_REFRESH_THRESHOLD_MS) {
    return { session, setCookie: null };
  }

  const latest = session;

  // Previous tokens exist only to let requests that were already in flight
  // when a rotation committed finish successfully. They never refresh or
  // rotate the session and expire independently after a short grace window.
  if (matchedViaPrevious) {
    return { session: latest, setCookie: null };
  }

  const newExpiresAt = new Date(Math.min(Date.now() + SESSION_EXPIRY_MS, absoluteExpiresAtMs));
  // Once the sliding expiry has reached the absolute cap, another token
  // rotation cannot extend the session. Skipping that no-op rotation preserves
  // the previous-token grace slot for requests already in flight.
  if (newExpiresAt.getTime() <= expiresAtMs) {
    return { session: latest, setCookie: null };
  }

  const newToken = generateSessionToken();
  const newTokenHash = await hashSessionToken(newToken);
  const currentVersion = latest.rotationVersion ?? 0;

  // Single-shot compare-and-swap on rotationVersion. A loser of a concurrent
  // rotation deliberately does NOT retry: rotating again would overwrite
  // previousTokenHash with the winner's newer token and evict this client's
  // in-flight token from the lookup chain. Instead it returns no cookie and
  // keeps working via the (now winner-written) previousTokenHash chain.
  const result = await db
      .update(sessions)
      .set({
        previousTokenHash: latest.tokenHash,
        previousTokenExpiresAt: new Date(now + SESSION_ROTATION_GRACE_MS),
        tokenHash: newTokenHash,
        rotationVersion: currentVersion + 1,
        expiresAt: newExpiresAt,
        lastSeenAt: new Date(),
      })
    .where(and(eq(sessions.id, latest.id), eq(sessions.rotationVersion, currentVersion)));

  if (getRunChanges(result) === 0) {
    return { session: latest, setCookie: null };
  }

  latest.previousTokenHash = latest.tokenHash;
  latest.previousTokenExpiresAt = new Date(now + SESSION_ROTATION_GRACE_MS);
  latest.tokenHash = newTokenHash;
  latest.rotationVersion = currentVersion + 1;
  latest.expiresAt = newExpiresAt;
  const cookieMaxAgeSeconds = Math.max(1, Math.floor((newExpiresAt.getTime() - Date.now()) / 1000));
  const cookieValue = createCookieString("session", newToken, cookieMaxAgeSeconds, {
    appUrl: env.APP_URL,
    environment: env.ENVIRONMENT,
  });
  return { session: latest, setCookie: cookieValue };
}

async function resolveSession(
  request: Request,
  allowAccountDeletionResume: boolean,
): Promise<CachedSession> {
  const env = await getEnv();
  const db = createDb(env.DB);
  const cookie = request.headers.get("Cookie");
  const sessionTokens = sessionTokensFromCookie(cookie, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  // Normal for anonymous traffic: every logged-out visit, every bot.
  if (sessionTokens.length === 0) return { session: null, user: null };

  // Hash all tokens in parallel, then batch-query
  const tokenHashes = await Promise.all(sessionTokens.map((t) => hashSessionToken(t)));

  // Check both tokenHash and previousTokenHash in a single round-trip
  const candidateRows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      or(
        inArray(sessions.tokenHash, tokenHashes),
        inArray(sessions.previousTokenHash, tokenHashes),
      ),
      allowAccountDeletionResume ? undefined : isNull(users.deletionStartedAt),
    ));
  const candidates: SessionWithUser[] = candidateRows.map(({ session, user }) => ({
    ...session,
    user,
  }));

  const candidatesByTokenHash = new Map<string, SessionWithUser>();
  const candidatesByPreviousTokenHash = new Map<string, SessionWithUser>();
  for (const candidate of candidates) {
    candidatesByTokenHash.set(candidate.tokenHash, candidate);
    if (candidate.previousTokenHash) {
      candidatesByPreviousTokenHash.set(candidate.previousTokenHash, candidate);
    }
  }

  const now = new Date();
  // Prefer the last (most recent) token from the cookie
  let matchedSession: SessionWithUser | null = null;
  let matchedToken: string | null = null;
  let matchedViaPrevious = false;
  for (let i = sessionTokens.length - 1; i >= 0; i--) {
    const hash = tokenHashes[i];
    // Check current tokenHash first
    const candidate = candidatesByTokenHash.get(hash);
    if (candidate && candidate.expiresAt > now && candidate.absoluteExpiresAt > now) {
      matchedSession = candidate;
      matchedToken = sessionTokens[i];
      break;
    }
    // Fall back to previousTokenHash (client missed rotation cookie)
    const prevCandidate = candidatesByPreviousTokenHash.get(hash);
    if (
      prevCandidate
      && prevCandidate.previousTokenExpiresAt
      && prevCandidate.previousTokenExpiresAt > now
      && prevCandidate.expiresAt > now
      && prevCandidate.absoluteExpiresAt > now
    ) {
      matchedSession = prevCandidate;
      matchedToken = sessionTokens[i];
      matchedViaPrevious = true;
      break;
    }
  }
  // Routine: expired sessions and stale cookies.
  if (!matchedSession || !matchedToken) return { session: null, user: null };

  // A deletion-resume session is a narrow recovery credential, not a renewed
  // login. Keep it valid for this request without extending or rotating it.
  const { session: refreshed, setCookie } = allowAccountDeletionResume
    ? { session: matchedSession, setCookie: null }
    : await maybeRefreshSession(matchedSession, env, db, matchedViaPrevious);
  if (setCookie) {
    appendCookies([setCookie]);
  }

  const sanitizedUser = sanitizeUser(refreshed.user)!;
  return {
    session: { ...refreshed, user: sanitizedUser },
    user: sanitizedUser,
  };
}

async function getCachedSession(
  request: Request,
  allowAccountDeletionResume: boolean,
): Promise<CachedSession> {
  const cache = allowAccountDeletionResume
    ? accountDeletionSessionCache
    : sessionCache;
  const cached = cache.get(request);
  if (cached) return cached;
  let promise: Promise<CachedSession>;
  promise = resolveSession(request, allowAccountDeletionResume).catch((error) => {
    // Preserve in-flight de-duplication, but a failed lookup is not a session
    // value. Evict only our own promise so a caller that intentionally retries
    // after a transient infrastructure failure performs fresh work.
    if (cache.get(request) === promise) cache.delete(request);
    throw error;
  });
  cache.set(request, promise);
  return promise;
}

export async function getSessionFromRequest(): Promise<SessionWithPublicUser | null> {
  // Let errors propagate so the client can distinguish "no session" (null)
  // from "server error" (thrown). Swallowing errors here caused transient
  // DB failures to cache null in TanStack Query, logging users out.
  const request = getRequest();
  const cached = await getCachedSession(request, false);
  return cached.session;
}

/**
 * Resolve the one session retained solely so an interrupted account deletion
 * can resume. All ordinary authentication paths exclude deletion-started
 * users; callers must never use this outside the deletion endpoint.
 */
export async function getAccountDeletionSessionFromRequest(): Promise<SessionWithPublicUser | null> {
  const request = getRequest();
  const cached = await getCachedSession(request, true);
  return cached.session;
}

export async function requireAuth(): Promise<AuthenticatedUser> {
  // Use session resolution directly so infrastructure failures propagate
  // as server errors instead of being collapsed into UNAUTHORIZED.
  const session = await getSessionFromRequest();
  if (!session?.user) throw Errors.UNAUTHORIZED();
  return session.user;
}

/**
 * Resolve the caller's identity for endpoints that serve both signed-in users
 * and guests (e.g. meeting admission, token refresh, screen-share grants).
 * Only collapses the specific "no session" case to `null` — infrastructure
 * failures (DB errors, etc.) still propagate as real errors instead of being
 * silently treated as "this caller is a guest". See `requireAuth` above for
 * why that distinction matters.
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  try {
    return await requireAuth();
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHORIZED") return null;
    throw error;
  }
}

/**
 * Verify a session from a raw Request object without TanStack Start context.
 * Use this in raw API route handlers (server.handlers.GET/POST) where
 * getRequest() is not available.
 * Returns the session's userId if valid, null otherwise.
 */
export async function verifySessionFromRawRequest(
  request: Request,
  env: Env,
): Promise<{ sessionId: string; userId: string } | null> {
  const cookie = request.headers.get("Cookie");
  const tokens = sessionTokensFromCookie(cookie, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  if (tokens.length === 0) return null;

  const db = createDb(env.DB);
  const hashes = await Promise.all(tokens.map((t) => hashSessionToken(t)));

  // Batch-query all candidate sessions in a single round-trip (aligns with resolveSession)
  const candidates = await db
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      previousTokenHash: sessions.previousTokenHash,
      previousTokenExpiresAt: sessions.previousTokenExpiresAt,
      expiresAt: sessions.expiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      userId: sessions.userId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      or(
        inArray(sessions.tokenHash, hashes),
        inArray(sessions.previousTokenHash, hashes),
      ),
      isNull(users.deletionStartedAt),
    ));

  const now = new Date();
  const byTokenHash = new Map(candidates.map((c) => [c.tokenHash, c]));
  const byPrevHash = new Map(
    candidates
      .filter((c) => c.previousTokenHash && c.previousTokenExpiresAt)
      .map((c) => [c.previousTokenHash!, c]),
  );

  // Prefer the last (most recent) token from the cookie
  for (let i = tokens.length - 1; i >= 0; i--) {
    const hash = hashes[i];
    const currentSession = byTokenHash.get(hash);
    const previousSession = byPrevHash.get(hash);
    const session = currentSession
      ?? (
        previousSession?.previousTokenExpiresAt
        && previousSession.previousTokenExpiresAt > now
          ? previousSession
          : undefined
      );
    if (session && session.expiresAt > now && session.absoluteExpiresAt > now) {
      return { sessionId: session.id, userId: session.userId };
    }
  }
  return null;
}

async function enforceDeviceCap(db: Database, userId: string): Promise<void> {
  // A single statement prevents concurrent sign-ins from both observing an
  // under-cap snapshot. The id tie-breaker also makes equal timestamps stable.
  await withD1Retry(
    () => db.run(sql`
      DELETE FROM devices
      WHERE user_id = ${userId}
        AND id NOT IN (
          SELECT id FROM devices
          WHERE user_id = ${userId}
          ORDER BY last_seen_at DESC, created_at DESC, id DESC
          LIMIT ${MAX_DEVICES_PER_USER}
        )
    `),
    { idempotent: true },
  );
}

/**
 * Remember this browser so the next visit can greet the person by name.
 *
 * Bound to the session it was issued for: revoking that session from the
 * signed-in devices list cascades this row away, so the cookie stops resolving
 * the account's name, email and avatar at the same moment the session dies.
 */
export async function rememberDevice(
  db: Database,
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REMEMBERED_DEVICE_MAX_AGE_SECONDS * 1000);
  const request = getRequest();
  const ua = request.headers.get("User-Agent")?.slice(0, 200) ?? null;

  await db.insert(devices).values({
      id: generateId("DEVICE"),
      userId,
      sessionId,
      tokenHash,
      label: ua,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
  });

  await enforceDeviceCap(db, userId);

  appendCookies([
    createCookieString(REMEMBERED_DEVICE_COOKIE, token, REMEMBERED_DEVICE_MAX_AGE_SECONDS, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);
}

export async function getRememberedUserFromRequest(): Promise<AuthenticatedUser | null> {
  const request = getRequest();
  const env = await getEnv();
  const db = createDb(env.DB);
  const cookie = request.headers.get("Cookie");
  const rawToken = getCookieValue(cookie, REMEMBERED_DEVICE_COOKIE, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  if (!rawToken) return null;

  const tokenHash = await hashSessionToken(rawToken);
  const now = new Date();
  const row = await db
    .select({
      id: devices.id,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
      userTimeZone: users.timeZone,
      userTranscribeMeetings: users.transcribeMeetings,
      userAppearance: users.appearance,
      userPlan: users.plan,
      userRole: users.role,
      userSubscriptionStatus: users.subscriptionStatus,
      userPaddleSubscriptionId: users.paddleSubscriptionId,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(and(
      eq(devices.tokenHash, tokenHash),
      gte(devices.expiresAt, now),
      isNull(users.deletionStartedAt),
    ))
    .limit(1);

  if (row.length === 0) return null;

  const nextExpiry = new Date(now.getTime() + REMEMBERED_DEVICE_MAX_AGE_SECONDS * 1000);
  await db
      .update(devices)
      .set({ lastSeenAt: now, expiresAt: nextExpiry })
    .where(eq(devices.id, row[0].id));

  appendCookies([
    createCookieString(REMEMBERED_DEVICE_COOKIE, rawToken, REMEMBERED_DEVICE_MAX_AGE_SECONDS, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);

  return {
    id: row[0].userId,
    name: row[0].userName,
    email: row[0].userEmail,
    image: row[0].userImage,
    timeZone: row[0].userTimeZone,
    transcribeMeetings: row[0].userTranscribeMeetings,
    appearance: row[0].userAppearance,
    plan: row[0].userPlan,
    role: row[0].userRole,
    subscriptionStatus: row[0].userSubscriptionStatus ?? null,
    hasManagedSubscription: hasManagedPaddleSubscription({
      subscriptionId: row[0].userPaddleSubscriptionId,
      subscriptionStatus: row[0].userSubscriptionStatus,
    }),
  };
}

// ─── Session cap enforcement ────────────────────────────────────────

const MAX_SESSIONS = 10;

/**
 * Shared session cap enforcement helper.
 * Atomically keeps only the ten sessions with the latest sliding expiry.
 */
export async function enforceSessionCap(db: Database, userId: string): Promise<void> {
  await withD1Retry(
    () => enforceSessionCapStatement(db, userId),
    { idempotent: true },
  );
}

/**
 * Statement form for authentication transactions. Session creation and cap
 * enforcement must commit together: once a session exists, cleanup failure
 * cannot be allowed to suppress delivery of its cookie.
 */
export function enforceSessionCapStatement(db: Database, userId: string) {
  return db.delete(sessions).where(sql`
    ${sessions.id} in (
      select ${sessions.id}
      from ${sessions}
      where ${sessions.userId} = ${userId}
      order by ${sessions.expiresAt} desc, ${sessions.id} desc
      limit -1 offset ${MAX_SESSIONS}
    )
  `);
}
