import { isRecord } from "@orbmeet/primitives";
import type { CheckoutRequest, PortalRequest } from "../contract/requests";

function responseUrl(value: unknown): string | null {
  return isRecord(value) && typeof value.url === "string" ? value.url : null;
}

/**
 * Send the browser to Polar's hosted checkout: Pro for the signed-in person,
 * or the Organization plan for an Organization they own. It returns to
 * Settings, where BillingCheckoutSync waits for the subscription to land. A
 * customer who already has a running subscription is sent to the portal.
 */
export async function startSubscriptionCheckout(request: CheckoutRequest): Promise<void> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 409 && isRecord(body) && body.error === "SUBSCRIPTION_EXISTS") {
      await openBillingPortal(request.plan === "organization" ? { organizationId: request.organizationId } : {});
      return;
    }
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Could not start checkout");
  }
  const url = responseUrl(await response.json());
  if (!url) throw new Error("Checkout response was missing a URL");
  window.location.assign(url);
}

/** Open Polar's billing portal for the signed-in person, or an Organization they own. */
export async function openBillingPortal(request: PortalRequest = {}): Promise<void> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await response.text());
  const url = responseUrl(await response.json());
  if (!url) throw new Error("Billing portal response was missing a URL");
  window.location.assign(url);
}
