import { redirect, isRedirect } from "@tanstack/react-router";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { onlineManager, type QueryClient } from "@tanstack/react-query";

interface SessionGateContext {
  queryClient: QueryClient;
}

interface SessionGateLocation {
  href: string;
}

/**
 * Shared auth gate utility for protected routes.
 * Fetches session from server and redirects to login if unauthenticated.
 * Falls back to cached session on transient network errors.
 */
export async function resolveSessionGate(
  context: SessionGateContext,
  location: SessionGateLocation
) {
  // ParsedLocation.href preserves the validated location's raw search and hash.
  const redirectUrl = location.href;

  const options = sessionQueryOptions();
  const getCachedSession = () => context.queryClient.getQueryData(options.queryKey);

  // Query's default online mode pauses fetchQuery while offline, so a rejected
  // promise never reaches the fallback below. Resolve from an authenticated
  // cache snapshot instead of leaving Router navigation pending indefinitely.
  if (!onlineManager.isOnline()) {
    const cached = getCachedSession();
    if (cached) return { session: cached };
    throw new Error("Authentication cannot be verified while offline");
  }

  try {
    // Use fetchQuery instead of ensureQueryData because ensureQueryData
    // returns cached data (even null) without refetching when stale.
    // This caused logged-in users to be redirected to /auth after login
    // because the pre-login null session was returned from cache.
    // fetchQuery respects staleness and isInvalidated, so after
    // invalidateQueries it will re-fetch from the server.
    const session = await context.queryClient.fetchQuery({
      ...options,
      // Do not let a connectivity change after the pre-check turn this
      // awaited route guard into a paused Query promise.
      networkMode: "always",
    });
    if (!session) {
      throw redirect({
        to: "/auth",
        search: { mode: "login", redirect: redirectUrl },
      });
    }
    return { session };
  } catch (error) {
    if (isRedirect(error)) throw error;

    // Only use a previously resolved session as a fallback. Cold-load network or
    // server failures should surface as real route errors instead of looking like
    // a logout and bouncing the user to /auth.
    const cached = getCachedSession();

    if (cached) {
      return { session: cached };
    }

    throw error;
  }
}
