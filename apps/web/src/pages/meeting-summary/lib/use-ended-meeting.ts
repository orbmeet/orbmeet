import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  endedMeetingQueryOptions,
} from "@/app/query-client/queries/meeting-summary";
import { queryKeys } from "@/app/query-client/query-keys";
import { retryMeetingSummary } from "@/modules/transcripts/server/summary-retry.functions";
import type { getEndedMeeting } from "@/modules/transcripts/server/meeting-summary.functions";

export type EndedMeeting = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["meeting"]
>;

export type MeetingSummary = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["summary"]
>;

export type SummaryState = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["summaryState"]
>;

/** How often to look for the Summary while the meeting's summary job owes one. */
const SUMMARY_POLL_MS = 3_000;

/**
 * Loads an ended Meeting. The Summary is written by the meeting's summary job
 * on the server; this only watches for it, and asks for another after a
 * failure.
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

  const summaryState = meetingQuery.data?.summaryState ?? null;
  const summaryReady = summaryState?.status === "ready";
  // Meeting lists show whether a summary exists.
  useEffect(() => {
    if (summaryReady) void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() });
  }, [queryClient, summaryReady]);

  const retryMutation = useMutation({
    mutationFn: () => retryMeetingSummary({ data: { meetingId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.meetings.summary(meetingId) }),
  });

  const meeting = meetingQuery.data?.meeting ?? null;
  return {
    meetingError: meetingQuery.error,
    meeting,
    existingSummary: meetingQuery.data?.summary ?? null,
    existingFollowUps: meetingQuery.data?.followUps ?? [],
    hasTranscript: Boolean(meeting?.hasTranscript),
    summaryState,
    isRetryingSummary: retryMutation.isPending,
    retrySummary: () => retryMutation.mutate(),
    retryMeetingLoad: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.summary(meetingId),
      }),
  };
}
