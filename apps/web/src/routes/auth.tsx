import { createFileRoute } from "@tanstack/react-router";
import { sanitizeInternalRedirect } from "@/modules/identity/contract/safe-redirect";
import { oneOf, optionalString } from "@/lib/search-params";
import { createPageHead } from "@/lib/seo";
import { lazy } from "react";

const AuthPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/auth/auth-page").then((page) => ({ default: page.AuthPage })));

export const Route = createFileRoute("/auth")({
  validateSearch: (raw): { mode?: "login" | "signup"; redirect?: string; error?: string } => ({
    mode: oneOf(raw?.mode, ["login", "signup"] as const),
    redirect: sanitizeInternalRedirect(raw?.redirect),
    error: optionalString(raw?.error),
  }),
  ssr: false,
  head: () =>
    createPageHead({
      title: "Sign In — Orb Meet",
      description: "Sign in to Orb Meet to create Meetings, manage Spaces, and access account settings.",
      noindex: true,
      canonical: false,
    }),
  component: AuthPage,
});
