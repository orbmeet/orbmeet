import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/app/query-client/query-keys";

/**
 * Seed the id-keyed space detail cache from a slug-keyed payload (both hold the
 * same getSpaceBySlug/getSpace shape) so the detail useSuspenseQuery renders
 * without a second fetch. Only fills an empty entry — an existing detail entry
 * may be fresher than the slug payload (bySlug has the longer staleTime), and
 * its own staleTime already governs background refetches. `updatedAt` carries
 * the slug fetch time so a stale payload is not laundered into a fresh one.
 */
export function primeSpaceDetailCache<TDetail extends { space: { id: string } }>(
  queryClient: QueryClient,
  detail: TDetail,
  updatedAt?: number,
): void {
  const detailKey = queryKeys.spaces.detail(detail.space.id);
  if (queryClient.getQueryData(detailKey) !== undefined) return;
  queryClient.setQueryData(detailKey, detail, { updatedAt });
}

/**
 * Drop every cache branch whose authorization depends on Space membership.
 *
 * The Space's own subtree goes by prefix. Whiteboards and Meetings are cached
 * by their own ids, so their branches go by what the cached payload says they
 * belong to: a removed member must not reopen a board, its asset token or a
 * Meeting record from cache. Lists across Spaces are refetched, as they still
 * hold this Space's rows.
 */
export async function evictSpaceQueryCache(
  queryClient: QueryClient,
  spaceId: string,
  spaceSlug?: string,
): Promise<void> {
  const whiteboardIds = cachedIdsInSpace(queryClient, queryKeys.whiteboards.details(), spaceId, (data) =>
    hasSpaceId(data) ? data.spaceId : undefined,
  );
  const meetingIds = cachedIdsInSpace(queryClient, queryKeys.meetings.summaries(), spaceId, (data) =>
    isRecord(data) && hasSpaceId(data.meeting) ? data.meeting.spaceId : undefined,
  );
  const keys = [
    queryKeys.spaces.scope(spaceId),
    queryKeys.files.bySpace(spaceId),
    ...(spaceSlug ? [queryKeys.spaces.bySlug(spaceSlug)] : []),
    ...whiteboardIds.flatMap((id) => [
      queryKeys.whiteboards.detail(id),
      queryKeys.whiteboards.standaloneAccess(id),
      queryKeys.whiteboards.snapshots(id),
    ]),
    ...meetingIds.flatMap((id) => [
      queryKeys.meetings.summary(id),
      queryKeys.meetings.transcripts(id),
      queryKeys.meetings.attendance(id),
    ]),
  ];

  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  for (const queryKey of keys) queryClient.removeQueries({ queryKey });
  // Not awaited: the caller is usually navigating away, and these refetch in
  // the background wherever they are shown.
  void queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.list() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.upcomingSchedules() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lastReusable() });
}

/** The ids, from each cached `[...prefix, id]` entry, whose payload belongs to `spaceId`. */
function cachedIdsInSpace(
  queryClient: QueryClient,
  prefix: readonly string[],
  spaceId: string,
  spaceOf: (data: unknown) => string | null | undefined,
): string[] {
  return queryClient
    .getQueriesData({ queryKey: prefix })
    .filter(([, data]) => spaceOf(data) === spaceId)
    .map(([queryKey]) => queryKey[prefix.length])
    .filter((id): id is string => typeof id === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSpaceId(value: unknown): value is { spaceId: string | null } {
  return isRecord(value) && (typeof value.spaceId === "string" || value.spaceId === null);
}
