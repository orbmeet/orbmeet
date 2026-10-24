import { createFileRoute } from "@tanstack/react-router";
import { createPageHead } from "@/lib/seo";
import { lazy } from "react";

const DeletionPendingPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/account/deletion-pending-page").then((page) => ({ default: page.DeletionPendingPage })));

export const Route = createFileRoute("/account/deletion-pending")({
  // The recovery session must never render the signed-in app shell or leak
  // into user-scoped queries, and the page is reachable only with the
  // deletion-resume cookie, so there is nothing to server-render.
  ssr: false,
  head: () =>
    createPageHead({
      title: "Account Deletion Pending — Orb Meet",
      description:
        "Your Orb Meet account deletion has started and cannot be undone. Finish the deletion or leave the account as it is.",
      noindex: true,
      canonical: false,
    }),
  component: DeletionPendingPage,
});
