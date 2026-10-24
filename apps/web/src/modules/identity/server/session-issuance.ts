import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { sessions, users } from "@orbmeet/db/schema";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

interface ActiveAccountSessionInput {
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
 * between authentication and session issuance.
 */
export function insertActiveAccountSessionStatement(
  db: Database,
  input: ActiveAccountSessionInput,
) {
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
        isNull(users.deletionStartedAt),
        input.additionalGate,
      )),
  );
}

/**
 * The same statement, fenced the opposite way: it inserts only when the account
 * is deletion-gated. A sign-in for a gated account therefore either mints a
 * session that can reach nothing but the recovery surface and the deletion
 * endpoint (every ordinary resolution path excludes deletion-started users), or
 * inserts zero rows when the deletion completed in the meantime — which the
 * caller reports as the same generic auth failure as any other miss.
 */
export function insertDeletionResumeSessionStatement(
  db: Database,
  input: ActiveAccountSessionInput,
) {
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
        isNotNull(users.deletionStartedAt),
        input.additionalGate,
      )),
  );
}
