import { createFileRoute } from "@tanstack/react-router";
import { handleGoogleCallbackRequest } from "@/modules/identity/server/oauth-google-callback.server";
import { logError } from "@/lib/logger";
import { resolveAuthRedirect } from "@/modules/identity/contract/safe-redirect";

export const Route = createFileRoute("/api/auth/callback/google")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Exchange the authorization code server-side to avoid
        // leaking it in browser history and Referer headers
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          return new Response(null, {
            status: 302,
            headers: { Location: `/auth?error=${encodeURIComponent(error)}` },
          });
        }

        if (code && state) {
          try {
            const result = await handleGoogleCallbackRequest(request, { code, state });
            // Set-Cookie headers written by appendCookies() onto the H3 event
            // response headers are automatically merged into this redirect
            // response by TanStack Start's mergeEventResponseHeaders for
            // non-2xx responses. Do NOT copy them manually here — that would
            // produce duplicate Set-Cookie headers.
            // A deletion-gated account was handed the recovery session, not a
            // login; its redirect targets the recovery page, which is
            // deliberately outside the user-controlled redirect allowlist.
            const destination = result.deletionPending
              ? result.redirectTo
              : resolveAuthRedirect(result.redirectTo);
            return new Response(null, {
              status: 302,
              headers: { Location: destination },
            });
          } catch (err) {
              logError("[OAuth Callback Error]", err);
            // Map known error types to user-safe codes, never expose raw error messages
            let errorCode = "auth_failed";
            if (err && typeof err === "object" && "code" in err) {
              const code = (err as { code: string }).code;
              if (code === "ACCOUNT_LINK_REQUIRED") errorCode = "account_link_required";
              else if (code === "RATE_LIMITED") errorCode = "rate_limited";
              else if (code === "OAUTH_ERROR") errorCode = "oauth_error";
            } else if (err instanceof Error) {
              const msg = err.message;
              if (
                msg.includes("OAuth") ||
                msg.includes("token") ||
                msg.includes("email verified")
              ) {
                errorCode = "oauth_error";
              }
            }
            return new Response(null, {
              status: 302,
              headers: { Location: `/auth?error=${encodeURIComponent(errorCode)}` },
            });
          }
        }

        return new Response(null, {
          status: 302,
          headers: { Location: "/auth" },
        });
      },
    },
  },
});
