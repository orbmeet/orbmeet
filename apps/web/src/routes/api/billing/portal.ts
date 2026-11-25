import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";
import { billingCustomerFor, portalRequestSchema } from "@/modules/billing/contract/requests";
import {
  enforceIpRateLimit,
  enforceRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { createDb } from "@orbmeet/db";
import { openBillingPortal } from "@/modules/billing/server/checkout.server";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { polarClientFromEnv } from "@/modules/billing/server/polar";

const MAX_PORTAL_BODY_BYTES = 1_024;

export const Route = createFileRoute("/api/billing/portal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = await getOptionalEnv();
        // Billing is on only when the code that calls Polar can build a client:
        // the same check, so a blank token or a mistyped POLAR_SERVER is a 503
        // here, not a failure further in.
        if (!env || !polarClientFromEnv(env)) return new Response("Service unavailable", { status: 503 });

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

        let body: unknown;
        try {
          const text = await readRequestBodyText(request, MAX_PORTAL_BODY_BYTES);
          body = text ? JSON.parse(text) : {};
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            return new Response("Request body too large", { status: 413 });
          }
          return new Response("Invalid JSON", { status: 400 });
        }
        const parsed = v.safeParse(portalRequestSchema, body);
        if (!parsed.success) return new Response("Invalid request", { status: 400 });

        const portal = await openBillingPortal(createDb(env.DB), env, {
          customer: billingCustomerFor(parsed.output, session.userId),
          actorUserId: session.userId,
        });
        switch (portal.kind) {
          case "forbidden":
            return new Response("Only the Organization's owner manages its billing", { status: 403 });
          case "no_billing_account":
            return new Response("No billing account found", { status: 404 });
          case "portal":
            return Response.json({ url: portal.url });
        }
      },
    },
  },
});
