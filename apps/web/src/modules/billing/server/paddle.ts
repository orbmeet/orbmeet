const PADDLE_LIVE_BASE = "https://api.paddle.com";
const PADDLE_SANDBOX_BASE = "https://sandbox-api.paddle.com";

/**
 * Pick the API host the key actually belongs to.
 *
 * Sandbox API keys contain `_sdbx`, live keys `_live`. Deriving the host from
 * the key rather than from a separate environment setting makes the two
 * impossible to disagree: a sandbox key can never be sent to the live API (a
 * blanket 403 on every billing call), and a live key can never be sent to the
 * sandbox one. Paddle.js does the same on the client, from its own token.
 */
export function paddleApiBase(apiKey: string): string {
  return apiKey.includes("_sdbx") ? PADDLE_SANDBOX_BASE : PADDLE_LIVE_BASE;
}

type PaddleCustomer = { id: string; email: string; name: string; status?: string };
export type PaddleSubscription = {
  id: string;
  status: string;
  items: Array<{ price: { id: string }; quantity?: number }>;
  customer_id: string;
  updated_at: string;
  scheduled_change?: {
    action: string;
    effective_at: string;
  } | null;
};

/**
 * A Paddle response that was received and refused, carrying the status.
 *
 * Callers have to tell "Paddle says this subscription does not exist" apart from
 * "Paddle could not be reached": the first is an answer to act on, the second is
 * a transient failure that must not be mistaken for one.
 */
export class PaddleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PaddleApiError";
  }
}

async function paddleRequest<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${paddleApiBase(apiKey)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PaddleApiError(res.status, `Paddle ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Find a customer by exact email, including archived ones.
 *
 * `email` is an exact-match filter; `search` is a fuzzy match over id, name and
 * email, so with a paginated cap the real match can fall outside the page we
 * look at and we would go on to create a duplicate. `status` defaults to active
 * only, but Paddle still refuses to create a customer whose email belongs to an
 * archived one, so archived rows have to be visible here too.
 */
async function findPaddleCustomerByEmail(
  apiKey: string,
  email: string,
): Promise<string | null> {
  const res = await paddleRequest<{ data: PaddleCustomer[] }>(
    apiKey,
    "GET",
    `/customers?email=${encodeURIComponent(email)}&status=active,archived&per_page=200`,
  );
  const normalizedEmail = email.toLowerCase();
  const matches = res.data.filter((c) => c.email.toLowerCase() === normalizedEmail);
  const active = matches.find((c) => c.status !== "archived");
  return (active ?? matches[0])?.id ?? null;
}

export async function getOrCreatePaddleCustomer(
  apiKey: string,
  email: string,
  name: string,
): Promise<string> {
  const existing = await findPaddleCustomerByEmail(apiKey, email);
  if (existing) return existing;

  try {
    const created = await paddleRequest<{ data: PaddleCustomer }>(
      apiKey,
      "POST",
      "/customers",
      { email, name },
    );
    return created.data.id;
  } catch (err) {
    // Two concurrent checkouts, or a customer the lookup could not see. Paddle
    // answers 409 `customer_already_exists`, and nothing is stored locally yet,
    // so an uncaught throw here would fail this user's checkout identically on
    // every retry. Re-read instead and use the customer that already exists.
    if (err instanceof PaddleApiError && err.status === 409) {
      const raced = await findPaddleCustomerByEmail(apiKey, email);
      if (raced) return raced;
    }
    throw err;
  }
}

export async function createPortalSession(
  apiKey: string,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const res = await paddleRequest<{ data: { urls: { general: { overview: string } } } }>(
    apiKey,
    "POST",
    `/customers/${customerId}/portal-sessions`,
    { urls: [returnUrl] },
  );
  return res.data.urls.general.overview;
}

type PaddleTransaction = {
  id: string;
  status: string;
  // Required fields on Paddle's transaction response; read defensively below.
  origin: string;
  created_at: string;
  updated_at: string;
  billed_at: string | null;
  items: Array<{ price?: { id?: string } | null; quantity?: number }>;
};

// A terminal-status checkout transaction only proves a purchase is settling
// while our subscription webhook could plausibly still be lagging it. After
// this window the projection has either landed (the SUBSCRIPTION_EXISTS gate
// covers it) or is lost — and an old purchase must never block a lapsed
// subscriber from re-subscribing. Covers sandbox retries (15 min) twice over
// and the first ~20 live retry attempts; no window covers a multi-day webhook
// outage, which is a reconciliation problem, not a checkout one.
const SETTLING_WINDOW_MS = 30 * 60_000;

/**
 * The customer's existing unpaid checkout for exactly this plan and quantity.
 *
 * Paddle accepts no client-supplied idempotency key on `POST /transactions`, so
 * a repeated checkout request would otherwise mint a second payable
 * transaction. Reusing the open one makes the endpoint idempotent for real: a
 * double-click, a reload, or a user who closed the overlay and came back all
 * reopen the same checkout instead of being refused or billed twice.
 *
 * `draft` and `ready` are the statuses a transaction can still be completed
 * from, and they are reusable at any age. A billed/paid/completed checkout
 * blocks a new one only while it was paid recently enough to still be settling
 * — see SETTLING_WINDOW_MS. The query is scoped to checkout-origin transactions
 * (`api,web`), so renewal and seat-proration charges — which share the price
 * and quantity of a re-subscribe — can never match. The quantity has to match
 * too — an Organization whose seat count moved since the transaction was
 * created needs a fresh one.
 */
export type MatchingCheckoutTransaction =
  | { state: "open"; transactionId: string }
  | { state: "settling"; transactionId: string };

export async function findMatchingCheckoutTransaction(
  apiKey: string,
  input: { customerId: string; priceId: string; quantity: number },
): Promise<MatchingCheckoutTransaction | null> {
  const query = new URLSearchParams({
    customer_id: input.customerId,
    // Only checkout-intent purchases may block a new checkout. Renewal
    // (`subscription_recurring`) and seat-proration (`subscription_update`)
    // charges share the price and quantity of a re-subscribe; they are not
    // someone else's in-flight purchase. The response-side check below mirrors
    // this filter in case the API ever ignores or drops it.
    origin: "api,web",
    // billed/paid/completed can precede our subscription webhook. They are not
    // reusable checkouts, but within the settling window they are proof that
    // creating another payable transaction would duplicate a purchase already
    // settling at Paddle. past_due is the dunning state of renewal payments —
    // a checkout-intent transaction that fails payment stays completable
    // (`ready`) — so it can only add noise.
    status: "draft,ready,billed,paid,completed",
    collection_mode: "automatic",
    order_by: "created_at[DESC]",
    per_page: "30",
  });
  const res = await paddleRequest<{ data: PaddleTransaction[] }>(
    apiKey,
    "GET",
    `/transactions?${query.toString()}`,
  );
  const match = res.data.find((transaction) =>
    checkoutOrigin(transaction)
    && transaction.items.length === 1
    && transaction.items[0]?.price?.id === input.priceId
    && (transaction.items[0]?.quantity ?? 1) === input.quantity
    && (transaction.status === "draft"
      || transaction.status === "ready"
      || checkoutIsStillSettling(transaction)),
  );
  if (!match) return null;
  return {
    state: match.status === "draft" || match.status === "ready" ? "open" : "settling",
    transactionId: match.id,
  };
}

/**
 * The customer's subscriptions that already carry paid entitlements (active or
 * trialing), read straight from Paddle.
 *
 * Our projection of Paddle lags Paddle itself: a completed checkout can have
 * created its subscription there while the webhook that would record it locally
 * is still in flight. Reading the live list before minting another payable
 * transaction closes that gap, so a saved payment method cannot be collected
 * from a second time. `past_due` and `paused` are excluded on purpose — neither
 * grants entitlements, and a lapsed subscriber has to be able to check out
 * again.
 */
async function listActiveCustomerSubscriptions(
  apiKey: string,
  customerId: string,
): Promise<PaddleSubscription[]> {
  const query = new URLSearchParams({
    customer_id: customerId,
    status: "active,trialing",
    per_page: "200",
  });
  const res = await paddleRequest<{ data: PaddleSubscription[] }>(
    apiKey,
    "GET",
    `/subscriptions?${query.toString()}`,
  );
  return res.data;
}

/**
 * What a checkout request may be handed, decided before any payable
 * transaction is created:
 * - `open` — the customer's own reusable transaction, to complete;
 * - `pending` — a purchase of this plan is already settling at Paddle, or the
 *   customer already holds an entitled subscription there; retry shortly;
 * - `none` — nothing blocks creating a fresh transaction.
 *
 * The subscription check runs first on purpose: once a purchase has settled
 * into an active subscription at Paddle, even the customer's own older open
 * transaction must not be reopened — completing it would charge them twice.
 */
export type CheckoutTransactionResolution =
  | { state: "open"; transactionId: string }
  | { state: "pending" }
  | { state: "none" };

export async function resolveCheckoutTransaction(
  apiKey: string,
  input: { customerId: string; priceId: string; quantity: number },
): Promise<CheckoutTransactionResolution> {
  if ((await listActiveCustomerSubscriptions(apiKey, input.customerId)).length > 0) {
    return { state: "pending" };
  }
  const match = await findMatchingCheckoutTransaction(apiKey, input);
  if (!match) return { state: "none" };
  return match.state === "open"
    ? { state: "open", transactionId: match.transactionId }
    : { state: "pending" };
}

// Mirrors the query's `origin` filter: renewal and proration charges share the
// price and quantity of a re-subscribe and must never match, even if the API
// filter were ignored or dropped.
function checkoutOrigin(transaction: PaddleTransaction): boolean {
  return transaction.origin === "api" || transaction.origin === "web";
}

// An aged-out terminal-status checkout is skipped rather than treated as a
// match, so the scan continues to an open transaction behind it. An
// unparseable timestamp fails closed: block rather than risk a double
// purchase.
//
// The age that matters is when the transaction was PAID, not when the checkout
// was created: Paddle can collect on a saved payment method long after a draft
// was minted, so a checkout created 45 minutes ago but paid moments ago is
// exactly the duplicate our webhook could still be lagging behind.
// `billed_at` carries the payment time for billed/completed transactions; a
// `paid` one can still be without it (Paddle leaves it null there), so
// `updated_at` — set on every status move — is the fallback.
function checkoutIsStillSettling(transaction: PaddleTransaction): boolean {
  const billedAt = Date.parse(transaction.billed_at ?? "");
  const paidAt = Number.isNaN(billedAt) ? Date.parse(transaction.updated_at) : billedAt;
  return Number.isNaN(paidAt) || Date.now() - paidAt <= SETTLING_WINDOW_MS;
}

export async function createCheckoutTransaction(
  apiKey: string,
  input: { customerId: string; priceId: string; quantity: number },
): Promise<string> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error("Checkout quantity must be a positive integer");
  }
  const res = await paddleRequest<{ data: { id: string } }>(
    apiKey,
    "POST",
    "/transactions",
    {
      customer_id: input.customerId,
      collection_mode: "automatic",
      items: [{ price_id: input.priceId, quantity: input.quantity }],
    },
  );
  return res.data.id;
}

export async function cancelSubscription(
  apiKey: string,
  subscriptionId: string,
  effectiveFrom: "next_billing_period" | "immediately" = "next_billing_period",
): Promise<void> {
  await paddleRequest(apiKey, "POST", `/subscriptions/${subscriptionId}/cancel`, {
    effective_from: effectiveFrom,
  });
}

/**
 * Drop a subscription's scheduled change (a cancellation or plan change due at
 * the period's end). Paddle refuses any other change while one is pending.
 */
export async function removeScheduledChange(apiKey: string, subscriptionId: string): Promise<void> {
  await paddleRequest(apiKey, "PATCH", `/subscriptions/${subscriptionId}`, { scheduled_change: null });
}

export async function getSubscription(
  apiKey: string,
  subscriptionId: string,
): Promise<PaddleSubscription> {
  const res = await paddleRequest<{ data: PaddleSubscription }>(
    apiKey,
    "GET",
    `/subscriptions/${subscriptionId}`,
  );
  return res.data;
}

export async function updateSubscriptionQuantity(
  apiKey: string,
  subscriptionId: string,
  priceId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Subscription quantity must be a positive integer");
  }
  // Paddle treats `items` as the complete list: "Send the complete list of
  // items that you'd like to be on a subscription — including existing items.
  // If you omit items, they're removed from the subscription." Sending only the
  // seat price would therefore delete every other item — an add-on, a second
  // catalog price, anything attached from the dashboard — as a side effect of a
  // seat adjustment. Read the live list and change one quantity in it.
  const current = await getSubscription(apiKey, subscriptionId);
  const items = current.items.map(({ price, quantity: itemQuantity }) => ({
    price_id: price.id,
    quantity: price.id === priceId ? quantity : itemQuantity ?? 1,
  }));
  if (!items.some((item) => item.price_id === priceId)) {
    items.push({ price_id: priceId, quantity });
  }
  await paddleRequest(apiKey, "PATCH", `/subscriptions/${subscriptionId}`, {
    items,
    proration_billing_mode: "prorated_immediately",
  });
}

export async function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(";").map((part) => {
      const [key = "", value = ""] = part.split("=", 2);
      return [key.trim(), value.trim()] as const;
    }),
  );
  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) return false;
  const timestampSeconds = Number.parseInt(ts, 10);
  if (!Number.isFinite(timestampSeconds)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxAgeSeconds = 5 * 60;
  if (Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signedPayload = `${ts}:${rawBody}`;
  if (!/^[\da-f]+$/i.test(h1) || h1.length % 2 !== 0) {
    return false;
  }
  const sigBytes = h1.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16));
  return crypto.subtle.verify("HMAC", key, new Uint8Array(sigBytes), encoder.encode(signedPayload));
}
