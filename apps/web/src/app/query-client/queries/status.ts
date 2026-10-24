import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/app/query-client/query-keys";
import { getUptimeStatus } from "@/pages/status/server/status.functions";

export const STATUS_REFRESH_INTERVAL_MS = 60_000;

export const uptimeStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.status(),
    queryFn: ({ signal }) => getUptimeStatus({ signal }),
    staleTime: 30_000,
    refetchInterval: STATUS_REFRESH_INTERVAL_MS,
  });
