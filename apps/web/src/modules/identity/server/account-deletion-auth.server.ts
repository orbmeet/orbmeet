import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { devices, personalAccessTokens, sessions } from "@orbmeet/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { withD1Retry } from "@/platform/database/db-utils";

/**
 * Close every authentication path except the request that is continuing the
 * deletion. Ordinary session resolution also rejects deletion-started users,
 * so the retained row is useful only to retry this idempotent workflow.
 *
 * `currentSessionId` is null when no request owns the work — the maintenance
 * sweep — and then every session is revoked. None of them can reach anything
 * but the recovery surface, and a person can always sign back in to get a
 * fresh one, so sweeping them up is pure hygiene.
 */
export async function revokeAccountAuthenticationExceptCurrent(
  db: Database,
  userId: string,
  currentSessionId: string | null,
): Promise<void> {
  await withD1Retry(
    () => db.batch([
      db.delete(sessions).where(and(
        eq(sessions.userId, userId),
        currentSessionId ? ne(sessions.id, currentSessionId) : undefined,
      )),
      db.delete(devices).where(eq(devices.userId, userId)),
      db.delete(personalAccessTokens).where(eq(personalAccessTokens.userId, userId)),
    ]),
    { idempotent: true },
  );
}
