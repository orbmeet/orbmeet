/**
 * The query parameters Polar's hosted checkout returns to Settings with: the
 * checkout's id, and for an Organization's checkout, which Organization.
 * Written by server/checkout.server.ts, read by client/checkout-return.ts.
 */
export const CHECKOUT_RETURN_PARAM = "checkout";
export const CHECKOUT_RETURN_ORGANIZATION_PARAM = "checkoutOrganization";
