import { createFileRoute } from "@tanstack/react-router";
import { createJsonLdScript, createPageHead, buildWebPageGraph } from "@/lib/seo";
import { StatusPage } from "@/pages/status/status-page";

export const Route = createFileRoute("/status")({
  head: () =>
    createPageHead({
      title: "Service Status — Orb Meet",
      description:
        "Real-time status of Orb Meet infrastructure services, including Meetings, Whiteboards, and related systems.",
      path: "/status",
      scripts: [
        createJsonLdScript(
          buildWebPageGraph({
            title: "Service Status — Orb Meet",
            description:
              "Real-time status of Orb Meet infrastructure services, including Meetings, Whiteboards, and related systems.",
            path: "/status",
          }),
        ),
      ],
    }),
  component: StatusPage,
});
