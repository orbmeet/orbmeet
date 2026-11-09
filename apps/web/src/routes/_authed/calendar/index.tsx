import { createFileRoute } from "@tanstack/react-router";
import { myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { optionalString } from "@/lib/search-params";
import { createPageHead, SITE_NAME } from "@/lib/seo";
import { lazy } from "react";

export interface CalendarSearch {
  /** The date shown, as YYYY-MM-DD. Absent: today. */
  date?: string;
}

const CalendarPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/calendar/calendar-page").then((page) => ({ default: page.CalendarPage })));

// Calendar — every meeting on a date, and where a new one is scheduled.
export const Route = createFileRoute("/_authed/calendar/")({
  validateSearch: (raw: Record<string, unknown>): CalendarSearch => {
    const date = optionalString(raw.date);
    return {
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    };
  },
  loader: ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions());
  },
  head: () => createPageHead({
    title: `Calendar — ${SITE_NAME}`,
    description: "Every meeting on a date, past and planned.",
    noindex: true,
    canonical: false,
  }),
  component: CalendarPage,
});
