/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { personalAccessTokens } from "@orbmeet/db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AUTOMATION_TOKEN_PREFIX } from "@/modules/developer-api/server/token-format";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { revokePersonalAccessTokenSchema } from "@orbmeet/public-api-contract";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import { getRunChanges } from "@/platform/database/db-utils";
import { authorizeSensitiveAction } from "@/modules/identity/server/step-up.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { CreatePersonalAccessTokenRequestInput } from "./personal-access-tokens.functions";

const MAX_ACTIVE_TOKENS = 10;

/**
 * Minting an API key is a durable-credential mutation, so it carries the same
 * email step-up as adding a passkey, revoking sessions, or linking Google —
 * `authMiddleware` alone let a captured session cookie mint a bearer credential
 * that then outlived every remediation the victim could perform.
 */

/**
 * Revoke every live API key for one user, and report how many were live.
 *
 * "Sign out everywhere" is the account's compromise-recovery control, and an
 * API key is the durable credential it must not miss: unlike a session it
 * does not rotate, unlike a remembered device it has no cookie, and it keeps
 * working across an email change and a full session-chain reset. Revoking
 * rather than deleting keeps the row auditable — bearer lookup already filters
 * on `revoked_at`.
 */
export async function insertPersonalAccessTokenWithinCap(
  db: Database,
  token: typeof personalAccessTokens.$inferInsert,
  now: Date,
): Promise<boolean> {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const expiresAtSeconds = token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1_000) : null;
  const inserted = await db.run(sql`
    INSERT INTO ${personalAccessTokens} (
      id,
      user_id,
      name,
      token_hash,
      token_prefix,
      scopes,
      expires_at,
      last_used_at,
      revoked_at,
      created_at
    )
    SELECT
      ${token.id},
      ${token.userId},
      ${token.name},
      ${token.tokenHash},
      ${token.tokenPrefix},
      ${JSON.stringify(token.scopes)},
      ${expiresAtSeconds},
      NULL,
      NULL,
      ${nowSeconds}
    WHERE (
      SELECT COUNT(*)
      FROM ${personalAccessTokens}
      WHERE ${personalAccessTokens.userId} = ${token.userId}
        AND ${personalAccessTokens.revokedAt} IS NULL
        AND (
          ${personalAccessTokens.expiresAt} IS NULL
          OR ${personalAccessTokens.expiresAt} > ${nowSeconds}
        )
    ) < ${MAX_ACTIVE_TOKENS}
  `);
  return getRunChanges(inserted) > 0;
}

function serializeToken(token: typeof personalAccessTokens.$inferSelect) {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

export async function listPersonalAccessTokensImpl({
  context: { user, db },
}: {
  context: AuthFnContext;
}) {
  const tokens = await db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, user.id))
    .orderBy(desc(personalAccessTokens.createdAt))
    .limit(50);
  return { tokens: tokens.map(serializeToken) };
}

export async function createPersonalAccessTokenImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: CreatePersonalAccessTokenRequestInput;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "api-key-create");
  await enforceRateLimit(env, `developer-api:key-create:${user.id}`);
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: user.id,
    authSessionId,
    action: "api_key_create",
  });

  const now = new Date();
  const id = generateId("PERSONAL_ACCESS_TOKEN");
  const rawToken = `${AUTOMATION_TOKEN_PREFIX}${id}.${generateSessionToken()}`;
  const expiresAt = data.expiresInDays
    ? new Date(now.getTime() + data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const token = {
    id,
    userId: user.id,
    name: data.name,
    tokenHash: await hashSessionToken(rawToken),
    tokenPrefix: `${rawToken.slice(0, 20)}…`,
    scopes: [...new Set(data.scopes)],
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  };
  if (!(await insertPersonalAccessTokenWithinCap(db, token, now))) {
    throw Errors.VALIDATION(
      `Revoke an existing API key before creating more than ${MAX_ACTIVE_TOKENS}`,
    );
  }
  return { token: serializeToken(token), secret: rawToken };
}

export async function revokePersonalAccessTokenImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof revokePersonalAccessTokenSchema>;
  context: AuthFnContext;
}) {
  const now = new Date();
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(personalAccessTokens.id, data.tokenId),
        eq(personalAccessTokens.userId, user.id),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
  return { success: true };
}
