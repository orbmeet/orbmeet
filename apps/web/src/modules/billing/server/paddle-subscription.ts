import type { SubscriptionTier } from "@/modules/billing/contract/plan-limits";
import * as v from "valibot";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";

type PaddleSubscriptionStatus =
  | "active"
  | "canceled"
  | "past_due"
  | "trialing"
  | "paused";

export interface PaddleSubscriptionSnapshot {
  id: string;
  customer_id: string;
  status: string;
  items: Array<{ price: { id: string }; quantity?: number }>;
}

export interface PaddlePriceConfig {
  PADDLE_PRICE_ID_PRO?: string;
  PADDLE_PRICE_ID_ORG_SEAT?: string;
}

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());

const paddleEventEnvelopeSchema = v.object({
  event_id: v.optional(v.string()),
  event_type: nonEmptyString,
  occurred_at: v.optional(v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value)), "occurred_at must be an ISO-compatible timestamp"),
  )),
  data: v.record(v.string(), v.unknown()),
});

const paddleSubscriptionItemSchema = v.object({
  price: v.object({ id: nonEmptyString }),
  quantity: v.optional(v.pipe(v.number(), v.finite())),
});

const paddleSubscriptionUpsertDataSchema = v.object({
  id: nonEmptyString,
  customer_id: nonEmptyString,
  status: nonEmptyString,
  items: v.array(paddleSubscriptionItemSchema),
});

const paddleSubscriptionCanceledDataSchema = v.object({
  id: nonEmptyString,
  scheduled_change: v.nullish(v.object({
    action: nonEmptyString,
    effective_at: nonEmptyString,
  })),
});

const paddleAdjustmentDataSchema = v.object({
  id: nonEmptyString,
  action: nonEmptyString,
  type: v.nullish(nonEmptyString),
  status: v.nullish(nonEmptyString),
  subscription_id: v.nullish(nonEmptyString),
  customer_id: v.nullish(nonEmptyString),
});

interface ParsedPaddleEventBase {
  eventId?: string;
  eventType: string;
  occurredAt?: string;
}

export type ParsedPaddleEvent =
  | (ParsedPaddleEventBase & {
      kind: "subscription-upsert";
      eventType: "subscription.created" | "subscription.updated";
      data: PaddleSubscriptionSnapshot;
    })
  | (ParsedPaddleEventBase & {
      kind: "subscription-canceled";
      eventType: "subscription.canceled";
      data: v.InferOutput<typeof paddleSubscriptionCanceledDataSchema>;
    })
  | (ParsedPaddleEventBase & {
      kind: "adjustment";
      eventType: "adjustment.created" | "adjustment.updated";
      data: v.InferOutput<typeof paddleAdjustmentDataSchema>;
    })
  | (ParsedPaddleEventBase & {
      kind: "ignored";
      data: Record<string, unknown>;
    });

/** Validate and normalize the provider payload before it reaches billing logic. */
export function parsePaddleWebhookEvent(value: unknown): ParsedPaddleEvent | null {
  const envelope = v.safeParse(paddleEventEnvelopeSchema, value);
  if (!envelope.success) return null;

  const { event_id, event_type: eventType, occurred_at, data } = envelope.output;
  const base = { eventId: event_id, eventType, occurredAt: occurred_at };

  if (eventType === "subscription.created" || eventType === "subscription.updated") {
    const parsed = v.safeParse(paddleSubscriptionUpsertDataSchema, data);
    return parsed.success
      ? { ...base, kind: "subscription-upsert", eventType, data: parsed.output }
      : null;
  }

  if (eventType === "subscription.canceled") {
    const parsed = v.safeParse(paddleSubscriptionCanceledDataSchema, data);
    return parsed.success
      ? { ...base, kind: "subscription-canceled", eventType, data: parsed.output }
      : null;
  }

  // An adjustment is acted on by its state, whichever event reports it: a
  // refund Paddle has to approve is created `pending_approval` and only
  // reaches `approved` in a later `adjustment.updated`.
  if (eventType === "adjustment.created" || eventType === "adjustment.updated") {
    const parsed = v.safeParse(paddleAdjustmentDataSchema, data);
    // A refund or chargeback carries the fields below; anything shaped
    // differently is a Paddle adjustment this build does not act on, so fall
    // through to `ignored` and acknowledge it rather than reject-loop.
    if (parsed.success) return { ...base, kind: "adjustment", eventType, data: parsed.output };
  }

  return { ...base, kind: "ignored", data };
}

/**
 * The outcome of reading a Paddle subscription's entitlement state.
 *
 * Two distinct things can stop us resolving one, and they want opposite
 * handling, so they are named rather than collapsed into one failure:
 *
 * - `unresolved-catalog`: the price ids on the subscription do not map onto
 *   exactly one configured plan. That is a misconfiguration a human repairs, so
 *   the caller should keep the event retryable — the retry succeeds once the
 *   catalog is fixed.
 * - `unknown-status`: Paddle reported a status this build does not know. No
 *   configuration change makes a retry succeed, so the caller should record the
 *   event and leave the projection alone rather than retry forever.
 *
 * Neither guesses at durable entitlements.
 */
export type ResolvedPaddleSubscriptionState =
  | { resolved: true; status: PaddleSubscriptionStatus; plan: SubscriptionTier }
  | { resolved: false; reason: "unknown-status"; status: null; plan: null }
  | {
      resolved: false;
      reason: "unresolved-catalog";
      status: PaddleSubscriptionStatus;
      plan: null;
    };

const PADDLE_SUBSCRIPTION_STATUSES = new Set<PaddleSubscriptionStatus>([
  "active",
  "canceled",
  "past_due",
  "trialing",
  "paused",
]);

export function resolvePaddleSubscriptionState(
  subscription: Pick<PaddleSubscriptionSnapshot, "status" | "items">,
  env: PaddlePriceConfig,
): ResolvedPaddleSubscriptionState {
  if (!PADDLE_SUBSCRIPTION_STATUSES.has(subscription.status as PaddleSubscriptionStatus)) {
    return { resolved: false, reason: "unknown-status", status: null, plan: null };
  }
  const status = subscription.status as PaddleSubscriptionStatus;
  const entitled = status === "active" || status === "trialing";
  if (!entitled) return { resolved: true, status, plan: "free" };

  const proPriceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_PRO);
  const organizationPriceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT);

  const plans = subscription.items.flatMap(({ price }) => {
    if (proPriceId && price.id === proPriceId) return ["pro" as const];
    if (organizationPriceId && price.id === organizationPriceId) {
      return ["organization" as const];
    }
    return [];
  });
  const distinctPlans = [...new Set(plans)];
  if (distinctPlans.length !== 1) {
    // Never guess at durable entitlements from a partial or unknown catalog.
    // The route leaves the receipt retryable until configuration is repaired.
    return { resolved: false, reason: "unresolved-catalog", status, plan: null };
  }
  return { resolved: true, status, plan: distinctPlans[0] };
}
