import { parseInput } from "@/lib/validation";
import { createFileRoute } from "@tanstack/react-router";
import { searchAutomationTargetsSchema } from "@orbmeet/public-api-contract";

import { searchAutomationTargets } from "@/modules/contacts/server/contact-index";
import { apiJson, handleAutomationApi } from "@/app/adapters/public-api/http";

export const Route = createFileRoute("/api/v1/targets")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, "meetings:read", async ({ principal }) => {
          const url = new URL(request.url);
          const parsed = parseInput(searchAutomationTargetsSchema, {
            query: url.searchParams.get("q") ?? "",
            limit: url.searchParams.has("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          });
          return apiJson({
            data: await searchAutomationTargets(
              principal.db,
              principal.user.id,
              parsed.query,
              parsed.limit,
            ),
          });
        }),
    },
  },
});
