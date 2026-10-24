import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { emailSuppressions } from "@orbmeet/db/schema";

import { normalizeEmailAddress } from "@/platform/email/address";
import type { EmailSuppressionReason } from "@/platform/email/delivery";

/**
 * Reasons an address can land in the local suppression mirror. The two
 * {@link EmailSuppressionReason} values come from a rejected send; `complained`
 * is reserved for the spam feedback loop delivered through Email Sending event
 * subscriptions, and `unsubscribed` comes from one-click List-Unsubscribe.
 */
export type SuppressionReason = EmailSuppressionReason | "complained" | "unsubscribed";

/**
 * Which of `emails` must not be mailed.
 *
 * Cloudflare owns the authoritative account-wide suppression list and rejects a
 * suppressed recipient with `E_RECIPIENT_SUPPRESSED`, but it exposes no read
 * API — a send is the only way to observe an entry. Mirroring locally lets
 * delivery skip a known-dead address instead of spending an attempt, and a hard
 * bounce against the <2% reputation target, to rediscover it every time.
 * See docs/email-service/concepts/suppressions.md.
 *
 * Returns normalized addresses; compare against {@link normalizeEmailAddress} of yours.
 */
export async function loadSuppressedEmails(
  db: Database,
  emails: readonly string[],
): Promise<Set<string>> {
  const normalized = [...new Set(emails.map(normalizeEmailAddress))].filter(Boolean);
  if (normalized.length === 0) return new Set();
  const rows = await db.query.emailSuppressions.findMany({
    columns: { normalizedEmail: true },
    where: { normalizedEmail: { in: normalized } },
  });
  return new Set(rows.map((row) => row.normalizedEmail));
}

/**
 * Record an address as unmailable.
 *
 * First reason wins: an address suppressed for a hard bounce should not be
 * relabelled by a later unsubscribe (or the reverse), and a redelivery pass must
 * not churn `created_at`. That also makes the unsubscribe endpoint idempotent,
 * which RFC 8058 one-click clients rely on.
 */
export async function recordEmailSuppression(
  db: Database,
  input: {
    email: string;
    reason: SuppressionReason;
    providerCode?: string | null;
    now?: Date;
  },
): Promise<void> {
  const normalizedEmail = normalizeEmailAddress(input.email);
  if (!normalizedEmail) return;
  await db
    .insert(emailSuppressions)
    .values({
      normalizedEmail,
      reason: input.reason,
      providerCode: input.providerCode ?? null,
      createdAt: input.now ?? new Date(),
    })
    .onConflictDoNothing();
}
