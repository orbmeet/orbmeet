import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getEndedMeeting, getLatestMeetingTranscripts } from "@/modules/transcripts/server/meeting-summary.functions";
import { getParticipantHandoffSummary } from "@/modules/transcripts/server/participant-handoff.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export function endedMeetingQueryOptions(meetingId: string) {
  return queryOptions({
    queryKey: queryKeys.meetings.summary(meetingId),
    queryFn: ({ signal }) =>
      getEndedMeeting({ data: { meetingId }, signal }),
    staleTime: 300_000,
    gcTime: 600_000,
  });
}

export function meetingTranscriptsInfiniteQueryOptions(meetingId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.meetings.transcripts(meetingId),
    queryFn: ({ pageParam, signal }) =>
      getLatestMeetingTranscripts({
        data: { meetingId, cursor: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: null as NonNullable<
      Awaited<ReturnType<typeof getLatestMeetingTranscripts>>["nextCursor"]
    > | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 300_000,
    gcTime: 600_000,
  });
}

export function participantHandoffQueryOptions(
  meetingId: string,
  admissionId: string,
) {
  return queryOptions({
    queryKey: queryKeys.participantHandoff(meetingId, admissionId),
    queryFn: ({ signal }) =>
      getParticipantHandoffSummary({
        data: { meetingId, admissionId },
        signal,
      }),
    staleTime: 0,
    gcTime: 300_000,
  });
}
