import { isLocalDevelopment, type Deployment } from "./deployment";

export type CookieOptions = Deployment;

/**
 * The name a cookie is stored under. Wherever it can be `Secure`, a cookie
 * carries the prefix browsers enforce: `__Host-` (this exact host, path `/`),
 * or `__Secure-` for a path-scoped cookie. Neither can be planted by another
 * host — the whiteboard and media subdomains included — nor over plain HTTP,
 * so a reader that asks for the prefixed name never sees a forged value.
 */
export function storedCookieName(name: string, options?: CookieOptions & { path?: string }): string {
  if (isLocalDevelopment(options)) return name;
  return (options?.path ?? "/") === "/" ? `__Host-${name}` : `__Secure-${name}`;
}
