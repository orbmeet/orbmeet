import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getWhiteboard, listMyWhiteboards } from "@/modules/whiteboards/server/api.functions";
import { getStandaloneWhiteboardAccess } from "@/modules/whiteboards/server/standalone.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export const myWhiteboardsQueryOptions = (status: "active" | "archived") =>
  infiniteQueryOptions({
    queryKey: queryKeys.whiteboards.list(status),
    queryFn: ({ pageParam, signal }) =>
      listMyWhiteboards({ data: { status, cursor: pageParam }, signal }),
    initialPageParam: undefined as { updatedAt: number; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15 * 1000,
    gcTime: 5 * 60 * 1000,
  });

// Revision contents are immutable, but this payload also carries mutable title,
// lifecycle, and access metadata. Five minutes avoids repeating the session +
// three-table lookup on every card hover while fetchQuery still refreshes stale
// or explicitly invalidated entries before route decisions.
export const whiteboardQueryOptions = (whiteboardId: string) =>
  queryOptions({
    queryKey: queryKeys.whiteboards.detail(whiteboardId),
    queryFn: ({ signal }) =>
      getWhiteboard({ data: { whiteboardId }, signal }),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });

// Standalone-board socket/asset authority. This is the query the board route
// needs before its first asset can render, so the route loader prefetches it
// beside the document instead of the client re-rolling it after first paint.
// The WebSocket connect still mints a fresh token on every attempt (see
// `getStandaloneWebSocketUri`); this cached entry authorizes assets and the
// first paint. Sharing the key keeps the board-list invalidation boundary that
// whiteboard-query-cache.test.ts pins: list refreshes must not re-roll tokens.
export const standaloneWhiteboardAccessQueryOptions = (whiteboardId: string) =>
  queryOptions({
    queryKey: queryKeys.whiteboards.standaloneAccess(whiteboardId),
    queryFn: ({ signal }) =>
      getStandaloneWhiteboardAccess({ data: { whiteboardId }, signal }),
    staleTime: 30 * 60_000,
    retry: false,
  });
