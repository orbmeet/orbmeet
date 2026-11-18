import {
  CHECKOUT_RETURN_ORGANIZATION_PARAM,
  CHECKOUT_RETURN_PARAM,
} from "../contract/checkout-return";

/**
 * Polar's hosted checkout sends the customer back to Settings with
 * `checkout=<id>` (see server/checkout.server.ts), and with the Organization
 * for an Organization's checkout. That marker is the only signal the browser
 * gets that a purchase just completed; the subscription itself arrives later,
 * by signed webhook.
 */
export interface CheckoutReturn {
  /** The Organization that bought, or null for the person's own Pro. */
  organizationId: string | null;
}

/**
 * What the URL says was bought, and the URL without the markers; null when it
 * is not a checkout return. Pure, so the browser wrapper below stays small.
 */
export function stripCheckoutReturn(href: string): { checkout: CheckoutReturn; strippedUrl: string } | null {
  const url = new URL(href);
  if (!url.searchParams.get(CHECKOUT_RETURN_PARAM)) return null;
  const organizationId = url.searchParams.get(CHECKOUT_RETURN_ORGANIZATION_PARAM) || null;
  url.searchParams.delete(CHECKOUT_RETURN_PARAM);
  url.searchParams.delete(CHECKOUT_RETURN_ORGANIZATION_PARAM);
  return { checkout: { organizationId }, strippedUrl: `${url.pathname}${url.search}${url.hash}` };
}

/**
 * What this page load returned from, if a completed checkout. The markers are
 * removed at once, keeping the router's history entry, so a reload or a
 * shared link never replays them.
 */
export function consumeCheckoutReturn(): CheckoutReturn | null {
  if (typeof window === "undefined") return null;
  const result = stripCheckoutReturn(window.location.href);
  if (result === null) return null;
  window.history.replaceState(window.history.state, "", result.strippedUrl);
  return result.checkout;
}
