import { infiniteQueryOptions } from "@tanstack/react-query";
import { listFiles } from "@/modules/spaces/server/files.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export const filesInfiniteQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.files.bySpace(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listFiles({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
  });
