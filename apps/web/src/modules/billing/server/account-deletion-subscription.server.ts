import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { Errors } from "@/lib/app-errors";
import {
  cancelSubscription,
  getSubscription,
  paddleApiBase,
} from "@/modules/billing/server/paddle";

type AccountDeletionBillingEnv = Pick<Env, "PADDLE_API_KEY">;

type PaddleSubscriptionListResponse = {
  data: Array<{
    id: string;
    status: string;
    customer_id: string;
    scheduled_change?: { action: string } | null;
  }>;
  meta?: {
    pagination?: {
      next?: string | null;
      has_more?: boolean;
    };
  };
};

/** Statuses that still hold a payable contract at Paddle. */
const BILLABLE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

/**
 * List a customer's still-billable subscriptions.
 *
 * Local to this module on purpose: it is the deletion preflight's read, and
 * the shared Paddle client is organized around single-subscription handles.
 * Same request shape as the client's own calls (bearer auth, JSON, hard
 * timeout) so the two can never drift into different API behavior. Follows
 * Paddle's cursor pagination so a page boundary can never hide a live
 * subscription from the preflight; the page cap only bounds a pathological
 * customer, and tripping it fails closed below.
 */
async function listBillableCustomerSubscriptions(
  apiKey: string,
  customerId: string,
): Promise<PaddleSubscriptionListResponse["data"]> {
  const subscriptions: PaddleSubscriptionListResponse["data"] = [];
  const base = paddleApiBase(apiKey);
  let url = `${base}/subscriptions?${new URLSearchParams({ customer_id: customerId, per_page: "200" })}`;
  // 200-per-page pages; the cap is a runaway guard, not a business limit.
  for (let page = 0; page < 5; page += 1) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A failed lookup is a transient/retryable failure, not a configuration
      // fault — the caller aborts the deletion (marker stays) and a retry
      // starts over, so it must not be mislabeled as CONFIG_ERROR.
      throw new Error(
        `Paddle GET /subscriptions → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as PaddleSubscriptionListResponse;
    const billable = body.data.filter((subscription) =>
      BILLABLE_SUBSCRIPTION_STATUSES.has(subscription.status),
    );
    subscriptions.push(...billable);
    const next = body.meta?.pagination?.has_more ? body.meta.pagination.next : null;
    if (!next) return subscriptions;
    // Paddle's `next` is the whole URL of the following page. It carries the
    // API key, so it is followed only on Paddle's own API.
    if (new URL(next).origin !== new URL(base).origin) {
      throw new Error(`Paddle pagination left the API: ${new URL(next).origin}`);
    }
    url = next;
  }
  // More live subscriptions than the cap allows to read: cancelling a subset
  // and then erasing the customer would strand the rest, so stop the deletion
  // instead of half-finishing it.
  throw Errors.CONFIG_ERROR(
    "The billing customer has more active subscriptions than this deletion can enumerate",
  );
}

/**
 * Close Paddle's billing lifecycle before deleting the local customer locator.
 *
 * The local projection (`users.paddleSubscriptionId`) is one handle, not the
 * truth: a checkout that completed while deletion was running can have created
 * a second subscription that no local column points at, and once the user row
 * is gone the webhook handler cannot find the customer either — the event gets
 * acknowledged and the orphan keeps billing forever. So the preflight cancels
 * by projection (kept for its precise customer-match guard) and then asks
 * Paddle for every still-billable subscription on the customer and cancels
 * each of them.
 *
 * Both reads make retries idempotent: a deletion retried after Paddle accepted
 * the cancellation submits no second cancellation, and a mismatched local
 * projection can never cancel another customer's contract.
 */
export async function cancelAccountSubscriptionBeforeDeletion(
  db: Database,
  env: AccountDeletionBillingEnv,
  userId: string,
): Promise<void> {
  const billing = await db.query.users.findFirst({
    where: { id: userId },
    columns: {
      paddleCustomerId: true,
      paddleSubscriptionId: true,
    },
  });
  if (!billing?.paddleSubscriptionId && !billing?.paddleCustomerId) return;
  if (!env.PADDLE_API_KEY) {
    throw Errors.CONFIG_ERROR("Billing is temporarily unavailable; the account was not deleted");
  }

  // Subscriptions whose cancellation is already ensured (either observed or
  // performed through the projection path below) must not be cancelled twice —
  // Paddle refuses a cancel on an already-cancelling contract, and the refusal
  // would abort an otherwise healthy deletion.
  const handled = new Set<string>();

  if (billing.paddleSubscriptionId) {
    const subscription = await getSubscription(
      env.PADDLE_API_KEY,
      billing.paddleSubscriptionId,
    );
    if (subscription.id !== billing.paddleSubscriptionId) {
      throw Errors.CONFIG_ERROR("Paddle returned an unexpected subscription");
    }
    if (
      !billing.paddleCustomerId ||
      subscription.customer_id !== billing.paddleCustomerId
    ) {
      throw Errors.CONFIG_ERROR("The billing customer does not match this account");
    }
    if (
      subscription.status !== "canceled" &&
      subscription.scheduled_change?.action !== "cancel"
    ) {
      await cancelSubscription(env.PADDLE_API_KEY, subscription.id);
    }
    handled.add(subscription.id);
    // An already-cancelled projection needs no second request — but it proves
    // nothing about the customer's *other* subscriptions, so the sweep below
    // still runs.
  }

  if (!billing.paddleCustomerId) return;
  const billable = await listBillableCustomerSubscriptions(
    env.PADDLE_API_KEY,
    billing.paddleCustomerId,
  );
  for (const subscription of billable) {
    if (handled.has(subscription.id)) continue;
    // Re-check scheduled cancellation per subscription: a cancel already in
    // flight at Paddle needs no second request, and an unnecessary one is the
    // kind of write this preflight exists to avoid.
    if (subscription.scheduled_change?.action === "cancel") continue;
    await cancelSubscription(env.PADDLE_API_KEY, subscription.id);
  }
}
