import { CSP_NONCE_PLACEHOLDER } from "../../src/platform/http/csp-nonce.ts";

const escapedPlaceholder = CSP_NONCE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const placeholderNonceAttribute = new RegExp(
  `\\snonce=(["'])${escapedPlaceholder}\\1`,
  "g",
);
const cspNonceMeta = /<meta\b(?=[^>]*\bproperty=(["'])csp-nonce\1)[^>]*\/?\s*>/gi;

/**
 * Remove request-time nonce plumbing from immutable prerendered documents.
 *
 * The SPA shell keeps its markers because the Worker rewrites that template per
 * request. Public prerenders bypass the Worker and use the static CSP emitted in
 * `_headers`, so nonce attributes and the router nonce meta are dead metadata.
 */
export function sanitizeStaticPrerenderHtml(html: string): string {
  const sanitized = html
    .replace(cspNonceMeta, "")
    .replace(placeholderNonceAttribute, "");

  if (sanitized.includes(CSP_NONCE_PLACEHOLDER)) {
    throw new Error(
      "Static prerender contains a CSP nonce placeholder outside a recognized nonce attribute",
    );
  }

  return sanitized;
}
