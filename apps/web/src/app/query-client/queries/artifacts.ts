import { queryOptions } from "@tanstack/react-query";
import { getRecordingPlaybackUrl } from "@/modules/meetings/server/history/output-downloads.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export const recordingPlaybackQueryOptions = (artifactId: string) =>
  queryOptions({
    queryKey: queryKeys.artifacts.recordingPlayback(artifactId),
    queryFn: ({ signal }) =>
      getRecordingPlaybackUrl({ data: { artifactId }, signal }),
    staleTime: 50 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
