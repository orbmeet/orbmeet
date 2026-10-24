import "@tanstack/react-start/server-only";

import { getResponseHeaders } from "@tanstack/react-start/server";
import { type CookieOptions, storedCookieName } from "./cookie-names";
import { isLocalDevelopment } from "./deployment";

export type { CookieOptions } from "./cookie-names";

const COOKIE_MAX_TOKENS = 100;

export function createCookieString(
  name: string,
  value: string,
  maxAge: number,
  options?: CookieOptions & { path?: string },
): string {
  const secureFlag = isLocalDevelopment(options) ? "" : "Secure; ";
  const cookiePath = options?.path ?? "/";

  // Host-only (no Domain=): scoped to the exact hostname, never to a public
  // suffix like workers.dev.
  return `${storedCookieName(name, options)}=${value}; Path=${cookiePath}; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * Append Set-Cookie values without overwriting any previously set cookies.
 *
 * Do not rebuild this list through Headers.get("Set-Cookie"). Once more than
 * one cookie exists, Headers.get() comma-folds them into a single string. A
 * later append would then write that folded string back as one malformed
 * cookie, causing browsers to reject the first cookies in the response.
 */
export function appendCookies(cookies: string[]): void {
  if (cookies.length === 0) return;
  const headers = getResponseHeaders();
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
}

export function getSessionIdsFromCookie(cookie: string | null, options?: CookieOptions): string[] {
  if (!cookie) return [];
  const prefix = `${storedCookieName("session", options)}=`;
  const values: string[] = [];
  for (const part of cookie.split(";")) {
    if (values.length >= COOKIE_MAX_TOKENS) break;
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const rawValue = trimmed.slice(prefix.length);
    if (!rawValue) continue;
    try {
      values.push(decodeURIComponent(rawValue));
    } catch {
      values.push(rawValue);
    }
  }
  return values;
}

/**
 * Session tokens a request may be authenticated by: each distinct one, newest
 * last, at most 5. A browser sends one or two; past that the cookie is
 * malformed or crafted, and every token costs a hash and a D1 lookup.
 */
export function sessionTokensFromCookie(cookie: string | null, options?: CookieOptions): string[] {
  return Array.from(new Set(getSessionIdsFromCookie(cookie, options))).slice(-MAX_SESSION_TOKENS_PER_REQUEST);
}

const MAX_SESSION_TOKENS_PER_REQUEST = 5;

/** The value of cookie `name`, read under the name `createCookieString` stores it as. */
export function getCookieValue(
  cookie: string | null,
  name: string,
  options?: CookieOptions & { path?: string },
): string | null {
  if (!cookie) return null;
  const prefix = `${storedCookieName(name, options)}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const rawValue = trimmed.slice(prefix.length);
    if (!rawValue) continue;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

export function getGuestCookieSecretFromCookie(
  cookie: string | null,
  admissionId: string,
  options?: CookieOptions,
): string | null {
  return getCookieValue(cookie, `guest_${admissionId}`, options);
}
