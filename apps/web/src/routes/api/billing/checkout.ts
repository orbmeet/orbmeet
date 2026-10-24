import { createFileRoute } from "@tanstack/react-router";
import { PAID_SUBSCRIPTION_TIERS } from "@/modules/billing/contract/types";
import * as v from "valibot";
import {
  enforceIpRateLimit,
  enforceRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import { runSerially } from "@/app/serial/serial";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";

const MAX_CHECKOUT_BODY_BYTES = 1_024;

const bodySchema = v.object({
  plan: v.picklist(PAID_SUBSCRIPTION_TIERS),
});

export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = await getOptionalEnv();
        if (!env?.PADDLE_API_KEY) return new Response("Service unavailable", { status: 503 });

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

        const parsed = v.safeParse(bodySchema, body);
        if (!parsed.success) return new Response("Invalid request", { status: 400 });

        const priceId = configuredPaddlePriceId(
          parsed.output.plan === "pro" ? env.PADDLE_PRICE_ID_PRO : env.PADDLE_PRICE_ID_ORG_SEAT,
        );
        if (!priceId) return new Response("Plan pricing not configured", { status: 503 });

        const checkout = await runSerially(env, {
          kind: "preparePaddleCheckout",
          userId: session.userId,
          plan: parsed.output.plan,
        }, { callerWaits: true });
        switch (checkout.kind) {
          case "not_found":
            return new Response("Not found", { status: 404 });
          case "subscription_exists":
            return Response.json({ error: "SUBSCRIPTION_EXISTS" }, { status: 409 });
          case "pending":
            return Response.json(
              { error: "CHECKOUT_PENDING" },
              { status: 409, headers: { "Retry-After": "5" } },
            );
          case "transaction":
            return Response.json({ transactionId: checkout.transactionId });
        }
      },
    },
  },
});
