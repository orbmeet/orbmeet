/**
 * The only documents that may be served from — or written to — a shared,
 * unauthenticated cache.
 *
 * This is deliberately an allowlist rather than a list of authenticated
 * prefixes: every other document, including every `_authed` route, is treated
 * as private. A route added without touching this file therefore fails closed
 * (rendered `private, no-store`) instead of silently becoming publicly
 * cacheable with another user's dehydrated Query cache embedded in it.
 *
 * It is also what the build prerenders (vite.config.ts), except the pages in
 * PER_VISITOR_PUBLIC_PATHS: prerendered pages are served as static Assets, and
 * every other document is rendered per request. Kept free of imports, since
 * the Vite config loads it directly.
 */
const PUBLIC_DOCUMENT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/pricing",
  "/privacy",
  "/refund",
  "/status",
  "/terms",
]);

/**
 * Public pages whose content depends on who is reading them, so no single
 * static copy can serve everyone: the pricing page shows each visitor the
 * prices their checkout will charge, in their own currency. They stay public
 * and indexable, but are rendered per request (never shared-cached) instead
 * of prerendered.
 */
const PER_VISITOR_PUBLIC_PATHS: ReadonlySet<string> = new Set(["/pricing"]);

/** Trailing slashes are not significant: `/pricing/` is `/pricing`. */
export function normalizeDocumentPath(pathname: string): string {
  return pathname.replace(/\/$/, "") || "/";
}

/**
 * True only for the enumerated public pages. Callers must additionally reject
 * query-bearing URLs before treating a document as cacheable — route search
 * state can carry user- or session-specific values.
 */
export function isPublicDocumentPath(pathname: string): boolean {
  return PUBLIC_DOCUMENT_PATHS.has(normalizeDocumentPath(pathname));
}

/** The public pages: indexable, served with public-page headers. */
export function publicDocumentPaths(): readonly string[] {
  return [...PUBLIC_DOCUMENT_PATHS].sort();
}

/** The public pages the build prerenders into static Assets. */
export function prerenderedDocumentPaths(): readonly string[] {
  return publicDocumentPaths().filter((path) => !PER_VISITOR_PUBLIC_PATHS.has(path));
}
