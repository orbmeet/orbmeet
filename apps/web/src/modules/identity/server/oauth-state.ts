import { type CookieOptions, storedCookieName } from "@/platform/http/cookie-names";

/** The base names of the two OAuth flows' state cookies. */
export type OAuthStateCookieBase = "oauth_state" | "oauth_link_state";

const ATTEMPT_COOKIE = /^(?:oauth_state|oauth_link_state)_[a-f0-9]{16}$/;

/** Independent cookie name for one OAuth attempt, safe across concurrent tabs. */
export function oauthStateCookieName(baseName: OAuthStateCookieBase, stateHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(stateHash)) throw new Error("Invalid OAuth state hash");
  return `${baseName}_${stateHash.slice(0, 16).toLowerCase()}`;
}

/**
 * The name of every OAuth attempt's state cookie the request carries, before
 * its `__Host-` prefix: the name `createCookieString` takes to clear it.
 */
export function oauthStateCookieNames(cookieHeader: string | null | undefined): string[] {
  const names = new Set<string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const name = part.trim().split("=")[0].replace(/^__Host-/, "");
    if (ATTEMPT_COOKIE.test(name)) names.add(name);
  }
  return [...names];
}

/**
 * The state cookie of the OAuth attempt whose state hashes to
 * `expectedHashHex`, if the request carries it; the caller clears it and
 * rejects the callback as a state mismatch when there is none.
 */
export function findOAuthStateCookie(input: {
  cookie: string;
  baseName: OAuthStateCookieBase;
  expectedHashHex: string;
  options?: CookieOptions;
}): string | null {
  const name = oauthStateCookieName(input.baseName, input.expectedHashHex);
  const stored = storedCookieName(name, input.options);
  const expected = input.expectedHashHex.toLowerCase();
  for (const part of input.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === stored && rawValue.join("=").toLowerCase() === expected) return name;
  }
  return null;
}
