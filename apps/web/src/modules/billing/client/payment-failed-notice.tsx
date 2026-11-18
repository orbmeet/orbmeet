import { Alert } from "@orbmeet/ui/react";
import type { SubscriptionStatus } from "../contract/types";

/**
 * Whether a renewal charge failed and Polar is retrying it (`past_due`). The
 * plan stays on meanwhile; it ends if the retries run out.
 */
export function isPaymentFailing(status: SubscriptionStatus | undefined): boolean {
  return status === "past_due";
}

/**
 * Tells the customer their last renewal failed and what to do, while there is
 * still time: Polar retries for about three weeks, then ends the plan.
 * Renders nothing unless a payment is failing.
 */
export function PaymentFailedNotice({
  status,
  customer,
  canUpdate,
}: {
  status: SubscriptionStatus | undefined;
  /** Whose plan: the person's own Pro, or an Organization's. */
  customer: "pro" | "organization";
  /** Whether the viewer manages this billing and can update the card. */
  canUpdate: boolean;
}) {
  if (!isPaymentFailing(status)) return null;
  const plan = customer === "pro" ? "Pro" : "the Organization plan";
  return (
    <Alert
      variant="warning"
      title={customer === "pro" ? "Your last payment failed" : "The Organization's last payment failed"}
    >
      {canUpdate
        ? `Update the payment method in the billing portal to keep ${plan}. The charge is retried automatically for about three weeks; if it still can't be collected, ${plan} ends.`
        : `The Organization's owner needs to update its payment method in the billing portal. If the charge can't be collected within about three weeks, the Organization plan ends.`}
    </Alert>
  );
}
