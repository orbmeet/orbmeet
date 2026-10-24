import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getMySpaces, getSpace, getSpaceBySlug } from "@/modules/spaces/server/crud.functions";
import { listSpaceMembers } from "@/modules/spaces/server/membership.functions";
import { listSpaceAuditEvents } from "@/modules/spaces/server/audit.functions";
import { getSpaceInvite, previewInvite } from "@/modules/spaces/server/invites.functions";
import { listSpaceMeetings } from "@/modules/meetings/server/history/space-meeting-queries.functions";
import { listSpaceWhiteboards } from "@/modules/whiteboards/server/api.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { keepLastCopyPerId } from "@/lib/infinite-pages";

type AuditCursor = { createdAt: number; id: string };

export const mySpacesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.spaces.all(),
    queryFn: ({ signal }) => getMySpaces({ signal }),
    staleTime: 30 * 1000, // 30 seconds - user's spaces list doesn't change often
    gcTime: 1000 * 60 * 5, // 5 minutes
  });

export const spaceQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.spaces.detail(spaceId),
    queryFn: ({ signal }) => getSpace({ data: { spaceId }, signal }),
    staleTime: 60 * 1000, // 1 minute - space metadata is relatively stable
    gcTime: 1000 * 60 * 5, // 5 minutes
  });

// Members are paginated independently from space metadata (see listSpaceMembers).
export const spaceMembersInfiniteQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.spaces.members(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listSpaceMembers({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select: (data) => keepLastCopyPerId(data, "members"),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

// Keyset-paginated like members/assets so a space's full meeting history is
// reachable instead of capped at the first page.
export const spaceMeetingsQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.spaces.meetings(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listSpaceMeetings({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15 * 1000, // active meetings change often
    gcTime: 1000 * 60 * 5,
  });

export const spaceWhiteboardsQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.spaces.whiteboards(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listSpaceWhiteboards({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as { updatedAt: number; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15 * 1000,
    gcTime: 1000 * 60 * 5,
  });

// Admin-only governance feed, keyset-paginated over (createdAt desc, id desc).
export const spaceAuditEventsInfiniteQueryOptions = (spaceId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.spaces.audit(spaceId),
    queryFn: ({ pageParam, signal }) =>
      listSpaceAuditEvents({ data: { spaceId, cursor: pageParam }, signal }),
    initialPageParam: undefined as AuditCursor | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const spaceInviteQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.spaces.invite(spaceId),
    queryFn: ({ signal }) => getSpaceInvite({ data: { spaceId }, signal }),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const invitePreviewQueryOptions = (token: string) =>
  queryOptions({
    queryKey: queryKeys.spaces.invitePreview(token),
    queryFn: ({ signal }) => previewInvite({ data: { token }, signal }),
    staleTime: 60 * 1000,
    retry: false,
  });

// Route entry point for /space/$spaceSlug: returns the full space-detail
// payload (same shape as spaceQueryOptions) so slug resolution and the page
// surface cost one round trip. The loader seeds the id-keyed detail cache from
// it; freshness of the rendered page is governed by spaceQueryOptions, so the
// longer staleTime here only spares the slug lookup on quick re-entries.
export const spaceBySlugQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: queryKeys.spaces.bySlug(slug),
    queryFn: ({ signal }) => getSpaceBySlug({ data: { slug }, signal }),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
