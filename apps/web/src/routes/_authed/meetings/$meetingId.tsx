import { createFileRoute, notFound } from "@tanstack/react-router";
import { endedMeetingQueryOptions } from "@/app/query-client/queries/meeting-summary";
import { createPageHead } from "@/lib/seo";
import { meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { optionalString } from "@/lib/search-params";
import { RoutePending } from "@/app/shell/route-state";
import { lazy } from "react";

type MeetingView = "pdf" | "recording" | "transcript";

const EndedMeetingPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/meeting-summary/components/ended-meeting-page").then((page) => ({ default: page.EndedMeetingPage })));

export const Route = createFileRoute("/_authed/meetings/$meetingId")({
  validateSearch: (search: Record<string, unknown>): { fromSpace?: string; view?: MeetingView } => ({
    fromSpace: optionalString(search.fromSpace),
    view: search.view === "pdf" || search.view === "recording" || search.view === "transcript" ? search.view : undefined,
  }),
  loader: async ({ context, params }) => {
    if (!params.meetingId.trim()) throw notFound();
    const result = await context.queryClient.fetchQuery(
      endedMeetingQueryOptions(params.meetingId),
    );
    if (!result.meeting) throw notFound();
    return {
      meeting: result.meeting,
      pageTitle: meetingDisplayTitle(
        result.meeting.title,
        result.meeting.participantNames,
        context.session?.user.name ?? undefined,
      ),
    };
  },
  head: ({ loaderData }) => createPageHead({
    title: `${loaderData?.pageTitle ?? "Meeting"} — Orb Meet`,
    description: "View this meeting and its available outputs.",
    noindex: true,
    canonical: false,
  }),
  pendingComponent: RoutePending,
  component: HistoricalMeetingPage,
});

function HistoricalMeetingPage() {
  const { meetingId } = Route.useParams();
  const { fromSpace, view } = Route.useSearch();
  return <EndedMeetingPage meetingId={meetingId} backSpaceSlug={fromSpace} view={view} />;
}
