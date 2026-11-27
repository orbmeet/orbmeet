import { infiniteQueryOptions } from "@tanstack/react-query";
import { getMyUpcomingMeetingSchedules } from "@/modules/scheduling/server/queries.functions";
import { queryKeys } from "@/lib/query-keys";
import { keepLastCopyPerId } from "@/lib/infinite-pages";

// Paged soonest first, and a reschedule moves a schedule along that order.
export function myUpcomingMeetingSchedulesQueryOptions(spaceId?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.meetings.upcomingSchedules(spaceId),
    queryFn: ({ pageParam, signal }) =>
      getMyUpcomingMeetingSchedules({ data: { cursor: pageParam, spaceId }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select: (data) => keepLastCopyPerId(data, "schedules"),
    staleTime: 15_000,
    gcTime: 300_000,
  });
}
