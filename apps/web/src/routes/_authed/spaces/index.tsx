import { createFileRoute } from "@tanstack/react-router";
import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { myOrganizationsQueryOptions } from "@/app/query-client/queries/organizations";
import { RouteError, RoutePending } from "@/app/shell/route-state";
import { createPageHead, SITE_NAME } from "@/lib/seo";
import { lazy } from "react";

const SpacesPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/spaces/spaces-page").then((page) => ({ default: page.SpacesPage })));

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
  errorComponent: RouteError,
});
