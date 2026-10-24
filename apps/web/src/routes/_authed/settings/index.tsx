import { createFileRoute } from "@tanstack/react-router";
import { sessionsListQueryOptions, linkedAccountsQueryOptions, passkeysQueryOptions, personalAccessTokensQueryOptions, storageUsageQueryOptions } from "@/app/query-client/queries/settings";
import { myOrganizationsQueryOptions } from "@/app/query-client/queries/organizations";
import { isSettingsTabId, settingsPageOf, type SettingsTabId } from "@/pages/settings/settings-tabs";
import { optionalString } from "@/lib/search-params";
import { lazy } from "react";

const RouteError = import.meta.env.SSR ? () => null : lazy(() => import("@/app/shell/route-state").then((page) => ({ default: page.RouteError })));
const SettingsPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/settings/settings-page").then((page) => ({ default: page.SettingsPage })));

export const Route = createFileRoute("/_authed/settings/")({
  validateSearch: (raw): { linked?: string; reason?: string; tab?: SettingsTabId } => ({
    linked: optionalString(raw?.linked),
    reason: optionalString(raw?.reason),
    tab: isSettingsTabId(raw?.tab) ? raw.tab : undefined,
  }),
  loaderDeps: ({ search }) => ({ page: settingsPageOf(search.tab) }),
  // Start the page's requests while its lazy component chunk loads. Do not
  // block navigation: each query-backed panel owns its local suspense and
  // error state.
  loader: ({ context, deps }) => {
    if (deps.page === "account") {
      void context.queryClient.prefetchQuery(passkeysQueryOptions());
      void context.queryClient.prefetchQuery(linkedAccountsQueryOptions());
      void context.queryClient.prefetchQuery(sessionsListQueryOptions());
      void context.queryClient.prefetchQuery(personalAccessTokensQueryOptions());
    } else if (deps.page === "billing") {
      void context.queryClient.prefetchQuery(storageUsageQueryOptions());
      void context.queryClient.prefetchQuery(myOrganizationsQueryOptions());
    }
  },
  component: SettingsPage,
  errorComponent: RouteError,
});
