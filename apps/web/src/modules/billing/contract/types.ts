import {
  PAID_SUBSCRIPTION_TIERS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionTier,
} from "@orbmeet/domain-model";

export type { SubscriptionTier };
export type PaidSubscriptionTier = (typeof PAID_SUBSCRIPTION_TIERS)[number];
/** A subscription's state, or null where there is no subscription. */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number] | null;

/** Who pays: a person buys Pro, an Organization buys the Organization plan. */
export type BillingCustomer =
  | { kind: "user"; userId: string }
  | { kind: "organization"; organizationId: string };

/** The plan each kind of customer buys. */
export function planForCustomer(customer: BillingCustomer): PaidSubscriptionTier {
  return customer.kind === "user" ? "pro" : "organization";
}
