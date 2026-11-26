import type { Database } from "@orbmeet/db";
import { verifications } from "@orbmeet/db/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_RE = /^[a-f0-9]{64}$/i;

/**
 * Parse a `<uuid-v4>.<64-hex-secret>` flow or grant token used to bind a
 * verification record to the browser that started it.
 */
export function parseScopedFlowToken(token: string): { id: string; secret: string } | null {
  const separator = token.indexOf(".");
  if (separator < 1 || separator !== token.lastIndexOf(".")) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!UUID_V4_RE.test(id) || !HEX_64_RE.test(secret)) return null;
  return { id, secret };
}

export interface OtpDeliveryLease {
  identifier: string;
  claimId: string;
}

/**
 * Claim a cooldown-bounded OTP delivery lease in `verifications`. Returns the
 * held lease on success, or `null` when an unexpired lease is already active.
 */
export async function claimOtpDeliveryLease(
  db: Database,
  identifier: string,
  cooldownMs: number,
  now = new Date(),
): Promise<OtpDeliveryLease | null> {
  const claimId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + cooldownMs);
  const result = await db
    .insert(verifications)
    .values({
      id: crypto.randomUUID(),
      type: "otp_delivery",
      identifier,
      value: claimId,
      data: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [verifications.type, verifications.identifier],
      set: {
        value: claimId,
        expiresAt,
        updatedAt: now,
      },
      setWhere: lte(verifications.expiresAt, now),
    })
    .run();
  return getRunChanges(result) === 1 ? { identifier, claimId } : null;
}

/** Release a previously claimed OTP delivery lease if it still belongs to `claimId`. */
export async function releaseOtpDeliveryLease(
  db: Database,
  lease: OtpDeliveryLease,
): Promise<void> {
  await withD1Retry(
    () =>
      db
        .delete(verifications)
        .where(
          and(
            eq(verifications.type, "otp_delivery"),
            eq(verifications.identifier, lease.identifier),
            eq(verifications.value, lease.claimId),
          ),
        ),
    { idempotent: true },
  ).catch(() => undefined);
}

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
