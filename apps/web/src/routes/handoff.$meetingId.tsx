import { createFileRoute, notFound, rootRouteId } from "@tanstack/react-router";
import { MEETING_CODE_REGEX } from "@/modules/meetings/contract/constants";
import { optionalString } from "@/lib/search-params";
import { createPageHead } from "@/lib/seo";
import { RoutePending } from "@/app/shell/route-state";
import { lazy } from "react";

const PublicMeetingSummaryPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/meeting-summary/public-meeting-summary-page").then((page) => ({ default: page.PublicMeetingSummaryPage })));

export const Route = createFileRoute("/handoff/$meetingId")({
  params: {
    parse: ({ meetingId }) => {
      if (!meetingId) {
        throw notFound({ routeId: rootRouteId });
      }
      return { meetingId };
    },
    stringify: ({ meetingId }) => ({ meetingId }),
  },
  validateSearch: (raw): { admissionId?: string; code?: string } => {
    const code = optionalString(raw?.code);
    return {
      admissionId: optionalString(raw?.admissionId),
      // The room just left, for Rejoin. Only ever a code: it becomes a link.
      code: code && MEETING_CODE_REGEX.test(code) ? code : undefined,
    };
  },
  ssr: false,
  head: () =>
    createPageHead({
      title: "Meeting Summary — Orb Meet",
      description: "View the summary for a finished Orb Meet Meeting.",
      noindex: true,
      canonical: false,
    }),
  pendingComponent: RoutePending,
  component: PublicMeetingSummaryPage,
});
