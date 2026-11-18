import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildPricingGraph } from "@/lib/seo";
import { PricingPage } from "@/pages/pricing/pricing-page";
import { planPricesQueryOptions } from "@/app/query-client/queries/plan-prices";

export const Route = createFileRoute("/pricing")({
  // Render the visitor's own prices on the server rather than flashing USD
  // first. Never fails: the server falls back to the default prices.
  loader: ({ context }) => context.queryClient.fetchQuery(planPricesQueryOptions()),
  head: () =>
    createPageHead({
      title: "Pricing — Orb Meet",
      description:
        "Simple, transparent pricing for Meetings, personal meeting links, Spaces, and Organization billing.",
      path: "/pricing",
      scripts: [createJsonLdScript(buildPricingGraph())],
    }),
  component: PricingPage,
});
