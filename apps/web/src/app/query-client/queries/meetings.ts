import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getMeetingAttendance } from "@/modules/meetings/server/history/meeting-attendance-queries.functions";
import { getMyMeetings } from "@/modules/meetings/server/history/personal-meeting-queries.functions";
import { getMyLastReusableMeeting } from "@/modules/meetings/server/history/last-reusable-meeting.functions";
import { getMyThreads } from "@/modules/meetings/server/room/threads.functions";
import { searchMySpokenLines } from "@/modules/transcripts/server/spoken-search.functions";
import { listMyOpenFollowUps } from "@/modules/transcripts/server/follow-ups.functions";
import { getSpaceDefaultMeetingLink } from "@/modules/meetings/server/space-default-meeting-link.functions";
import { getMyUpcomingMeetingSchedules } from "@/modules/scheduling/server/queries.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { keepLastCopyPerId } from "@/lib/infinite-pages";

/**
 * The logged-in user's most recently joined recurring Meeting — the landing page's
 * "rejoin" shortcut. Caller gates on `enabled` until the session resolves,
 * since the server fn requires auth.
 */
export function myLastReusableMeetingQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.meetings.lastReusable(),
    queryFn: ({ signal }) => getMyLastReusableMeeting({ signal }),
    staleTime: 30_000,
    gcTime: 300_000,
  });
}

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

export function myThreadsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.threads(),
    queryFn: ({ signal }) => getMyThreads({ signal }),
    staleTime: 10_000,
    gcTime: 300_000,
  });
}

/** Follow-ups not yet done from the viewer's recent meetings. */
export function myOpenFollowUpsQueryOptions(limit = 5) {
  return queryOptions({
    queryKey: [...queryKeys.meetings.openFollowUps(), limit],
    queryFn: ({ signal }) => listMyOpenFollowUps({ data: { limit }, signal }),
    staleTime: 30_000,
    gcTime: 300_000,
  });
}

/** Lines said in the viewer's past meetings that contain `search`. */
export function mySpokenLinesQueryOptions(input: {
  search: string;
  scope?: "all" | "personal" | "spaces";
  spaceId?: string;
  since?: number;
}) {
  return queryOptions({
    queryKey: queryKeys.meetings.spoken(input),
    queryFn: ({ signal }) => searchMySpokenLines({ data: input, signal }),
    staleTime: 60_000,
    gcTime: 300_000,
  });
}

export function myMeetingsQueryOptions(input: {
  search?: string;
  status?: "all" | "open" | "ended";
  scope?: "all" | "personal" | "spaces";
  spaceId?: string;
  hasSummary?: boolean;
  hasRecording?: boolean;
  hasWhiteboard?: boolean;
  since?: number;
  until?: number;
  person?: string;
  limit?: number;
}) {
  return infiniteQueryOptions({
    queryKey: queryKeys.meetings.list(input),
    queryFn: ({ pageParam, signal }) =>
      getMyMeetings({ data: { ...input, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: Awaited<ReturnType<typeof getMyMeetings>>) =>
      lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    gcTime: 300_000,
  });
}

export function spaceDefaultMeetingLinkQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: queryKeys.spaces.defaultMeetingLink(spaceId),
    queryFn: ({ signal }) =>
      getSpaceDefaultMeetingLink({ data: { spaceId }, signal }),
    staleTime: 10_000,
    gcTime: 300_000,
  });
}

export function meetingAttendanceQueryOptions(meetingId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.meetings.attendance(meetingId),
    queryFn: ({ pageParam, signal }) =>
      getMeetingAttendance({ data: { meetingId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    gcTime: 300_000,
  });
}
