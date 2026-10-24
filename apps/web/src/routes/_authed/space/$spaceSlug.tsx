import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  spaceMeetingsQueryOptions,
  spaceMembersInfiniteQueryOptions,
  spaceAuditEventsInfiniteQueryOptions,
  spaceBySlugQueryOptions,
  spaceWhiteboardsQueryOptions,
} from "@/app/query-client/queries/spaces";
import { spaceDefaultMeetingLinkQueryOptions } from "@/app/query-client/queries/meetings";
import { filesInfiniteQueryOptions } from "@/app/query-client/queries/files";
import { primeSpaceDetailCache } from "@/modules/spaces/client/space-query-cache";
import { RouteError, RoutePending } from "@/app/shell/route-state";
import { parseSpaceTab, type SpaceTab } from "@/modules/spaces/contract";
import { lazy } from "react";

const SpaceDetailPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/space/space-detail-page").then((page) => ({ default: page.SpaceDetailPage })));

// The route owns framework registration; the Spaces module owns the screen.
function SpaceRouteComponent() {
  const { spaceSlug } = Route.useParams();
  const { spaceId } = Route.useLoaderData();
  const { tab } = Route.useSearch();
  return <SpaceDetailPage spaceSlug={spaceSlug} spaceId={spaceId} tab={tab} />;
}

export const Route = createFileRoute("/_authed/space/$spaceSlug")({
  validateSearch: (search: Record<string, unknown>): { tab?: SpaceTab } => ({
    tab: parseSpaceTab(search.tab),
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? "meetings" }),
  loader: async ({ context, params, deps }) => {
    // Single blocking round trip: getSpaceBySlug resolves the slug and returns
    // the full space-detail payload in one request. Seed the id-keyed detail
    // cache from it so the page's useSuspenseQuery renders without refetching.
    const spaceData = await context.queryClient.fetchQuery(
      spaceBySlugQueryOptions(params.spaceSlug),
    );
    const spaceId = spaceData.space.id;
    const slugState = context.queryClient.getQueryState(
      spaceBySlugQueryOptions(params.spaceSlug).queryKey,
    );
    primeSpaceDetailCache(context.queryClient, spaceData, slugState?.dataUpdatedAt);

    if (deps.tab === "settings" && !spaceData.capabilities.canManage) {
      throw redirect({
        to: "/space/$spaceSlug",
        params: { spaceSlug: params.spaceSlug },
        search: { tab: "meetings" },
        replace: true,
      });
    }

    // Warm the active tab without blocking navigation. Every panel owns its
    // suspense/loading state, so the header and tab bar paint as soon as the
    // payload above resolves while the tab body fills in behind its spinner.
    switch (deps.tab) {
      case "people":
        void context.queryClient.prefetchInfiniteQuery(
          spaceMembersInfiniteQueryOptions(spaceId),
        );
        break;
      case "files":
        void context.queryClient.prefetchInfiniteQuery(
          filesInfiniteQueryOptions(spaceId),
        );
        break;
      case "whiteboards":
        void context.queryClient.prefetchInfiniteQuery(
          spaceWhiteboardsQueryOptions(spaceId),
        );
        break;
      case "settings":
        void context.queryClient.prefetchInfiniteQuery(
          spaceAuditEventsInfiniteQueryOptions(spaceId),
        );
        break;
      case "meetings":
        void context.queryClient.prefetchInfiniteQuery(
          spaceMeetingsQueryOptions(spaceId),
        );
        void context.queryClient.prefetchQuery(
          spaceDefaultMeetingLinkQueryOptions(spaceId),
        );
        break;
    }

    return { spaceId };
  },
  pendingComponent: RoutePending,
  // A Space owns form drafts, open dialogs, selections, and mutation state.
  // TanStack Router keeps this route instance mounted when only the slug
  // changes, so make the ownership boundary explicit instead of allowing one
  // Space's local state to carry into another Space.
  remountDeps: ({ params }) => params.spaceSlug,
  component: SpaceRouteComponent,
  errorComponent: RouteError,
});
