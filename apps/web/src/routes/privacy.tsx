import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildWebPageGraph } from "@/lib/seo";
import { PrivacyPage } from "@/pages/legal/privacy-page";

export const Route = createFileRoute("/privacy")({
  head: () =>
    createPageHead({
      title: "Privacy Policy — Orb Meet",
      description:
        "Read the Orb Meet privacy policy to understand how we collect, use, and protect account, Meeting, Whiteboard, and Space data.",
      path: "/privacy",
      scripts: [
        createJsonLdScript(
          buildWebPageGraph({
            title: "Privacy Policy — Orb Meet",
            description:
              "Read the Orb Meet privacy policy to understand how we collect, use, and protect account, Meeting, Whiteboard, and Space data.",
            path: "/privacy",
          }),
        ),
      ],
    }),
  component: PrivacyPage,
});
