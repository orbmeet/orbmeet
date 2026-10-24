import { createFileRoute, redirect } from "@tanstack/react-router";
import { sanitizeInternalRedirect } from "@/modules/identity/contract/safe-redirect";
import { optionalString } from "@/lib/search-params";
import { createPageHead } from "@/lib/seo";
import { lazy } from "react";

const VerifyPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/auth/verify-page").then((page) => ({ default: page.VerifyPage })));

export const Route = createFileRoute("/verify")({
  validateSearch: (raw): { flowId: string; redirect?: string } => ({
    flowId: optionalString(raw?.flowId) ?? "",
    redirect: sanitizeInternalRedirect(raw?.redirect),
  }),
  ssr: "data-only",
  beforeLoad: ({ search }) => {
    if (!/^[0-9a-f-]{36}$/i.test(search.flowId)) {
      throw redirect({ to: "/auth" });
    }
  },
  head: () =>
    createPageHead({
      title: "Verify Email — Orb Meet",
      description: "Verify your email address to continue signing in to Orb Meet.",
      noindex: true,
      canonical: false,
    }),
  component: VerifyPage,
});
