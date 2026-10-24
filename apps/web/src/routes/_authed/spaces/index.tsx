import { createFileRoute } from "@tanstack/react-router";
import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { myOrganizationsQueryOptions } from "@/app/query-client/queries/organizations";
import { RouteError, RoutePending } from "@/app/shell/route-state";
import { lazy } from "react";

const SpacesPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/spaces/spaces-page").then((page) => ({ default: page.SpacesPage })));

export const Route = createFileRoute("/_authed/spaces/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.fetchQuery(mySpacesQueryOptions()),
      context.queryClient.fetchQuery(myOrganizationsQueryOptions()),
    ]),
  pendingComponent: RoutePending,
  component: SpacesPage,
  errorComponent: RouteError,
});
