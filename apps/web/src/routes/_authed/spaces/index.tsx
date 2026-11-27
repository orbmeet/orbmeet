import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { mySpacesQueryOptions } from "@/modules/spaces/client/spaces.queries";
import { myOrganizationsQueryOptions } from "@/modules/organizations/client/organizations.queries";
import { RouteError, RoutePending } from "@/app/shell/route-state";
import { createPageHead, SITE_NAME } from "@/lib/seo";

const SpacesPage = import.meta.env.SSR ? () => null : lazyRouteComponent(() => import("@/pages/spaces/spaces-page"), "SpacesPage");

export const Route = createFileRoute("/_authed/spaces/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.fetchQuery(mySpacesQueryOptions()),
      context.queryClient.fetchQuery(myOrganizationsQueryOptions()),
    ]),
  head: () => createPageHead({
    title: `Spaces — ${SITE_NAME}`,
    description: "The groups you meet with again and again.",
    noindex: true,
    canonical: false,
  }),
  pendingComponent: RoutePending,
  component: SpacesPage,
  codeSplitGroupings: [["errorComponent"], ["notFoundComponent"]],
  errorComponent: RouteError,
});
