import { logError } from "@/lib/logger";
import {
  parsePolarCustomer,
  parsePolarMember,
  parsePolarProduct,
  parsePolarSubscription,
  type PolarCustomer,
  type PolarMember,
  type PolarProduct,
  type PolarSubscription,
} from "./polar-schema";

/**
 * Polar's REST API, as thin as it can be: one function per call billing
 * makes, each returning a validated object. Policy lives in the callers.
 */

/**
 * Every request is pinned to one API version, and so is the webhook endpoint
 * (set in the Polar dashboard). Polar ships a version each January, April,
 * July and October; each is "Next" (unfrozen) for three months, then Current,
 * then Deprecated, and is removed nine months after it appeared: 2026-10 is
 * removed in the first week of April 2027. A removed version answers every
 * request 404 `{"detail": "Not Found"}`, which `isPolarNotFound` refuses to
 * read as a missing record.
 *
 * Next: 2027-01, once it is Current (first week of January 2027). Audited
 * against Polar's source in November 2026, it changes nothing billing relies
 * on: the checkout body keeps every field sent here, subscriptions only gain
 * `pending_update.discount_id`/`discount_unset`, webhook payloads only gain
 * `event_id` (the same value as the `webhook-id` header), and customers,
 * members and customer sessions are untouched. Re-check its changelog when
 * flipping, since Next can still change; then set this and the webhook
 * endpoint's version (either order works: the two differ only additively).
 */
export const POLAR_API_VERSION = "2026-10";

const POLAR_PRODUCTION_BASE = "https://api.polar.sh";
const POLAR_SANDBOX_BASE = "https://sandbox-api.polar.sh";

/**
 * Where and as whom to call Polar. The sandbox is a separate server with its
 * own tokens and products, and nothing in a token says which one it belongs
 * to, so the server is configured next to it (`POLAR_SERVER`).
 */
export interface PolarClient {
  accessToken: string;
  baseUrl: string;
}

export function polarClientFromEnv(
  env: { POLAR_ACCESS_TOKEN?: string; POLAR_SERVER?: string },
): PolarClient | null {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const server = env.POLAR_SERVER?.trim().toLowerCase() || "production";
  if (server !== "production" && server !== "sandbox") {
    // A typo must not quietly send a sandbox token to production, or the
    // reverse: billing stays off until the setting is one of the two.
    logError("[polar] POLAR_SERVER must be \"production\" or \"sandbox\"; billing is off", { server });
    return null;
  }
  return { accessToken, baseUrl: server === "sandbox" ? POLAR_SANDBOX_BASE : POLAR_PRODUCTION_BASE };
}

/**
 * A response Polar sent and refused. `code` is Polar's error class name from
 * the body (`ResourceNotFound`, `PaymentFailed`, …), or null when the body has
 * none — a removed API version, an unknown route, a proxy in between.
 */
export class PolarApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PolarApiError";
  }
}

/**
 * Whether Polar answered that the record does not exist. Only Polar's own
 * `ResourceNotFound` counts: any other 404 means the request never reached
 * the record, and acting on it as "gone" would skip real work.
 */
export function isPolarNotFound(error: unknown): boolean {
  return error instanceof PolarApiError && error.status === 404 && error.code === "ResourceNotFound";
}

/**
 * Polar refused a seat change and will keep refusing until somebody acts:
 * - `payment_failed`: the prorated charge was declined or needs the customer.
 * - `not_active`: the subscription is ending, has ended, or the Polar
 *   organization cannot renew yet.
 * - `above_maximum`: more seats than the product allows.
 * - `below_floor`: fewer seats than the product's minimum, or than seats
 *   already assigned in Polar's portal.
 */
export type SeatChangeRefusal = "payment_failed" | "not_active" | "above_maximum" | "below_floor";

/** Polar's error class names (the `error` field of its error body). */
const SEAT_CHANGE_REFUSALS: Record<string, SeatChangeRefusal> = {
  PaymentFailed: "payment_failed",
  PaymentActionRequired: "payment_failed",
  AlreadyCanceledSubscription: "not_active",
  InactiveSubscription: "not_active",
  PaymentNotReady: "not_active",
  AboveMaximumSeats: "above_maximum",
  BelowMinimumSeats: "below_floor",
  SeatsAlreadyAssigned: "below_floor",
};

export function seatChangeRefusal(error: unknown): SeatChangeRefusal | null {
  if (!(error instanceof PolarApiError) || error.code === null) return null;
  return Object.hasOwn(SEAT_CHANGE_REFUSALS, error.code) ? SEAT_CHANGE_REFUSALS[error.code] : null;
}

/** Polar answered that the subscription has already ended. */
export function isAlreadyEnded(error: unknown): boolean {
  return error instanceof PolarApiError && error.code === "AlreadyCanceledSubscription";
}

async function polarRequest(
  client: PolarClient,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 5_000,
): Promise<unknown> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      "Polar-Version": POLAR_API_VERSION,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Polar gives a webhook delivery 10 seconds in all; a webhook may make one
    // of these calls, so one slow read must not spend the whole budget.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string") {
        code = (parsed as { error: string }).error;
      }
    } catch {
      // Not JSON: no code.
    }
    throw new PolarApiError(res.status, code, `Polar ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function expect<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`Polar returned a malformed ${what}`);
  return value;
}

function expectUrl(value: unknown, field: string): string {
  const url = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;
  if (typeof url !== "string" || !url) throw new Error(`Polar response is missing \`${field}\``);
  return url;
}

async function orNullWhenNotFound<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isPolarNotFound(error)) return null;
    throw error;
  }
}

const external = (externalId: string) => `/v1/customers/external/${encodeURIComponent(externalId)}`;

// ─── Customers ──────────────────────────────────────────────────────────

export async function getCustomerByExternalId(
  client: PolarClient,
  externalId: string,
): Promise<PolarCustomer | null> {
  const res = await orNullWhenNotFound(polarRequest(client, "GET", external(externalId)));
  return res === null ? null : expect(parsePolarCustomer(res), "customer");
}

/** Customer emails are unique within a Polar organization (case-insensitive). */
export async function findCustomerByEmail(client: PolarClient, email: string): Promise<PolarCustomer | null> {
  const query = new URLSearchParams({ email, limit: "1" });
  const res = await polarRequest(client, "GET", `/v1/customers/?${query.toString()}`) as { items?: unknown } | null;
  if (!res || !Array.isArray(res.items)) throw new Error("Polar returned a malformed customer list");
  return res.items.length === 0 ? null : expect(parsePolarCustomer(res.items[0]), "customer");
}

export async function createIndividualCustomer(
  client: PolarClient,
  input: { externalId: string; email: string; name: string },
): Promise<PolarCustomer> {
  const res = await polarRequest(client, "POST", "/v1/customers/", {
    type: "individual",
    external_id: input.externalId,
    email: input.email,
    name: input.name.slice(0, 256) || undefined,
  });
  return expect(parsePolarCustomer(res), "customer");
}

/**
 * A team customer has no email of its own; its owner member carries one. That
 * keeps it clear of Polar's one-customer-per-email rule, which the owner's
 * personal customer may already hold.
 */
export async function createTeamCustomer(
  client: PolarClient,
  input: { externalId: string; name: string; owner: { externalId: string; email: string; name: string } },
): Promise<PolarCustomer> {
  const res = await polarRequest(client, "POST", "/v1/customers/", {
    type: "team",
    external_id: input.externalId,
    name: input.name.slice(0, 256),
    owner: {
      external_id: input.owner.externalId,
      email: input.owner.email,
      name: input.owner.name.slice(0, 256) || undefined,
    },
  });
  return expect(parsePolarCustomer(res), "customer");
}

/** Set a customer's external id. Polar refuses once one is set. */
export async function setCustomerExternalId(
  client: PolarClient,
  customerId: string,
  externalId: string,
): Promise<void> {
  await polarRequest(client, "PATCH", `/v1/customers/${encodeURIComponent(customerId)}`, {
    external_id: externalId,
  });
}

/**
 * Delete a customer and anonymize what Polar holds about them. Polar cancels
 * every subscription it has at once. Idempotent: one already gone is the
 * outcome asked for.
 */
export async function deleteCustomer(client: PolarClient, externalId: string): Promise<void> {
  await orNullWhenNotFound(polarRequest(client, "DELETE", `${external(externalId)}?anonymize=true`));
}

// ─── Team customer members ──────────────────────────────────────────────

export async function getMember(
  client: PolarClient,
  customerExternalId: string,
  memberExternalId: string,
): Promise<PolarMember | null> {
  const res = await orNullWhenNotFound(polarRequest(
    client,
    "GET",
    `${external(customerExternalId)}/members/${encodeURIComponent(memberExternalId)}`,
  ));
  return res === null ? null : expect(parsePolarMember(res), "member");
}

export async function createMember(
  client: PolarClient,
  customerExternalId: string,
  member: { externalId: string; email: string; name: string },
): Promise<void> {
  await polarRequest(client, "POST", `${external(customerExternalId)}/members`, {
    external_id: member.externalId,
    email: member.email,
    name: member.name.slice(0, 256) || undefined,
  });
}

/** A team customer's members (it has one per person we added, at most a few). */
export async function listMembers(client: PolarClient, customerExternalId: string): Promise<PolarMember[]> {
  const res = await polarRequest(client, "GET", `${external(customerExternalId)}/members?limit=100`) as
    | { items?: unknown }
    | null;
  if (!res || !Array.isArray(res.items)) throw new Error("Polar returned a malformed member list");
  return res.items.map((item) => expect(parsePolarMember(item), "member"));
}

/** Remove a member; Polar revokes any seat assigned to them. Idempotent. */
export async function deleteMember(
  client: PolarClient,
  customerExternalId: string,
  memberExternalId: string,
): Promise<void> {
  await orNullWhenNotFound(polarRequest(
    client,
    "DELETE",
    `${external(customerExternalId)}/members/${encodeURIComponent(memberExternalId)}`,
  ));
}

/** Make a member the owner. Polar demotes the previous owner. */
export async function makeMemberOwner(
  client: PolarClient,
  customerExternalId: string,
  memberExternalId: string,
): Promise<void> {
  await polarRequest(
    client,
    "PATCH",
    `${external(customerExternalId)}/members/${encodeURIComponent(memberExternalId)}`,
    { role: "owner" },
  );
}

// ─── Products ───────────────────────────────────────────────────────────

/** A product and its prices. Needs the token's `products:read` scope. */
export async function getProduct(client: PolarClient, productId: string): Promise<PolarProduct | null> {
  const res = await orNullWhenNotFound(polarRequest(client, "GET", `/v1/products/${encodeURIComponent(productId)}`));
  return res === null ? null : expect(parsePolarProduct(res), "product");
}

// ─── Checkout and portal ────────────────────────────────────────────────

/**
 * A hosted checkout for one product, linked to an existing customer. Linking
 * by customer id locks the email field on Polar's page: an unlinked checkout
 * lets the buyer type any email, and Polar then attaches the payment to
 * whichever customer holds it.
 */
export async function createCheckout(
  client: PolarClient,
  input: {
    customerId: string;
    productId: string;
    seats?: number;
    successUrl: string;
    returnUrl: string;
    customerIpAddress?: string;
  },
): Promise<string> {
  if (input.seats !== undefined && (!Number.isSafeInteger(input.seats) || input.seats < 1)) {
    throw new Error("Checkout seats must be a positive integer");
  }
  const res = await polarRequest(client, "POST", "/v1/checkouts/", {
    products: [input.productId],
    customer_id: input.customerId,
    // Seats follow membership, which billing owns: the buyer pays for the
    // members there are, no more and no fewer.
    ...(input.seats !== undefined ? { seats: input.seats, min_seats: input.seats, max_seats: input.seats } : {}),
    success_url: input.successUrl,
    return_url: input.returnUrl,
    // The Worker's own address would otherwise pick the currency and tax country.
    ...(input.customerIpAddress ? { customer_ip_address: input.customerIpAddress } : {}),
  });
  return expectUrl(res, "url");
}

/**
 * A pre-authenticated customer portal link. A team customer's portal is opened
 * as one of its members.
 */
export async function createPortalSession(
  client: PolarClient,
  input: { customerExternalId: string; memberExternalId?: string; returnUrl: string },
): Promise<string> {
  const res = await polarRequest(client, "POST", "/v1/customer-sessions/", {
    external_customer_id: input.customerExternalId,
    ...(input.memberExternalId ? { external_member_id: input.memberExternalId } : {}),
    return_url: input.returnUrl,
  });
  return expectUrl(res, "customer_portal_url");
}

// ─── Subscriptions ──────────────────────────────────────────────────────

export async function getSubscription(
  client: PolarClient,
  subscriptionId: string,
): Promise<PolarSubscription | null> {
  const res = await orNullWhenNotFound(
    polarRequest(client, "GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`),
  );
  return res === null ? null : expect(parsePolarSubscription(res), "subscription");
}

/**
 * One page (1-based, up to 100) of the subscriptions in the given statuses.
 * Filters by `status` rather than the deprecated `active`, which also leaves
 * out `past_due` and `paused` subscriptions.
 */
export async function listSubscriptionsByStatus(
  client: PolarClient,
  statuses: readonly string[],
  page: number,
  limit = 100,
): Promise<{ subscriptions: PolarSubscription[]; lastPage: boolean }> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  for (const status of statuses) query.append("status", status);
  const res = await polarRequest(client, "GET", `/v1/subscriptions/?${query.toString()}`) as
    | { items?: unknown; pagination?: { max_page?: unknown } }
    | null;
  if (!res || !Array.isArray(res.items)) throw new Error("Polar returned a malformed subscription list");
  const maxPage = typeof res.pagination?.max_page === "number" ? res.pagination.max_page : page;
  return {
    subscriptions: res.items.map((item) => expect(parsePolarSubscription(item), "subscription")),
    lastPage: page >= maxPage,
  };
}

/**
 * Every subscription a customer has, in any status. A customer holds at most
 * a few (Polar allows one live subscription per customer), so one page does.
 */
export async function listCustomerSubscriptions(
  client: PolarClient,
  customerExternalId: string,
): Promise<PolarSubscription[]> {
  const query = new URLSearchParams({ external_customer_id: customerExternalId, limit: "100" });
  const res = await polarRequest(client, "GET", `/v1/subscriptions/?${query.toString()}`) as
    | { items?: unknown }
    | null;
  if (!res || !Array.isArray(res.items)) throw new Error("Polar returned a malformed subscription list");
  return res.items.map((item) => expect(parsePolarSubscription(item), "subscription"));
}

/**
 * Set a seat-based subscription's seats. `invoice` applies now and charges
 * the prorated difference before answering; `next_period` schedules the
 * change as the subscription's `pending_update`.
 */
export async function updateSubscriptionSeats(
  client: PolarClient,
  subscriptionId: string,
  seats: number,
  prorationBehavior: "invoice" | "next_period",
): Promise<PolarSubscription> {
  if (!Number.isSafeInteger(seats) || seats < 1) {
    throw new Error("Subscription seats must be a positive integer");
  }
  // The request charges the card before it answers; cutting it short could
  // report a failure for a charge that went through.
  const res = await polarRequest(
    client,
    "PATCH",
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { seats, proration_behavior: prorationBehavior },
    15_000,
  );
  return expect(parsePolarSubscription(res), "subscription");
}

/**
 * End a subscription now, paused ones included. Irreversible. Polar refuses
 * one that has already ended (`isAlreadyEnded`).
 */
export async function revokeSubscription(client: PolarClient, subscriptionId: string): Promise<void> {
  await polarRequest(client, "DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}
