import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getMyOrganizations,
  listOrganizationMembers,
  listOrganizationSpaces,
} from "@/modules/organizations/server/organizations.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { keepLastCopyPerId } from "@/lib/infinite-pages";

export const myOrganizationsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.organizations.all(),
    queryFn: ({ signal }) => getMyOrganizations({ signal }),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const organizationMembersInfiniteQueryOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.organizations.members(organizationId),
    queryFn: ({ pageParam, signal }) =>
      listOrganizationMembers({
        data: { organizationId, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select: (data) => keepLastCopyPerId(data, "members"),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const organizationSpacesQueryOptions = (organizationId: string) =>
  queryOptions({
    queryKey: queryKeys.organizations.spaces(organizationId),
    queryFn: ({ signal }) =>
      listOrganizationSpaces({ data: { organizationId }, signal }),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });
