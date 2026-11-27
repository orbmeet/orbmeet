import { createFileRoute } from "@tanstack/react-router";
import { createDb } from "@orbmeet/db";
import { billingCustomerFor, portalRequestSchema } from "@/modules/billing/contract/requests";
import { authenticateBillingPostRequest } from "@/app/adapters/billing-route.server";
import { openBillingPortal } from "@/modules/billing/server/checkout.server";

const MAX_PORTAL_BODY_BYTES = 1_024;

export const Route = createFileRoute("/api/billing/portal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateBillingPostRequest(request, {
          action: "portal",
          schema: portalRequestSchema,
          maxBodyBytes: MAX_PORTAL_BODY_BYTES,
          allowEmptyBody: true,
        });
        if (!auth.ok) return auth.response;

        const { env, userId, body } = auth;
        const portal = await openBillingPortal(createDb(env.DB), env, {
          customer: billingCustomerFor(body, userId),
          actorUserId: userId,
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
