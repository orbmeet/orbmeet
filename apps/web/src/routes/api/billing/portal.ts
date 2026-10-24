import { createFileRoute } from "@tanstack/react-router";
import { createDb } from "@orbmeet/db";
import {
  enforceIpRateLimit,
  enforceRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { createPortalSession } from "@/modules/billing/server/paddle";

export const Route = createFileRoute("/api/billing/portal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = await getOptionalEnv();
        if (!env?.PADDLE_API_KEY) return new Response("Service unavailable", { status: 503 });

        try {
          await enforceIpRateLimit(env, "billing-portal");
        } catch (error) {
          return rateLimitErrorResponse(error, "billing-portal-pre-auth");
        }
        const session = await verifySessionFromRawRequest(request, env);
        if (!session) return new Response("Unauthorized", { status: 401 });
        try {
          await enforceRateLimit(env, `billing:portal:${session.userId}`, true);
        } catch (error) {
          return rateLimitErrorResponse(error, "billing-portal-user");
        }

        const db = createDb(env.DB);
        const user = await db.query.users.findFirst({
          where: { id: session.userId },
          columns: { paddleCustomerId: true },
        });

        if (!user?.paddleCustomerId) {
          return new Response("No billing account found", { status: 404 });
        }

        const returnUrl = `${env.APP_URL}/settings?tab=${encodeURIComponent("plan-&-billing")}`;
        const portalUrl = await createPortalSession(env.PADDLE_API_KEY, user.paddleCustomerId, returnUrl);

        return Response.json({ url: portalUrl });
      },
    },
  },
});
