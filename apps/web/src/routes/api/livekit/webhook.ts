import { createFileRoute } from "@tanstack/react-router";
import { handleLivekitWebhookRequest } from "./-webhook.server";

/**
 * LiveKit webhook receiver. Each event is forwarded to its meeting's
 * coordinator as a hint to look at the room sooner.
 *
 * LiveKit sends webhooks with an Authorization header containing a signed JWT.
 * Configure the webhook URL in your LiveKit project/server settings:
 *   https://your-app.com/api/livekit/webhook
 */
export const Route = createFileRoute("/api/livekit/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handleLivekitWebhookRequest(request),
    },
  },
});
