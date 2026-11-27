import { createFileRoute } from "@tanstack/react-router";
import { billingCustomerFor, checkoutRequestSchema } from "@/modules/billing/contract/requests";
import { authenticateBillingPostRequest } from "@/app/adapters/billing-route.server";
import { polarProductIdForPlan } from "@/modules/billing/server/polar-config";
import { runSerially } from "@/app/serial/serial";

const MAX_CHECKOUT_BODY_BYTES = 1_024;

export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateBillingPostRequest(request, {
          action: "checkout",
          schema: checkoutRequestSchema,
          maxBodyBytes: MAX_CHECKOUT_BODY_BYTES,
        });
        if (!auth.ok) return auth.response;

        const { env, userId, body } = auth;
        if (!polarProductIdForPlan(env, body.plan)) {
          return new Response("Plan pricing not configured", { status: 503 });
        }

        const checkout = await runSerially(env, {
          kind: "prepareCheckout",
          customer: billingCustomerFor(body, userId),
          actorUserId: userId,
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
