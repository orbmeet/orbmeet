import { createFileRoute } from "@tanstack/react-router";
import { handleBillingWebhookRequest } from "@/modules/billing/server/webhook.server";

/**
 * Polar webhook receiver. Signature verification, dedup receipts, and storing
 * the subscription live in the billing module.
 */
export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handleBillingWebhookRequest(request),
    },
  },
});
