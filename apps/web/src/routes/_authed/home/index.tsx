import { createFileRoute } from "@tanstack/react-router";
import {
  myMeetingsQueryOptions,
  myOpenFollowUpsQueryOptions,
  myThreadsQueryOptions,
  myUpcomingMeetingSchedulesQueryOptions,
} from "@/app/query-client/queries/meetings";
import { RouteError, RoutePending } from "@/app/shell/route-state";
import { optionalString } from "@/lib/search-params";
import { createPageHead, SITE_NAME } from "@/lib/seo";
import { lazy } from "react";

const HomePage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/home/home-page").then((page) => ({ default: page.HomePage })));

export const Route = createFileRoute("/_authed/home/")({
  // `left`: the meeting you just walked out of, so Home can lead to its recap.
  validateSearch: (raw: Record<string, unknown>): { left?: string } => ({
    left: optionalString(raw.left),
  }),
  // Warm the feeds the page renders in parallel so none waterfalls behind
  // another after hydration. prefetchQuery never throws, so a failing section
  // surfaces inside the page's own suspense boundary instead of collapsing
  // the whole route.
  loader: async ({ context }) => {
    // Home never waits on follow-ups; they start loading with the rest.
    void context.queryClient.prefetchQuery(myOpenFollowUpsQueryOptions());
    await Promise.all([
      context.queryClient.prefetchQuery(myThreadsQueryOptions()),
      context.queryClient.prefetchInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions()),
      context.queryClient.prefetchInfiniteQuery(myMeetingsQueryOptions({ status: "ended", limit: 6 })),
    ]);
  },
  head: () => createPageHead({
    title: `Home — ${SITE_NAME}`,
    description: "Your meetings, what is still to do, and your room.",
    noindex: true,
    canonical: false,
  }),
  pendingComponent: RoutePending,
  component: HomePage,
  errorComponent: RouteError,
});
