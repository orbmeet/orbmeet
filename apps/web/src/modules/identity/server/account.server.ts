/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { getRequest } from "@tanstack/react-start/server";
import { devices, sessions, users } from "@orbmeet/db/schema";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import type {
  revokeSessionSchema,
  StepUpBody,
  setAppearanceSchema,
  setTranscribeMeetingsSchema,
  updateProfileSchema,
} from "@/modules/identity/contract/auth/schemas";
import { Errors } from "@/lib/app-errors";
import { boundedStatements } from "@/platform/database/db-batching";
import { eq, and, gte, inArray } from "drizzle-orm";
import {
  sessionTokensFromCookie,
  createCookieString,
  appendCookies,
} from "@/platform/http/cookies.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { authorizeSensitiveAction } from "./step-up.server";
import { revokeAllPersonalAccessTokens } from "./credential-revocation";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";

function maskIp(ip: string): string {
  if (ip.includes(":")) {
    // IPv6: show first 4 segments
    const parts = ip.split(":");
    return parts.slice(0, 4).join(":") + ":***";
  }
  // IPv4: show first 2 octets
  const parts = ip.split(".");
  return parts.slice(0, 2).join(".") + ".*.*";
}

export async function updateProfileImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof updateProfileSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `account:update-profile:${user.id}`);

  const name = data.name.trim();
  await db
    .update(users)
    .set({
      name,
      ...(data.timeZone === undefined ? {} : { timeZone: data.timeZone }),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    success: true,
    name,
    timeZone: data.timeZone ?? user.timeZone,
  };
}

/** Light, dark, or the device's own setting, kept on the account so it follows the person. */
export async function setAppearanceImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof setAppearanceSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `account:appearance:${user.id}`);
  await db
    .update(users)
    .set({ appearance: data.appearance, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  return { success: true, appearance: data.appearance };
}

/** The account default for whether meetings this user starts are transcribed. */
export async function setTranscribeMeetingsImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof setTranscribeMeetingsSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `account:transcribe-meetings:${user.id}`);
  await db
    .update(users)
    .set({ transcribeMeetings: data.on, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  return { success: true, transcribeMeetings: data.on };
}

export async function listSessionsImpl({
  context: { user: currentUser, env, db },
}: {
  context: AuthFnContext;
}) {
  const request = getRequest();

  // Get current session's token hash to mark it
  const cookie = request.headers.get("Cookie");
  const sessionTokens = sessionTokensFromCookie(cookie, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  const currentTokenHashes = await Promise.all(sessionTokens.map((t) => hashSessionToken(t)));

  const userSessions = await db.query.sessions.findMany({
    where: {
      RAW: (row) =>
        and(
          eq(row.userId, currentUser.id),
          gte(row.expiresAt, new Date()),
          gte(row.absoluteExpiresAt, new Date()),
        )!,
    },
    columns: {
      id: true,
      tokenHash: true,
      previousTokenHash: true,
      previousTokenExpiresAt: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
    },
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });

  return userSessions.map((s) => ({
    id: s.id,
    ipAddress: s.ipAddress ? maskIp(s.ipAddress) : null,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    isCurrent:
      currentTokenHashes.includes(s.tokenHash) ||
      Boolean(
        s.previousTokenHash &&
        s.previousTokenExpiresAt &&
        s.previousTokenExpiresAt > new Date() &&
        currentTokenHashes.includes(s.previousTokenHash),
      ),
  }));
}

export async function revokeSessionImpl({
  data,
  context: { user: currentUser, authSessionId, env, db },
}: {
  data: v.InferOutput<typeof revokeSessionSchema>;
  context: AuthFnContext;
}) {
  const request = getRequest();

  await enforceIpRateLimit(env, "revoke-session");
  await enforceRateLimit(env, `account:revoke-session:${currentUser.id}`);

  // Ensure the session belongs to the current user
  const session = await db.query.sessions.findFirst({
    where: { RAW: (row) => and(eq(row.id, data.sessionId), eq(row.userId, currentUser.id))! },
    columns: {
      id: true,
      tokenHash: true,
      previousTokenHash: true,
      previousTokenExpiresAt: true,
    },
  });

  if (!session) {
    throw Errors.VALIDATION("Signed-in device not found.");
  }
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: currentUser.id,
    authSessionId,
    action: "session_revoke",
    targetId: data.sessionId,
  });

  // Check if this is the current session
  const cookie = request.headers.get("Cookie");
  const sessionTokens = sessionTokensFromCookie(cookie, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  const currentTokenHashes = await Promise.all(sessionTokens.map((t) => hashSessionToken(t)));
  const isCurrentSession =
    currentTokenHashes.includes(session.tokenHash) ||
    Boolean(
      session.previousTokenHash &&
      session.previousTokenExpiresAt &&
      session.previousTokenExpiresAt > new Date() &&
      currentTokenHashes.includes(session.previousTokenHash),
    );

  // Delete the session
  await db.delete(sessions).where(eq(sessions.id, data.sessionId));

  // If revoking current session, clear the cookie
  if (isCurrentSession) {
    appendCookies([
      createCookieString("session", "", 0, {
        appUrl: env.APP_URL,
        environment: env.ENVIRONMENT,
      }),
    ]);
  }

  return { success: true, wasCurrentSession: isCurrentSession };
}

export async function revokeAllOtherSessionsImpl({
  data,
  context: { user: currentUser, authSessionId, env, db },
}: {
  data: StepUpBody;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "revoke-all-sessions");
  await enforceRateLimit(env, `account:revoke-all-sessions:${currentUser.id}`);
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: currentUser.id,
    authSessionId,
    action: "sessions_revoke_others",
  });

  // The middleware has already resolved the exact authenticated session.
  // Preserve that ID rather than re-deriving identity from rotating cookies.
  const allSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, currentUser.id));

  // Delete all sessions except the current one
  const toDelete = allSessions.filter((session) => session.id !== authSessionId).map((s) => s.id);

  for (const deletion of boundedStatements(toDelete, (ids) => db.delete(sessions).where(inArray(sessions.id, ids)))) {
    await deletion;
  }

  // Remembered-device cookies are alternate long-lived account locators.
  // "Sign out everywhere" must revoke those credentials as well as sessions.
  await db.delete(devices).where(eq(devices.userId, currentUser.id));

  // So are API keys, and more so: a key carries no session chain, does not
  // rotate, and is not bound to a device, so one minted from a captured
  // session kept working across a password change, an email change, and this
  // very action. This is the compromise-recovery control — it has to cover
  // every durable credential, not just the ones with cookies behind them.
  const revokedApiKeyCount = await revokeAllPersonalAccessTokens(db, currentUser.id, new Date());
  appendCookies([
    createCookieString("device", "", 0, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);

  return {
    success: true,
    revokedCount: toDelete.length,
    revokedApiKeyCount,
  };
}

/**
 * State for the deletion-recovery page. It sits behind the deletion-continuation
 * middleware on purpose: a deletion-resume session must be unable to reach any
 * surface except this page and the deletion endpoint above, and this returns
 * just enough (the email and the marker timestamp) to explain the situation.
 * `deletionPending: false` covers a caller whose session is gone or whose
 * deletion already completed — the page sends them back to sign-in.
 */
export async function getDeletionPendingAccountImpl({
  context: { user, db },
}: {
  context: AuthFnContext;
}) {
  const accountState = await db.query.users.findFirst({
    where: { id: user.id },
    columns: { deletionStartedAt: true },
  });
  if (!accountState?.deletionStartedAt) {
    return { deletionPending: false as const };
  }
  return {
    deletionPending: true as const,
    email: user.email,
    deletionStartedAt: accountState.deletionStartedAt.toISOString(),
  };
}
