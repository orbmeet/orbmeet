import { createFileRoute } from "@tanstack/react-router";
import { handlePaddleWebhookRequest } from "@/modules/billing/server/paddle-webhook.server";

/**
 * Paddle webhook receiver. Signature verification, dedup receipts, and the
 * subscription projection live in the billing module.
 */
export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handlePaddleWebhookRequest(request),
    },
  },
});
