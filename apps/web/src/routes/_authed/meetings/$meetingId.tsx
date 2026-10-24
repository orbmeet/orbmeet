import { createFileRoute, notFound } from "@tanstack/react-router";
import { endedMeetingQueryOptions } from "@/app/query-client/queries/meeting-summary";
import { createPageHead } from "@/lib/seo";
import { optionalString } from "@/lib/search-params";
import { RoutePending } from "@/app/shell/route-state";
import { lazy } from "react";

const EndedMeetingPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/meeting-summary/components/ended-meeting-page").then((page) => ({ default: page.EndedMeetingPage })));

export const Route = createFileRoute("/_authed/meetings/$meetingId")({
  validateSearch: (search: Record<string, unknown>): { fromSpace?: string } => ({
    fromSpace: optionalString(search.fromSpace),
  }),
  loader: async ({ context, params }) => {
    if (!params.meetingId.trim()) throw notFound();
    const result = await context.queryClient.fetchQuery(
      endedMeetingQueryOptions(params.meetingId),
    );
    if (!result.meeting) throw notFound();
    return { meeting: result.meeting };
  },
  head: ({ loaderData }) => createPageHead({
    title: `${loaderData?.meeting.title ?? "Meeting"} — Orb Meet`,
    description: "View this meeting and its available outputs.",
    noindex: true,
    canonical: false,
  }),
  pendingComponent: RoutePending,
  component: HistoricalMeetingPage,
});

function HistoricalMeetingPage() {
  const { meetingId } = Route.useParams();
  const { fromSpace } = Route.useSearch();
  return <EndedMeetingPage meetingId={meetingId} backSpaceSlug={fromSpace} />;
}
