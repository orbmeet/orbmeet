import type { Database } from "@orbmeet/db";
import { verifications } from "@orbmeet/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { getRunChanges } from "@/platform/database/db-utils";

/**
 * The code-attempt budget, enforced per verification row.
 *
 * This is a budget of *attempts*, not of failures: every code comparison must
 * first atomically reserve one attempt (see `reserveVerificationAttempt`), so
 * at most MAX comparisons can ever be made against one code. Previously the
 * budget was checked at flow-load time and only incremented after a failed
 * comparison, so parallel requests could all compare against the code at once
 * and a comparison that started before exhaustion could still consume the flow
 * after the fifth failure had been recorded. The error wording everywhere is
 * the same generic "invalid or expired" message; the count is deliberately not
 * surfaced.
 */
export const MAX_FAILED_VERIFICATION_ATTEMPTS = 5;

/**
 * Defense-in-depth fence for consumption: refuses to delete a verification row
 * whose recorded attempts somehow exceed the budget (a direct-consume path that
 * skipped reservation). It is `<=` rather than `<` on purpose — the fifth and
 * final reservation moves the counter to exactly MAX, and that attempt's
 * legitimate consumption must still succeed.
 *
 * A function, not a module-scope constant: building the fragment reads the
 * (browser-stubbed) DB schema, and this module is reachable from client
 * modules that hold server-function handles — see the app import-boundary test.
 */
export function verificationAttemptBudgetRemainingSql() {
  return sql`coalesce(json_extract(${verifications.data}, '$.failedAttempts'), 0) <= ${MAX_FAILED_VERIFICATION_ATTEMPTS}`;
}

export interface VerificationAttemptData {
  /** Optional only for flows created immediately before this field was introduced. */
  failedAttempts?: number;
}

export function hasVerificationAttemptsRemaining(data: Partial<VerificationAttemptData>): boolean {
  const failedAttempts = data.failedAttempts ?? 0;
  return (
    Number.isInteger(failedAttempts) &&
    failedAttempts >= 0 &&
    failedAttempts < MAX_FAILED_VERIFICATION_ATTEMPTS
  );
}

/**
 * Atomically reserve one code attempt against the budget.
 *
 * A single conditional UPDATE is the whole point: the row only changes when it
 * is still the expected flow (id + value hash), still unexpired, and still has
 * attempts left. If zero rows changed, the caller must reject — either the
 * budget is exhausted or the row expired/rotated under the load — without ever
 * comparing the code. Because reservation precedes comparison, total
 * comparisons ≤ total successful reservations ≤ 5.
 *
 * Returns true when this caller owns one attempt.
 */
export async function reserveVerificationAttempt(
  db: Database,
  verification: { id: string; value: string },
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .update(verifications)
    .set({
      data: sql`json_set(coalesce(json(${verifications.data}), json_object()), '$.failedAttempts', coalesce(json_extract(${verifications.data}, '$.failedAttempts'), 0) + 1)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(verifications.id, verification.id),
        eq(verifications.value, verification.value),
        gte(verifications.expiresAt, now),
        sql`coalesce(json_extract(${verifications.data}, '$.failedAttempts'), 0) < ${MAX_FAILED_VERIFICATION_ATTEMPTS}`,
      ),
    )
    .run();
  return getRunChanges(result) === 1;
}
