import { createFileRoute, notFound } from "@tanstack/react-router";
import { resolveSessionGate } from "@/modules/identity/client/auth-gate";
import { DeadEnd } from "@/app/shell/dead-end";
import { SITE_NAME, createPageHead } from "@/lib/seo";
import { invitePreviewQueryOptions } from "@/app/query-client/queries/spaces";
import { lazy } from "react";

/**
 * Unlike `/$code`, `/join/*` is not a catch-all: nothing but an invite link
 * ever produces this URL. A malformed token gets this invite-specific page
 * rather than the root 404, because the most common way to break an invite is
 * a link truncated by the chat app that carried it.
 */
function InviteNotFound() {
  return (
    <DeadEnd
      eyebrow="Invitation"
      title="That invite link isn’t complete"
      body="Invite links can get cut short when they’re pasted into a chat. Ask whoever invited you to send the whole link again, or to generate a fresh one."
      documentTitle={`Invite link not valid — ${SITE_NAME}`}
    />
  );
}

const InviteRoute = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/invite/invite-page").then((page) => ({ default: page.InviteRoute })));
const InviteError = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/invite/invite-page").then((page) => ({ default: page.InviteError })));

export const Route = createFileRoute("/join/$token")({
  params: {
    parse: ({ token }) => {
      // Invite codes are exactly 8 letters (A-Z, a-z) — see generateInviteCode.
      if (!/^[a-zA-Z]{8}$/.test(token)) {
        throw notFound();
      }
      return { token };
    },
    stringify: ({ token }) => ({ token }),
  },
  notFoundComponent: InviteNotFound,
  preload: false,
  ssr: "data-only",
  beforeLoad: async ({ context, location }) => {
    return resolveSessionGate(context, location);
  },
  // Query-own the preview so selective SSR/fallback rendering can dehydrate it.
  // Normal production documents use the SPA shell, where this loader runs in
  // the browser after the session gate; do not rely on it for an HTTP-level 404.
  loader: ({ context, params }) =>
    context.queryClient.fetchQuery(invitePreviewQueryOptions(params.token)),
  head: () =>
    createPageHead({
      title: "Space Invitation — Orb Meet",
      description: "Review an invitation to join an Orb Meet Space.",
      noindex: true,
      canonical: false,
    }),
  component: InviteRoute,
  errorComponent: InviteError,
});
