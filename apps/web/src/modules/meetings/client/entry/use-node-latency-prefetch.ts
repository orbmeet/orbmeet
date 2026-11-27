import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { clientMeetingHintsQueryOptions } from "@/modules/meetings/client/meetings.queries";
import { prefetchNodeLatencies } from "./node-latency";

/**
 * Measure this browser's latency to every media node while the pre-join screen
 * is up, so the join that follows can carry it without waiting.
 */
export function useNodeLatencyPrefetch(): void {
  const { data } = useQuery(clientMeetingHintsQueryOptions());
  const probes = data?.mediaNodes;
  React.useEffect(() => {
    if (probes) prefetchNodeLatencies(probes);
  }, [probes]);
}
