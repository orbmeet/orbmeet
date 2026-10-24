import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/app/query-client/query-keys";
import { getClientMeetingHints } from "@/platform/http/client-hints.functions";

export const clientMeetingHintsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.clientMeetingHints(),
    queryFn: ({ signal }) => getClientMeetingHints({ signal }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
