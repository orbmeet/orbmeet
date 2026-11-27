import * as v from "valibot";
import { createFileRoute } from "@tanstack/react-router";
import { publicApiMeResponseSchema } from "@orbmeet/public-api-contract";

import { apiJson, handleAutomationApi } from "@/app/adapters/public-api/http";

export const Route = createFileRoute("/api/v1/me")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, null, async ({ principal }) =>
          apiJson(
            v.parse(publicApiMeResponseSchema, {
              data: {
                user: {
                  name: principal.user.name,
                  email: principal.user.email,
                  plan: principal.user.plan,
                  timeZone: principal.user.timeZone,
                },
                scopes: principal.scopes,
                serverTime: new Date().toISOString(),
              },
            }),
          )),
    },
  },
});
