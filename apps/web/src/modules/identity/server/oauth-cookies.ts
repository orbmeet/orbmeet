import "@tanstack/react-start/server-only";

import { createCookieString } from "@/platform/http/cookies.server";
import { oauthStateCookieNames } from "./oauth-state";

/** Set-Cookie values that delete the named OAuth state cookies. */
export function clearOAuthStateCookies(env: Env, names: readonly string[]): string[] {
  return names.map((name) =>
    createCookieString(name, "", 0, { appUrl: env.APP_URL, environment: env.ENVIRONMENT, path: "/" }),
  );
}

/**
 * Every OAuth state cookie an in-flight or abandoned attempt left in the
 * browser, cleared. Neither kind authenticates anything on its own —
 * completing a flow still needs a valid code and, for linking, the bound
 * session — but a sign-out that says "this browser is clean" should leave it
 * clean. The cookies are HttpOnly, so only the request says which exist.
 */
export function clearOAuthFlowCookies(env: Env, cookieHeader: string | null): string[] {
  return clearOAuthStateCookies(env, oauthStateCookieNames(cookieHeader));
}
