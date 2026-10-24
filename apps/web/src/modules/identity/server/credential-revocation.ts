import type { Database } from "@orbmeet/db";
import { personalAccessTokens } from "@orbmeet/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { withD1Retry } from "@/platform/database/db-utils";

/**
 * Compromise recovery has to cover every durable credential a user holds, not
 * just the ones with a session chain behind them. Personal access tokens are
 * managed in `modules/developer-api`, but revoking them as part of "sign out
 * everywhere" is an identity concern — so the sweep lives here and identity
 * does not reach sideways into another feature module to perform it.
 */
export async function revokeAllPersonalAccessTokens(
  db: Database,
  userId: string,
  now: Date,
): Promise<number> {
  const revoked = await withD1Retry(
    () =>
      db
        .update(personalAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
        .returning({ id: personalAccessTokens.id }),
    { idempotent: true },
  );
  return revoked.length;
}
