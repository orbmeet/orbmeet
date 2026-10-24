// CSP and security-header *values* live in ./csp (a dependency-free module shared
// with the build's `_headers` renderer so the two never drift). This file holds
// only the Worker-side glue that applies those values to a Response.
import { HSTS_VALUE, buildSecurityHeaders, type SecurityHeadersConfig } from "./csp";
import { REQUEST_ID_HEADER } from "./request-id";
import { CSP_NONCE_PLACEHOLDER } from "./csp-nonce";

export type { SecurityHeadersConfig };

export function addSecurityHeaders(
  response: Response,
  config: SecurityHeadersConfig = {},
): Response {
  const headers = new Headers(response.headers);

  // Each response path applies its policy once. Private documents derive a new
  // nonce-specific config below, so object-identity memoization cannot reuse
  // their policy and only adds bookkeeping to the hot path.
  for (const [name, value] of Object.entries(buildSecurityHeaders(config))) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The security headers that make sense on an API response: no sniffing, no
 * referrer leakage, no cross-origin embedding, and a policy that makes the
 * body inert if a browser ever renders it as a document. A route that answers
 * with a page of its own (the unsubscribe confirmation) sets its own CSP.
 */
const API_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
  "X-Frame-Options": "DENY",
};

/**
 * Finish every `/api/` and `/_serverFn/` response, whichever handler produced
 * it: the API security headers, private no-store unless the route chose its own
 * caching, HSTS, and the request id. A header the handler already set is kept —
 * it is a deliberate choice. A 101 carries a WebSocket, not a body, and is
 * returned untouched; it cannot be reconstructed.
 */
export function secureApiResponse(
  response: Response,
  options: { requestId: string; enableHSTS: boolean },
): Response {
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  if (options.enableHSTS) headers.set("Strict-Transport-Security", HSTS_VALUE);
  headers.set(REQUEST_ID_HEADER, options.requestId);

  const bodilessStatus = response.status === 204 || response.status === 304;
  return new Response(bodilessStatus ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

function replaceNoncePlaceholder(
  body: ReadableStream<Uint8Array> | null,
  nonce: string,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const retainedCharacters = CSP_NONCE_PLACEHOLDER.length - 1;
  const emitCompletePlaceholders = () => {
    let output = "";
    let placeholderAt = pending.indexOf(CSP_NONCE_PLACEHOLDER);
    while (placeholderAt >= 0) {
      output += pending.slice(0, placeholderAt) + nonce;
      pending = pending.slice(placeholderAt + CSP_NONCE_PLACEHOLDER.length);
      placeholderAt = pending.indexOf(CSP_NONCE_PLACEHOLDER);
    }
    const safeCharacters = Math.max(0, pending.length - retainedCharacters);
    output += pending.slice(0, safeCharacters);
    pending = pending.slice(safeCharacters);
    return output;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const output = emitCompletePlaceholders();
      if (output) controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      pending += decoder.decode();
      controller.enqueue(encoder.encode(pending.replaceAll(CSP_NONCE_PLACEHOLDER, nonce)));
    },
  }));
}

/** Apply a fresh script nonce while preserving streaming HTML delivery. */
export function addPrivateHtmlSecurityHeaders(
  response: Response,
  config: SecurityHeadersConfig = {},
): Response {
  const nonce = createCspNonce();
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  const rewritten = new Response(replaceNoncePlaceholder(response.body, nonce), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return addSecurityHeaders(rewritten, {
    ...config,
    contentSecurityPolicy: undefined,
    cspNonce: nonce,
  });
}
