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
 * It is also what the build prerenders (vite.config.ts): these pages are
 * served as static Assets, and every other document is rendered per request.
 * Kept free of imports, since the Vite config loads it directly.
 */
const PUBLIC_DOCUMENT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/pricing",
  "/privacy",
  "/refund",
  "/status",
  "/terms",
]);

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

/** The public pages, which the build prerenders. */
export function publicDocumentPaths(): readonly string[] {
  return [...PUBLIC_DOCUMENT_PATHS].sort();
}
