import { createFileRoute } from "@tanstack/react-router";
import { linkGoogleAccountFromCallback } from "@/modules/identity/server/oauth-google-link-callback.server";
import { logError } from "@/lib/logger";

export const Route = createFileRoute("/api/auth/callback/google-link")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          return new Response(null, {
            status: 302,
            headers: { Location: `/settings?linked=error&reason=${encodeURIComponent(error)}` },
          });
        }

        if (code && state) {
          try {
            await linkGoogleAccountFromCallback(request, { code, state });
            // Set-Cookie headers written by appendCookies() onto the H3 event
            // response headers are automatically merged into non-2xx responses
            // by TanStack Start. Do NOT copy them manually here.
            return new Response(null, {
              status: 302,
              headers: { Location: "/settings?linked=google" },
            });
          } catch (err) {
            logError("[OAuth Link Callback Error]", err);
            let errorReason = "link_failed";
            if (err && typeof err === "object" && "message" in err) {
              const msg = (err as { message: string }).message;
              if (msg.includes("email must match")) errorReason = "email_mismatch";
              else if (msg.includes("already linked to another")) errorReason = "already_linked_other";
            }
            if (err && typeof err === "object" && "code" in err) {
              const code = (err as { code: string }).code;
              if (code === "RATE_LIMITED") errorReason = "rate_limited";
              else if (code === "OAUTH_ERROR") errorReason = "oauth_error";
            }
            return new Response(null, {
              status: 302,
              headers: { Location: `/settings?tab=linked-accounts&linked=error&reason=${encodeURIComponent(errorReason)}` },
            });
          }
        }

        return new Response(null, {
          status: 302,
          headers: { Location: "/settings?tab=linked-accounts" },
        });
      },
    },
  },
});
