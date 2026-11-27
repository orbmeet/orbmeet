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
  // From the start of that day, so the result does not shift as the clock
  // moves; the UTC day, so the server's prefetch and the viewer's page put the
  // same `since` in the query key whatever zone each runs in.
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
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
