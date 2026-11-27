import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getMeetingAttendance } from "@/modules/meetings/server/history/meeting-attendance-queries.functions";
import { getMyMeetings } from "@/modules/meetings/server/history/personal-meeting-queries.functions";
import { listSpaceMeetings } from "@/modules/meetings/server/history/space-meeting-queries.functions";
import { getRecordingPlaybackUrl } from "@/modules/meetings/server/history/output-downloads.functions";
import { getMyThreads } from "@/modules/meetings/server/room/threads.functions";
import { getSpaceDefaultMeetingLink } from "@/modules/meetings/server/space-default-meeting-link.functions";
import { getClientMeetingHints } from "@/platform/http/client-hints.functions";
import { queryKeys } from "@/lib/query-keys";

export const clientMeetingHintsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.clientMeetingHints(),
    queryFn: ({ signal }) => getClientMeetingHints({ signal }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

export const recordingPlaybackQueryOptions = (artifactId: string) =>
  queryOptions({
    queryKey: queryKeys.artifacts.recordingPlayback(artifactId),
    queryFn: ({ signal }) =>
      getRecordingPlaybackUrl({ data: { artifactId }, signal }),
    staleTime: 50 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

export function myThreadsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.threads(),
    queryFn: ({ signal }) => getMyThreads({ signal }),
    staleTime: 10_000,
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

/**
 * The ended meetings Home reads, enough to fill it once short calls are left
 * out. The route prefetches exactly this, so the page renders what the server
 * already fetched instead of asking again.
 */
export function homeRecentMeetingsQueryOptions() {
  return myMeetingsQueryOptions({ status: "ended", limit: 12 });
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

// Keyset-paginated like members/assets so a space's full meeting history is
// reachable instead of capped at the first page.
export const spaceMeetingsQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.spaces.meetings(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listSpaceMeetings({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15 * 1000, // active meetings change often
    gcTime: 1000 * 60 * 5,
  });

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
