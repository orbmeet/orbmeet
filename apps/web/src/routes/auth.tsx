import { createFileRoute, redirect, lazyRouteComponent } from "@tanstack/react-router";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { resolveAuthRedirect, sanitizeInternalRedirect } from "@/modules/identity/contract/safe-redirect";
import { oneOf, optionalString } from "@/lib/search-params";
import { createPageHead } from "@/lib/seo";

const AuthPage = import.meta.env.SSR ? () => null : lazyRouteComponent(() => import("@/pages/auth/auth-page"), "AuthPage");

export const Route = createFileRoute("/auth")({
  validateSearch: (raw): { mode?: "login" | "signup"; redirect?: string; error?: string } => ({
    mode: oneOf(raw?.mode, ["login", "signup"] as const),
    redirect: sanitizeInternalRedirect(raw?.redirect),
    error: optionalString(raw?.error),
  }),
  ssr: false,
  // Already signed in: there is nothing to do here but go where this was heading.
  beforeLoad: async ({ context, search }) => {
    if (search.error) return;
    const session = await context.queryClient
      .fetchQuery({ ...sessionQueryOptions(), networkMode: "always" })
      .catch(() => null);
    if (session) throw redirect({ href: resolveAuthRedirect(search.redirect), replace: true });
  },
  head: () =>
    createPageHead({
      title: "Sign In — Orb Meet",
      description: "Sign in to Orb Meet to create Meetings, manage Spaces, and access account settings.",
      noindex: true,
      canonical: false,
    }),
  component: AuthPage,
  codeSplitGroupings: [["errorComponent"], ["notFoundComponent"]],
});
