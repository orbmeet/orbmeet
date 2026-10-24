import { createFileRoute, notFound, rootRouteId } from "@tanstack/react-router";
import * as React from "react";
import { AppPending } from "@/app/shell/app-pending";
import { DeadEnd } from "@/app/shell/dead-end";
import { markMeetingEntryMetric } from "@/modules/meetings/client/entry-metrics";
import { isMeetingCode } from "@/modules/meetings/contract/meeting-path";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import {lookupMeeting} from "@/modules/meetings/server/history/meeting-lookup.functions";
import { SITE_NAME, createPageHead } from "@/lib/seo";
import { MeetingCodeRetryForm } from "@/modules/meetings/client/components/meeting-code-retry-form";
import { lazy } from "react";

function MeetingNotFoundComponent() {
  return (
    <DeadEnd
      eyebrow="Meeting"
      title="No meeting found"
      body="The code you entered doesn’t match any active meeting. Double-check the link, or ask the host to share a fresh one."
      documentTitle={`No meeting found — ${SITE_NAME}`}
    >
      <MeetingCodeRetryForm />
    </DeadEnd>
  );
}

function MeetingPendingComponent() {
  React.useEffect(() => {
    markMeetingEntryMetric("routeMountedAt");
  }, []);

  return <AppPending />;
}

const MeetingRoute = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/meeting/meeting-page").then((page) => ({ default: page.MeetingRoute })));

export const Route = createFileRoute("/$code")({
  params: {
    parse: ({ code }) => {
      // This is the app's catch-all, so anything shaped wrong is an unknown
      // URL rather than a dead meeting — `/pricingg` must not be told that no
      // meeting matches it. The root 404 owns that case and names the meeting
      // code format, since a badly mistyped code is the likeliest way here.
      if (!isMeetingCode(code)) {
        throw notFound({ routeId: rootRouteId });
      }
      return { code };
    },
    stringify: ({ code }) => ({ code }),
  },
  pendingMs: 0,
  pendingMinMs: 0,
  ssr: 'data-only',
  // Deliberately not preloaded. Admission state (`hasOpenMeeting`,
  // `canStartMeeting`, `paused`) has to be read at the moment of entry, so this
  // loader calls `lookupMeeting` directly rather than through Query — and with
  // `defaultPreloadStaleTime: 0` an intent-preload would then fire a live room
  // lookup on every hover. Every link here also sets `reloadDocument` (which
  // makes Link force `preload: false`), but that is incidental; this is the
  // guarantee. `app/boundaries/route-loaders-boundary.test.ts` enforces the pairing.
  preload: false,
  loader: async ({ context, params }) => {
    // Resolve the public Meeting lookup and prefill the session in parallel.
    // The session prefetch is awaited so selective SSR and client navigations
    // finish any cookie rotation before continuing. Production document loads
    // use the SPA shell, so this loader then runs on the client and the cookie
    // arrives with the server-function response. prefetchQuery intentionally
    // swallows failures so guests can still join from the public lookup alone.
    const [lookup] = await Promise.all([
      lookupMeeting({ data: { code: params.code } }),
      context.queryClient.prefetchQuery(sessionQueryOptions()),
    ]);
    if (!lookup.exists) {
      throw notFound();
    }
    return { lookup };
  },
  pendingComponent: MeetingPendingComponent,
  notFoundComponent: MeetingNotFoundComponent,
  head: () =>
    createPageHead({
      title: "Join Meeting — Orb Meet",
      description: "Join a live Orb Meet meeting using a meeting code.",
      noindex: true,
      canonical: false,
    }),
  component: MeetingRoute,
});
