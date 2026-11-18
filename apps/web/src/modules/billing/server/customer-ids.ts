import type { BillingCustomer } from "@/modules/billing/contract/types";

/**
 * How our customers are named at Polar. Each Polar customer carries one of
 * these as its external id, so a subscription arriving by webhook says by
 * itself which user or Organization it belongs to. The prefix keeps the two
 * id spaces apart.
 */
const USER_PREFIX = "user:";
const ORGANIZATION_PREFIX = "org:";

export function customerExternalId(customer: BillingCustomer): string {
  return customer.kind === "user"
    ? `${USER_PREFIX}${customer.userId}`
    : `${ORGANIZATION_PREFIX}${customer.organizationId}`;
}

/** Null for a customer billing did not create (a dashboard sale, a typo). */
export function parseCustomerExternalId(value: string | null | undefined): BillingCustomer | null {
  if (value?.startsWith(USER_PREFIX) && value.length > USER_PREFIX.length) {
    return { kind: "user", userId: value.slice(USER_PREFIX.length) };
  }
  if (value?.startsWith(ORGANIZATION_PREFIX) && value.length > ORGANIZATION_PREFIX.length) {
    return { kind: "organization", organizationId: value.slice(ORGANIZATION_PREFIX.length) };
  }
  return null;
}

/** A user as a member of an Organization's team customer. */
export function memberExternalId(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}
