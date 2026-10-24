import { createFileRoute } from "@tanstack/react-router";

import { apiJson, handleAutomationApi } from "@/app/adapters/public-api/http";

export const Route = createFileRoute("/api/v1/me")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, null, async ({ principal }) =>
          apiJson({
            data: {
              user: {
                name: principal.user.name,
                email: principal.user.email,
                plan: principal.user.plan,
                timeZone: principal.user.timeZone,
              },
              tokenId: principal.tokenId,
              scopes: principal.scopes,
              serverTime: new Date().toISOString(),
            },
          })),
    },
  },
});
