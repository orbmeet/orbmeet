import type { PaidSubscriptionTier } from "../contract/types";
import { openPaddleCheckout } from "./paddle-checkout";
import { isRecord } from "@orbmeet/primitives";

interface CheckoutResponse {
  transactionId: string;
}

interface PortalResponse {
  url: string;
}

function isCheckoutResponse(value: unknown): value is CheckoutResponse {
  return (
    isRecord(value)
    && typeof value.transactionId === "string"
  );
}

function isPortalResponse(value: unknown): value is PortalResponse {
  return isRecord(value) && typeof value.url === "string";
}

export async function startSubscriptionCheckout(
  plan: PaidSubscriptionTier,
): Promise<void> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (
      response.status === 409 &&
      isRecord(body) &&
      body.error === "SUBSCRIPTION_EXISTS"
    ) {
      await openBillingPortal();
      return;
    }
    if (
      response.status === 409 &&
      isRecord(body) &&
      body.error === "CHECKOUT_PENDING"
    ) {
      throw new Error("Your checkout is still being processed. Please try again in a moment.");
    }
    throw new Error(
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : "Could not start checkout",
    );
  }

  const checkout: unknown = await response.json();
  if (!isCheckoutResponse(checkout)) {
    throw new Error("Checkout response was missing required Paddle fields");
  }
  await openPaddleCheckout(checkout);
}

export async function openBillingPortal(): Promise<void> {
  const response = await fetch("/api/billing/portal", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());

  const portal: unknown = await response.json();
  if (!isPortalResponse(portal)) {
    throw new Error("Billing portal response was missing a URL");
  }
  window.location.href = portal.url;
}
