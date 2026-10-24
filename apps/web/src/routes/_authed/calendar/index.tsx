import { createFileRoute } from "@tanstack/react-router";
import { myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { oneOf, optionalString } from "@/lib/search-params";
import { lazy } from "react";

export interface CalendarSearch {
  /** A day in the week shown, as YYYY-MM-DD. Absent: this week. */
  date?: string;
  /** Absent: a week, or a day on a phone, where seven columns do not fit. */
  view?: "day" | "week" | "agenda";
}

const CalendarPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/calendar/calendar-page").then((page) => ({ default: page.CalendarPage })));

// Calendar — what is planned, by week, and where a new meeting is scheduled.
export const Route = createFileRoute("/_authed/calendar/")({
  validateSearch: (raw: Record<string, unknown>): CalendarSearch => {
    const date = optionalString(raw.date);
    return {
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      view: oneOf(raw.view, ["day", "week", "agenda"] as const),
    };
  },
  loader: ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions());
  },
  component: CalendarPage,
});
