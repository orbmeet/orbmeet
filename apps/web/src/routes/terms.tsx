import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildWebPageGraph } from "@/lib/seo";
import { TermsPage } from "@/pages/legal/terms-page";

export const Route = createFileRoute("/terms")({
  head: () =>
    createPageHead({
      title: "Terms of Service — Orb Meet",
      description:
        "Read the Orb Meet terms of service governing use of Meetings, Whiteboards, Spaces, and accounts.",
      path: "/terms",
      scripts: [
        createJsonLdScript(
          buildWebPageGraph({
            title: "Terms of Service — Orb Meet",
            description:
              "Read the Orb Meet terms of service governing use of Meetings, Whiteboards, Spaces, and accounts.",
            path: "/terms",
          }),
        ),
      ],
    }),
  component: TermsPage,
});
