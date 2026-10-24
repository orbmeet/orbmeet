import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildWebPageGraph } from "@/lib/seo";
import { RefundPage } from "@/pages/legal/refund-page";

export const Route = createFileRoute("/refund")({
  head: () =>
    createPageHead({
      title: "Refund Policy — Orb Meet",
      description:
        "Read the Orb Meet refund policy to understand cancellations, refunds, and subscription billing for paid plans.",
      path: "/refund",
      scripts: [
        createJsonLdScript(
          buildWebPageGraph({
            title: "Refund Policy — Orb Meet",
            description:
              "Read the Orb Meet refund policy to understand cancellations, refunds, and subscription billing for paid plans.",
            path: "/refund",
          }),
        ),
      ],
    }),
  component: RefundPage,
});
