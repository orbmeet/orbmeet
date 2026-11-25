import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";
import { billingCustomerFor, checkoutRequestSchema } from "@/modules/billing/contract/requests";
import {
  enforceIpRateLimit,
  enforceRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { polarProductIdForPlan } from "@/modules/billing/server/polar-config";
import { runSerially } from "@/app/serial/serial";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { polarClientFromEnv } from "@/modules/billing/server/polar";

const MAX_CHECKOUT_BODY_BYTES = 1_024;

export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = await getOptionalEnv();
        // Billing is on only when the code that calls Polar can build a client:
        // the same check, so a blank token or a mistyped POLAR_SERVER is a 503
        // here, not a failure further in.
        if (!env || !polarClientFromEnv(env)) return new Response("Service unavailable", { status: 503 });

        try {
          await enforceIpRateLimit(env, "billing-checkout");
        } catch (error) {
          return rateLimitErrorResponse(error, "billing-checkout-pre-auth");
        }
        const session = await verifySessionFromRawRequest(request, env);
        if (!session) return new Response("Unauthorized", { status: 401 });
        try {
          await enforceRateLimit(env, `billing:checkout:${session.userId}`, true);
        } catch (error) {
          return rateLimitErrorResponse(error, "billing-checkout-user");
        }

        let body: unknown;
        try {
          body = JSON.parse(await readRequestBodyText(request, MAX_CHECKOUT_BODY_BYTES));
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            return new Response("Request body too large", { status: 413 });
          }
          return new Response("Invalid JSON", { status: 400 });
        }

        const parsed = v.safeParse(checkoutRequestSchema, body);
        if (!parsed.success) return new Response("Invalid request", { status: 400 });
        if (!polarProductIdForPlan(env, parsed.output.plan)) {
          return new Response("Plan pricing not configured", { status: 503 });
        }

        const checkout = await runSerially(env, {
          kind: "prepareCheckout",
          customer: billingCustomerFor(parsed.output, session.userId),
          actorUserId: session.userId,
          customerIpAddress: request.headers.get("CF-Connecting-IP"),
        }, { callerWaits: true });
        switch (checkout.kind) {
          case "not_found":
            return new Response("Not found", { status: 404 });
          case "forbidden":
            return new Response("Only the Organization's owner manages its billing", { status: 403 });
          case "subscription_exists":
            return Response.json({ error: "SUBSCRIPTION_EXISTS" }, { status: 409 });
          case "email_taken":
            return Response.json(
              { error: "Your email is already attached to a different billing account. Contact support to have it linked." },
              { status: 409 },
            );
          case "checkout":
            return Response.json({ url: checkout.url });
        }
      },
    },
  },
});
