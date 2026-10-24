import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildPricingGraph } from "@/lib/seo";
import { PricingPage } from "@/pages/pricing/pricing-page";

export const Route = createFileRoute("/pricing")({
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
