import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  sessionQueryOptions,
  type AuthenticatedSession,
} from "@/app/query-client/queries/session";

/**
 * Keep authenticated UI subscribed to the session cache seeded by beforeLoad.
 * Router context is the authorization snapshot; Query is the reactive client
 * source after profile, plan, or account changes.
 */
export function useAuthenticatedSession(
  initialSession: AuthenticatedSession,
): AuthenticatedSession {
  const router = useRouter();
  const sessionQuery = useQuery(sessionQueryOptions());

  const initialUserId = initialSession.user.id;

  useEffect(() => {
    const session = sessionQuery.data;
    if (session === undefined) return;
    // A *different* account matters as much as no account. Signing in as
    // someone else in another tab shares this cache, and invalidating only on
    // null left the router context — the authorization snapshot `beforeLoad`
    // produced — describing the previous user while the page rendered the new
    // one. Server authorization was never fooled by this; the route guards on
    // this tab were.
    if (session === null || session.user.id !== initialUserId) {
      void router.invalidate();
    }
  }, [initialUserId, router, sessionQuery.data]);

  return sessionQuery.data ?? initialSession;
}
