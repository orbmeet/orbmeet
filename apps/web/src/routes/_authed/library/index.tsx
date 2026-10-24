import { createFileRoute } from "@tanstack/react-router";
import { myMeetingsQueryOptions } from "@/app/query-client/queries/meetings";
import { oneOf, optionalString } from "@/lib/search-params";
import { lazy } from "react";

export type LibraryType = "meetings" | "boards" | "recordings";
export type LibraryWithin = "week" | "month" | "year";

export interface LibrarySearch {
  q?: string;
  /** Arrived by ⌘K or the rail's search: the search box takes focus. */
  find?: true;
  /** One kind of thing only. Absent: everything. */
  type?: LibraryType;
  scope?: "personal" | "spaces";
  spaceId?: string;
  /** Only meetings this person was in, by the name they joined with. */
  person?: string;
  within?: LibraryWithin;
}

const WITHIN_DAYS: Record<LibraryWithin, number> = { week: 7, month: 31, year: 366 };

/** The start of a time filter, in epoch milliseconds; none for any time. */
export function sinceFor(within: LibraryWithin | undefined, now = Date.now()): number | undefined {
  if (!within) return undefined;
  const start = new Date(now - WITHIN_DAYS[within] * 86_400_000);
  // From the start of that day, so the result does not shift as the clock moves.
  return new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
}

/**
 * The past-meetings query for a Library view. Shared by the loader (which
 * warms the cache) and the page (which reads it), so both resolve the same
 * query key and nothing is fetched twice after a server prefetch.
 */
export function toLibraryMeetingsInput(search: LibrarySearch) {
  const scope: "all" | "personal" | "spaces" = search.spaceId ? "spaces" : search.scope ?? "all";
  return {
    search: search.q?.trim() || undefined,
    scope,
    spaceId: search.spaceId,
    person: search.person,
    since: sinceFor(search.within),
    hasRecording: search.type === "recordings" ? true : undefined,
    status: "ended" as const,
  };
}

// Library — every past meeting, board and recording, and what was said in
// them, searchable. Its state lives in the URL so a search can be shared and
// survives a refresh.
const LibraryPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/library/library-page").then((page) => ({ default: page.LibraryPage })));

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
  component: LibraryPage,
});
