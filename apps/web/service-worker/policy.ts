// The service worker's routing decisions, as plain functions so they are
// tested without a worker (policy.test.ts).

/**
 * The offline page's canonical URL. `html_handling: drop-trailing-slash`
 * redirects `/offline.html` here, and a redirected response cannot answer a
 * navigation.
 */
export const OFFLINE_URL = "/offline";

/** Server routes and server functions: always the network, never a cache. */
export function isServerPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/_serverFn/");
}

/** Paths whose bytes never change: content-hashed chunks and versioned vendor trees. */
export function isImmutableAsset(pathname: string): boolean {
  return pathname.startsWith("/assets/")
    || pathname.startsWith("/wasm/")
    || pathname.startsWith("/wb-assets/");
}

/** Documents are kept under their slash-less path, as the router serves them. */
export function canonicalDocumentPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** Whether a document response may be kept for offline reading. */
export function isCacheableDocument(
  pathname: string,
  response: Response,
  publicDocuments: readonly string[],
): boolean {
  if (response.status !== 200) return false;
  if (!publicDocuments.includes(canonicalDocumentPath(pathname))) return false;
  return !/private|no-store/i.test(response.headers.get("Cache-Control") ?? "");
}
