import { createDb, type Database } from "@orbmeet/db";
import { personalAccessTokens, users } from "@orbmeet/db/schema";
import type { PersonalAccessTokenScope } from "@orbmeet/domain-model";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { AUTOMATION_TOKEN_PREFIX } from "@/modules/developer-api/server/token-format";
import { Errors } from "@/lib/app-errors";
import { ID_PREFIX } from "@/lib/ids";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";

import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { logWarn } from "@/lib/logger";
import { hasManagedPaddleSubscription } from "@/modules/billing/contract/subscription";
import { timingSafeEqual } from "@orbmeet/primitives";

export type { PersonalAccessTokenScope };

export interface AutomationPrincipal {
  user: AuthenticatedUser;
  tokenId: string;
  scopes: PersonalAccessTokenScope[];
  db: Database;
}

export function tokenIdFromRaw(rawToken: string): string | null {
  const separator = rawToken.lastIndexOf(".");
  if (separator < 1 || !/^[a-f0-9]{64}$/.test(rawToken.slice(separator + 1))) return null;
  // Raw token shape is `${AUTOMATION_TOKEN_PREFIX}${id}.${secret}`, where the id
  // itself carries the PERSONAL_ACCESS_TOKEN prefix. Strip only the outer
  // automation prefix so the returned id matches personalAccessTokens.id.
  const expectedPrefix = `${AUTOMATION_TOKEN_PREFIX}${ID_PREFIX.PERSONAL_ACCESS_TOKEN}`;
  if (!rawToken.startsWith(expectedPrefix)) return null;
  const id = rawToken.slice(AUTOMATION_TOKEN_PREFIX.length, separator);
  return id.length > 0 && id.length <= 80 ? id : null;
}

export async function authenticateAutomationRequest(
  request: Request,
  env: Env,
  requiredScope: PersonalAccessTokenScope | null,
): Promise<AutomationPrincipal> {
  const authorization = request.headers.get("Authorization");
  const rawToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const db = createDb(env.DB);
  const authenticated = await authenticateAutomationToken(db, rawToken, requiredScope);
  return { ...authenticated, db };
}

// A null requiredScope authenticates the token without demanding a scope,
// for endpoints (like /api/v1/me) that any valid token may call.
export async function authenticateAutomationToken(
  db: Database,
  rawToken: string,
  requiredScope: PersonalAccessTokenScope | null,
  now = new Date(),
): Promise<Omit<AutomationPrincipal, "db">> {
  const tokenId = tokenIdFromRaw(rawToken);
  if (!tokenId) throw Errors.UNAUTHORIZED();
  const row = await db
    .select({ token: personalAccessTokens, user: users })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.id, tokenId),
        isNull(users.deletionStartedAt),
        isNull(personalAccessTokens.revokedAt),
        or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, now)),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw Errors.UNAUTHORIZED();
  const providedHash = await hashSessionToken(rawToken);
  if (!await timingSafeEqual(row.token.tokenHash, providedHash)) throw Errors.UNAUTHORIZED();
  if (requiredScope && !row.token.scopes.includes(requiredScope)) {
    throw Errors.FORBIDDEN(`API key is missing the ${requiredScope} scope`);
  }

  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() >= 5 * 60_000) {
    await db.update(personalAccessTokens)
      .set({ lastUsedAt: now })
      .where(eq(personalAccessTokens.id, row.token.id))
      .catch((error) => {
        // Usage telemetry is advisory and must never invalidate a credential
        // whose secret, scope, expiry, and revocation checks all passed.
        logWarn("[automation-auth] Failed to record API key usage", {
          tokenId: row.token.id,
          error,
        });
      });
  }
  return {
    tokenId: row.token.id,
    scopes: row.token.scopes,
    user: {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      image: row.user.image,
      timeZone: row.user.timeZone,
      transcribeMeetings: row.user.transcribeMeetings,
      appearance: row.user.appearance,
      plan: row.user.plan,
      role: row.user.role,
      subscriptionStatus: row.user.subscriptionStatus,
      hasManagedSubscription: hasManagedPaddleSubscription({
        subscriptionId: row.user.paddleSubscriptionId,
        subscriptionStatus: row.user.subscriptionStatus,
      }),
    },
  };
}
