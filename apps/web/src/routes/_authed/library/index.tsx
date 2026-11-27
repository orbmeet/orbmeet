import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { myMeetingsQueryOptions } from "@/modules/meetings/client/meetings.queries";
import { oneOf, optionalString } from "@/lib/search-params";
import { createPageHead, SITE_NAME } from "@/lib/seo";
import { toLibraryMeetingsInput, type LibrarySearch } from "@/pages/library/library-search";

// Library — every past meeting, board and recording, and what was said in
// them, searchable. Its state lives in the URL so a search can be shared and
// survives a refresh.
const LibraryPage = import.meta.env.SSR ? () => null : lazyRouteComponent(() => import("@/pages/library/library-page"), "LibraryPage");

export const Route = createFileRoute("/_authed/library/")({
  validateSearch: (raw: Record<string, unknown>): LibrarySearch => {
    const rawSpaceId = optionalString(raw.spaceId);
    const spaceId = rawSpaceId?.startsWith("space_") || rawSpaceId?.startsWith("spc_") ? rawSpaceId : undefined;
    // Links from before the Library said what they wanted with flags.
    const legacyType = raw.hasRecording === true ? "recordings" : raw.hasWhiteboard === true ? "boards" : undefined;
    return {
      q: optionalString(raw.q),
      find: raw.find === true ? true : undefined,
      type: oneOf(raw.type, ["meetings", "boards", "recordings"] as const) ?? legacyType,
      // A Space is somewhere in Spaces: a link that names one and says
      // Personal would show a header that disagrees with its results.
      scope: spaceId ? "spaces" : oneOf(raw.scope, ["personal", "spaces"] as const),
      spaceId,
      person: optionalString(raw.person),
      within: oneOf(raw.within, ["week", "month", "year"] as const),
    };
  },
  loaderDeps: ({ search: { find: _find, ...search } }) => search,
  loader: ({ context, deps }) => {
    // Not awaited: the list is search-driven, and blocking the route on each
    // query would make typing feel slow. The page reads the same cache entry.
    if (deps.type !== "boards") {
      void context.queryClient.prefetchInfiniteQuery(myMeetingsQueryOptions(toLibraryMeetingsInput(deps)));
    }
  },
  head: () => createPageHead({
    title: `Library — ${SITE_NAME}`,
    description: "Every past meeting, board and recording.",
    noindex: true,
    canonical: false,
  }),
  component: LibraryPage,
  codeSplitGroupings: [["errorComponent"], ["notFoundComponent"]],
});
