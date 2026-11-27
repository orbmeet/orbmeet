import * as v from "valibot";
import { parseInput } from "@/lib/validation";
import { createFileRoute } from "@tanstack/react-router";
import {
  publicApiTargetsResponseSchema,
  searchAutomationTargetsSchema,
} from "@orbmeet/public-api-contract";

import { searchAutomationTargets } from "@/modules/contacts/server/contact-index";
import { apiJson, handleAutomationApi } from "@/app/adapters/public-api/http";

export const Route = createFileRoute("/api/v1/targets")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, "meetings:read", async ({ principal }) => {
          const url = new URL(request.url);
          const rawLimit = url.searchParams.get("limit");
          const parsed = parseInput(searchAutomationTargetsSchema, {
            query: url.searchParams.get("q") ?? "",
            limit: rawLimit === null ? undefined : rawLimit === "" ? Number.NaN : Number(rawLimit),
          });
          return apiJson(
            v.parse(publicApiTargetsResponseSchema, {
              data: await searchAutomationTargets(
                principal.db,
                principal.user.id,
                parsed.query,
                parsed.limit,
              ),
            }),
          );
        }),
    },
  },
});
