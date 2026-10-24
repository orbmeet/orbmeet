import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Meetings used to be a page of its own. What is planned now lives in the
 * Calendar, and what happened in the Library; an old link lands on whichever
 * of the two it was showing, with its filters.
 */
export const Route = createFileRoute("/_authed/meetings/")({
  beforeLoad: ({ search }) => {
    const { view, ...rest } = search as Record<string, unknown>;
    if (view === "upcoming") throw redirect({ to: "/calendar", replace: true });
    throw redirect({ to: "/library", search: rest, replace: true });
  },
});
