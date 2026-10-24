import { SUBSCRIPTION_STATUSES, type SubscriptionTier } from "@orbmeet/domain-model";

export type { SubscriptionTier };
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number] | null;

// The tiers a customer can actually buy. Spelled out rather than filtered so
// the literal types survive, and constrained to SubscriptionTier so renaming
// or removing a tier fails to compile here instead of drifting silently.
export const PAID_SUBSCRIPTION_TIERS = [
  "pro",
  "organization",
] as const satisfies readonly SubscriptionTier[];
export type PaidSubscriptionTier = (typeof PAID_SUBSCRIPTION_TIERS)[number];
