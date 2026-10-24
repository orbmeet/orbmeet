import { createMiddleware } from "@tanstack/react-start";
import type { Database } from "@orbmeet/db";
import type { SessionUser } from "@/modules/identity/contract/auth/session-user";
import { resolveRequestContext, resolveAuthContext } from "./middleware.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";

/**
 * What `requestMiddleware` injects into a server function's context: the
 * request's bindings, DB handle, and caller identity. `user` is `null` for
 * guests; infrastructure failures while resolving the session throw instead
 * of being mistaken for "guest".
 *
 * RPC declaration files hand this object verbatim to their server
 * implementation modules (the `.server.ts` siblings).
 */
export type RequestFnContext = {
  env: Env;
  db: Database;
  /** Request-scoped execution context for deferred work; absent outside Workers. */
  executionCtx: ExecutionContext | undefined;
  clientIP: string;
  user: SessionUser | null;
};

/** `RequestFnContext` for a signed-in caller. */
export type AuthFnContext = RequestFnContext & {
  user: SessionUser;
  authSessionId: string;
};

/**
 * Server function middleware for endpoints that serve both signed-in users
 * and guests (meeting join, heartbeat, screen-share grants, …).
 */
function createRequestMiddleware(preAuthRateLimitPrefix?: string) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    return next({ context: await resolveRequestContext(preAuthRateLimitPrefix) });
  });
}

export const requestMiddleware = createRequestMiddleware();

/**
 * Resolve optional authentication only after applying an IP ceiling. Use this
 * on public endpoints where a crafted session cookie would otherwise spend a
 * D1 lookup before the endpoint's identity-aware limiter can run.
 */
export function preAuthRateLimitedRequestMiddleware(rateLimitPrefix: string) {
  return createRequestMiddleware(rateLimitPrefix);
}

/**
 * Server function middleware that requires a signed-in caller. Apply to all
 * protected server functions via `.middleware([authMiddleware])`.
 */
function createAuthMiddleware(options: { allowAccountDeletionResume: boolean }) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    return next({ context: await resolveAuthContext(options.allowAccountDeletionResume) });
  });
}

export const authMiddleware = createAuthMiddleware({ allowAccountDeletionResume: false });

/** Reserved for the idempotent account-deletion continuation endpoint. */
export const accountDeletionAuthMiddleware = createAuthMiddleware({
  allowAccountDeletionResume: true,
});

/**
 * Throttle a protected server function under a caller-derived key. Implies
 * `authMiddleware`:
 *
 *     .middleware([rateLimited(({ user }) => `meeting:end:${user.id}`)])
 */
export function rateLimited(keyFor: (context: AuthFnContext) => string) {
  return createMiddleware({ type: "function" })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      await enforceRateLimit(context.env, keyFor(context));
      return next();
    });
}
