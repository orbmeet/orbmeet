import { createFileRoute } from "@tanstack/react-router";
import { buildAiDiscoveryDocument } from "@/lib/seo";

export const Route = createFileRoute("/api/llms.json")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(buildAiDiscoveryDocument(), {
          headers: {
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
