import * as v from "valibot";

/**
 * The parts of Polar's API objects billing reads, validated at the edge so
 * nothing past this file handles an unchecked provider payload. Fields not
 * listed are ignored.
 */

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const isoTimestamp = v.pipe(
  v.string(),
  v.check((value) => Number.isFinite(Date.parse(value)), "must be an ISO-compatible timestamp"),
);

const polarSubscriptionSchema = v.object({
  id: nonEmptyString,
  status: nonEmptyString,
  product_id: nonEmptyString,
  seats: v.nullish(v.pipe(v.number(), v.integer())),
  cancel_at_period_end: v.boolean(),
  current_period_end: v.nullish(isoTimestamp),
  created_at: isoTimestamp,
  modified_at: v.nullish(isoTimestamp),
  customer: v.object({
    id: nonEmptyString,
    external_id: v.nullish(v.string()),
  }),
  // A change scheduled for the next period, e.g. a seat decrease.
  pending_update: v.nullish(
    v.object({ seats: v.nullish(v.pipe(v.number(), v.integer())) }),
  ),
});

export type PolarSubscription = v.InferOutput<typeof polarSubscriptionSchema>;

export function parsePolarSubscription(value: unknown): PolarSubscription | null {
  const parsed = v.safeParse(polarSubscriptionSchema, value);
  return parsed.success ? parsed.output : null;
}

/**
 * The moment a subscription snapshot describes. Webhook payloads and API reads
 * carry the same object, so ordering both by the object's own clock keeps a
 * late redelivery from overwriting a newer read, and the other way round.
 * `modified_at` is null until the first change.
 */
export function subscriptionVersion(subscription: PolarSubscription): Date {
  return new Date(subscription.modified_at ?? subscription.created_at);
}

const polarCustomerSchema = v.object({
  id: nonEmptyString,
  external_id: v.nullish(v.string()),
  email: v.nullish(v.string()),
});

export type PolarCustomer = v.InferOutput<typeof polarCustomerSchema>;

export function parsePolarCustomer(value: unknown): PolarCustomer | null {
  const parsed = v.safeParse(polarCustomerSchema, value);
  return parsed.success ? parsed.output : null;
}

const polarMemberSchema = v.object({
  id: nonEmptyString,
  external_id: v.nullish(v.string()),
  role: nonEmptyString,
});

export type PolarMember = v.InferOutput<typeof polarMemberSchema>;

export function parsePolarMember(value: unknown): PolarMember | null {
  const parsed = v.safeParse(polarMemberSchema, value);
  return parsed.success ? parsed.output : null;
}

/**
 * A product's prices, as far as showing them goes: one per currency. A fixed
 * price carries its amount; a seat-based one, its per-seat tiers. Amounts are
 * in the currency's smallest unit. Other price types are kept but unpriced.
 */
const polarProductPriceSchema = v.object({
  amount_type: nonEmptyString,
  price_currency: nonEmptyString,
  is_archived: v.boolean(),
  price_amount: v.nullish(v.pipe(v.number(), v.integer())),
  seat_tiers: v.nullish(v.object({
    tiers: v.array(v.object({ price_per_seat: v.pipe(v.number(), v.integer()) })),
  })),
});

const polarProductSchema = v.object({
  id: nonEmptyString,
  prices: v.array(polarProductPriceSchema),
});

export type PolarProduct = v.InferOutput<typeof polarProductSchema>;

export function parsePolarProduct(value: unknown): PolarProduct | null {
  const parsed = v.safeParse(polarProductSchema, value);
  return parsed.success ? parsed.output : null;
}

const polarEventEnvelopeSchema = v.object({
  type: nonEmptyString,
  data: v.record(v.string(), v.unknown()),
});

export type PolarWebhookEvent =
  | { kind: "subscription"; eventType: string; subscription: PolarSubscription }
  | { kind: "ignored"; eventType: string };

/**
 * Every `subscription.*` event (created, active, updated, canceled, revoked,
 * past_due, migrated, …) carries the whole subscription, so they all reduce
 * to storing its current state. Everything else is acknowledged and ignored.
 */
export function parsePolarWebhookEvent(value: unknown): PolarWebhookEvent | null {
  const envelope = v.safeParse(polarEventEnvelopeSchema, value);
  if (!envelope.success) return null;
  const { type: eventType, data } = envelope.output;
  if (!eventType.startsWith("subscription.")) return { kind: "ignored", eventType };
  const subscription = parsePolarSubscription(data);
  return subscription ? { kind: "subscription", eventType, subscription } : null;
}
