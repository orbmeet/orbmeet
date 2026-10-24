import { createFileRoute } from "@tanstack/react-router";
import {
  SITE_NAME,
  createJsonLdScript,
  createPageHead,
  buildWebPageGraph,
} from "@/lib/seo";
import { PRODUCT_DESCRIPTION } from "@/lib/product-copy";
import { LandingPage } from "@/pages/landing/landing-page";

export const Route = createFileRoute("/")({
  head: () => {
    const description = PRODUCT_DESCRIPTION;

    return createPageHead({
      title: `${SITE_NAME} — Meet. Write together. Keep the work.`,
      description,
      path: "/",
      scripts: [
        createJsonLdScript(
          buildWebPageGraph({
            title: `${SITE_NAME} — Meet. Write together. Keep the work.`,
            description,
            path: "/",
          }),
        ),
      ],
      extraMeta: [
        {
          name: "keywords",
          content:
            "visual meeting workspace, collaborative whiteboard, video meetings, online teaching, open source meeting platform",
        },
      ],
    });
  },
  component: LandingPage,
});
