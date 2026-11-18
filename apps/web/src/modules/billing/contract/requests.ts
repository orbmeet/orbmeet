import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import type { BillingCustomer } from "./types";

/** A checkout: Pro for the signed-in person, or the Organization plan for an Organization they own. */
export const checkoutRequestSchema = v.variant("plan", [
  v.object({ plan: v.literal("pro") }),
  v.object({ plan: v.literal("organization"), organizationId: idSchema }),
]);
export type CheckoutRequest = v.InferOutput<typeof checkoutRequestSchema>;

/** The billing portal: the signed-in person's own, or an Organization's they own. */
export const portalRequestSchema = v.object({ organizationId: v.optional(idSchema) });
export type PortalRequest = v.InferOutput<typeof portalRequestSchema>;

export function billingCustomerFor(request: CheckoutRequest | PortalRequest, userId: string): BillingCustomer {
  return "organizationId" in request && request.organizationId
    ? { kind: "organization", organizationId: request.organizationId }
    : { kind: "user", userId };
}
