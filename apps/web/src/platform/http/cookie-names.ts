import { isLocalDevelopment, type Deployment } from "./deployment";

export type CookieOptions = Deployment;

/**
 * The name a cookie is stored under. Wherever it can be `Secure`, a cookie
 * carries the prefix browsers enforce: `__Host-` (this exact host, path `/`),
 * or `__Secure-` for a path-scoped cookie.
 *
 * Neither can be set over plain HTTP. Only `__Host-` is also bound to this
 * host: a `__Secure-` cookie may carry `Domain=`, so a sibling subdomain (a
 * whiteboard or media node) could plant one under the same name and path. The
 * path-scoped cookies are therefore only ever credentials their reader
 * verifies (the whiteboard asset cookies hold signed board tokens), never a
 * value trusted for having been read.
 */
export function storedCookieName(name: string, options?: CookieOptions & { path?: string }): string {
  if (isLocalDevelopment(options)) return name;
  return (options?.path ?? "/") === "/" ? `__Host-${name}` : `__Secure-${name}`;
}
