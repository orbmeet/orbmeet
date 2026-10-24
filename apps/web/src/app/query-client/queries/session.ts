import { queryOptions } from "@tanstack/react-query";
import { getServerErrorCode } from "@/lib/error-inspection";
import { getRememberedUser, getSession } from "@/modules/identity/server/login.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.session(),
    queryFn: ({ signal }) => getSession({ signal }),
    staleTime: 1000 * 60 * 2, // 2 min - reduced from 10 to catch session expirations faster — session rarely changes, avoid refetching on every navigation
    gcTime: 1000 * 60 * 30, // 30 min — keep session in cache longer to survive transient errors
    retry: (failureCount, error) => {
      // No retries during SSR/fallback rendering. Normal production application
      // documents use the SPA shell and run _authed.beforeLoad in the browser.
      if (typeof window === "undefined") return false;
      // Don't retry on auth errors - they'll never succeed
      const code = getServerErrorCode(error);
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return false;
      return failureCount < 2;
    },
  });

export const rememberedUserQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.rememberedUser(),
    queryFn: ({ signal }) => getRememberedUser({ signal }),
    staleTime: 1000 * 60 * 5,
  });
