import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { sessions, users } from "@orbmeet/db/schema";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import {
  SESSION_ABSOLUTE_EXPIRY_MS,
  SESSION_EXPIRY_MS,
  SESSION_EXPIRY_SECONDS,
} from "@/modules/identity/contract/auth/constants";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import { getRunChanges } from "@/platform/database/db-utils";
import { getClientIP } from "@/platform/http/client-ip.server";
import { appendCookies, createCookieString } from "@/platform/http/cookies.server";
import { enforceSessionCapStatement, rememberDevice } from "./session";

export type SessionLifecycleGate = "active" | "deletion_resume";

export interface FencedSessionInput {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAtSeconds: number;
  absoluteExpiresAtSeconds: number;
  ipAddress: string | null;
  userAgent: string | null;
  createdAtSeconds: number;
  additionalGate?: SQL;
}

/**
 * A session minted for an account whose deletion already started is a recovery
 * credential, not a login: it only has to outlive one visit to the recovery
 * page. 24 hours is enough for that visit and short enough that the daily
 * maintenance sweep reclaims abandoned rows quickly.
 */
export const DELETION_RECOVERY_SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Session creation is always fenced by the account lifecycle in the same SQL
 * statement as the insert. A prior read is not sufficient: deletion can begin
 * or complete between authentication and session issuance.
 *
 * - `"active"` inserts only while `users.deletion_started_at IS NULL`.
 * - `"deletion_resume"` inserts only while `users.deletion_started_at IS NOT NULL`,
 *   producing a recovery session that resolves exclusively through the recovery
 *   surface and the deletion endpoint (or zero rows if deletion completed).
 */
export function insertFencedSessionStatement(
  db: Database,
  input: FencedSessionInput,
  gate: SessionLifecycleGate = "active",
) {
  const lifecyclePredicate =
    gate === "deletion_resume"
      ? isNotNull(users.deletionStartedAt)
      : isNull(users.deletionStartedAt);

  return db.insert(sessions).select(
    db
      .select({
        id: sql`${input.id}`.as("id"),
        tokenHash: sql`${input.tokenHash}`.as("token_hash"),
        previousTokenHash: sql`null`.as("previous_token_hash"),
        previousTokenExpiresAt: sql`null`.as("previous_token_expires_at"),
        rotationVersion: sql`0`.as("rotation_version"),
        userId: users.id,
        expiresAt: sql`${input.expiresAtSeconds}`.as("expires_at"),
        absoluteExpiresAt: sql`${input.absoluteExpiresAtSeconds}`.as("absolute_expires_at"),
        ipAddress: sql`${input.ipAddress}`.as("ip_address"),
        userAgent: sql`${input.userAgent}`.as("user_agent"),
        lastSeenAt: sql`null`.as("last_seen_at"),
        createdAt: sql`${input.createdAtSeconds}`.as("created_at"),
      })
      .from(users)
      .where(and(
        eq(users.id, input.userId),
        lifecyclePredicate,
        input.additionalGate,
      )),
  );
}

type SessionBatchStatement = Parameters<Database["batch"]>[0][number];

export interface IssueBrowserSessionOptions {
  userId: string;
  deletionPending: boolean;
  now?: Date;
  additionalGate?: SQL;
  additionalStatements?: SessionBatchStatement[];
  onFenceRejected?: () => Error;
}

/**
 * Mint a lifecycle-fenced session, enforce the per-user session cap atomically
 * in the same D1 batch, remember the device for active accounts, and append
 * the `session` cookie with `Max-Age` matching the minted session TTL.
 */
export async function issueBrowserSession(
  db: Database,
  env: Env,
  request: Request,
  options: IssueBrowserSessionOptions,
): Promise<{ sessionId: string }> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  const sessionId = generateId("SESSION");
  const sessionToken = generateSessionToken();
  const sessionTokenHash = await hashSessionToken(sessionToken);

  const cookieMaxAgeSeconds = options.deletionPending
    ? DELETION_RECOVERY_SESSION_TTL_SECONDS
    : SESSION_EXPIRY_SECONDS;
  const expiresAtSeconds = options.deletionPending
    ? nowSeconds + DELETION_RECOVERY_SESSION_TTL_SECONDS
    : Math.floor((nowMs + SESSION_EXPIRY_MS) / 1000);
  const absoluteExpiresAtSeconds = options.deletionPending
    ? nowSeconds + DELETION_RECOVERY_SESSION_TTL_SECONDS
    : Math.floor((nowMs + SESSION_ABSOLUTE_EXPIRY_MS) / 1000);

  const insertSession = insertFencedSessionStatement(
    db,
    {
      id: sessionId,
      tokenHash: sessionTokenHash,
      userId: options.userId,
      expiresAtSeconds,
      absoluteExpiresAtSeconds,
      ipAddress: getClientIP(),
      userAgent: request.headers.get("User-Agent")?.slice(0, 500) ?? null,
      createdAtSeconds: nowSeconds,
      additionalGate: options.additionalGate,
    },
    options.deletionPending ? "deletion_resume" : "active",
  );

  const [insertResult] = await db.batch([
    insertSession,
    ...(options.additionalStatements ?? []),
    enforceSessionCapStatement(db, options.userId),
  ]);
  if (getRunChanges(insertResult) !== 1) {
    throw options.onFenceRejected ? options.onFenceRejected() : Errors.UNAUTHORIZED();
  }

  if (!options.deletionPending) {
    // A remembered-device cookie cannot resolve a deletion-gated account
    // (the lookup excludes gated users), so do not mint a dead row.
    await rememberDevice(db, env, options.userId, sessionId).catch(() => undefined);
  }

  appendCookies([
    createCookieString("session", sessionToken, cookieMaxAgeSeconds, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);

  return { sessionId };
}
