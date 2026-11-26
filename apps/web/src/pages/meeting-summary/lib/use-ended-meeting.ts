import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  endedMeetingQueryOptions,
} from "@/app/query-client/queries/meeting-summary";
import { queryKeys } from "@/app/query-client/query-keys";
import type { getEndedMeeting } from "@/modules/transcripts/server/meeting-summary.functions";

export type EndedMeeting = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["meeting"]
>;

/** How often to look for the Summary while the meeting's summary job owes one. */
const SUMMARY_POLL_MS = 3_000;

/**
 * Loads an ended Meeting and watches for its server-written Summary to arrive.
 */
export function useEndedMeeting({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient();
  const meetingQuery = useQuery({
    ...endedMeetingQueryOptions(meetingId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.summaryState?.status === "pending") return SUMMARY_POLL_MS;
      // A Summary that just appeared can still be replaced by one covering
      // the last transcript segments; keep watching it for a minute.
      const createdAt = data?.summary?.createdAt;
      return createdAt && Date.now() - new Date(createdAt).getTime() < 60_000 ? 5_000 : false;
    },
  });

  const summaryReady = meetingQuery.data?.summaryState?.status === "ready";
  // Meeting lists show whether a summary exists.
  useEffect(() => {
    if (summaryReady) void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() });
  }, [queryClient, summaryReady]);

  const meeting = meetingQuery.data?.meeting ?? null;
  return {
    meetingError: meetingQuery.error,
    meeting,
    hasTranscript: Boolean(meeting?.hasTranscript),
    retryMeetingLoad: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.summary(meetingId),
      }),
  };
}
