import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SubscriptionStatus } from "@/modules/billing/contract/types";
import { PaymentFailedNotice } from "@/modules/billing/client/payment-failed-notice";
import { PlanSection } from "./plan-section";

function planMarkup(subscriptionStatus: SubscriptionStatus): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlanSection plan="pro" subscriptionStatus={subscriptionStatus} hasManagedSubscription />
    </QueryClientProvider>,
  );
}

/**
 * A failed renewal keeps the plan on while Polar retries for about three
 * weeks, then ends it. The customer has to hear about it here, with the one
 * thing that fixes it, before that happens.
 */
describe("a failed renewal", () => {
  it("is explained, and the billing button becomes the fix", () => {
    const html = planMarkup("past_due");
    expect(html).toContain("Your last payment failed");
    expect(html).toContain("Update the payment method in the billing portal to keep Pro");
    expect(html).toContain("Update payment method");
    expect(html).not.toContain("Manage billing");
  });

  it("says nothing while payments go through", () => {
    const html = planMarkup("active");
    expect(html).not.toContain("payment failed");
    expect(html).toContain("Manage billing");
  });

  it("tells an Organization member who can fix it", () => {
    const html = renderToStaticMarkup(
      <PaymentFailedNotice status="past_due" customer="organization" canUpdate={false} />,
    );
    expect(html).toContain("The Organization&#x27;s last payment failed");
    expect(html).toContain("owner needs to update its payment method");
  });

  it.each(["active", "trialing", "canceled", null] as const)("shows nothing for %s", (status) => {
    expect(renderToStaticMarkup(
      <PaymentFailedNotice status={status} customer="pro" canUpdate />,
    )).toBe("");
  });
});
