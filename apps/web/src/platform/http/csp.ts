// Single source of truth for the app's Content-Security-Policy and the rest of
// the security response headers.
//
// This module is intentionally dependency-free (no relative imports, no browser
// or Worker globals) so it can be imported from three places that must never
// drift apart:
//   1. The Worker runtime — `addSecurityHeaders` in ./security-headers.ts.
//   2. The build — build/vite-plugins/static-asset-headers.ts renders the
//      `_headers` file Cloudflare Assets applies to the prerendered pages.
//   3. Tests.
//
// `_headers` rules apply ONLY to assets served by Cloudflare Assets, and are
// NOT applied to Worker responses — so the static pages and the Worker-rendered
// pages would otherwise be configured in two separate places. Deriving both
// from this module keeps them identical.

import { whiteboardHostWildcard } from "@orbmeet/nodes";

export interface SecurityHeadersConfig {
  contentSecurityPolicy?: string;
  enableHSTS?: boolean;
  isDevelopment?: boolean;
  isMeetRoute?: boolean;
  appUrl?: string;
  /** Hosts (with any port) of the media nodes a meet route may signal to. */
  mediaNodeHosts?: string[];
  addonCspDomains?: string[];
  cspNonce?: string;
}

/**
 * The CSP hosts a document needs for the whiteboard sync servers: every
 * node's is named under the app's domain (@orbmeet/nodes' `nodeHostnames`),
 * so one wildcard admits each node there is now and any added later, without
 * a rebuild. Nothing for an app URL without a registered domain, such as
 * localhost. The Worker and the static `_headers` both derive the hosts here.
 */
export function whiteboardCspDomains(appUrl: string | undefined): string[] {
  let domain: string;
  try {
    domain = new URL(appUrl ?? "").hostname;
  } catch {
    return [];
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !/^[\d.]+$/.test(domain) ? [whiteboardHostWildcard(domain)] : [];
}

const CLOUDFLARE_INSIGHTS_SCRIPT = "https://static.cloudflareinsights.com";
const CLOUDFLARE_INSIGHTS_CONNECT = "https://cloudflareinsights.com";
const IMG_SRC =
  "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://*.googleusercontent.com https://cdn.tldraw.com";

const PERMISSIONS_POLICY_MEET =
  "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()";
// Restrict camera/mic/display-capture to meet routes only. Granting these to
// every page widens attack surface unnecessarily.
const PERMISSIONS_POLICY_DEFAULT =
  "camera=(), microphone=(), display-capture=(), geolocation=(), payment=()";

export const HSTS_VALUE = "max-age=31536000; includeSubDomains; preload";

export function buildProductionCsp(config?: {
  appUrl?: string;
  addonCspDomains?: string[];
  cspNonce?: string;
}): string {
  const addonDomains = config?.addonCspDomains ?? [];

  return [
    "default-src 'self'",
    // Private app documents receive a per-response nonce. Prerendered public
    // assets cannot be rewritten per request, so their static policy retains
    // unsafe-inline until build-time script hashes are emitted.
    // cdn.paddle.com: Paddle.js billing overlay loaded dynamically on checkout.
    // The authenticated app is an SPA: a document opened on /meetings can
    // client-navigate into a Whiteboard without receiving a new response policy.
    // tldraw's validation/runtime dependencies compile hot paths with eval, so
    // every app shell that can navigate there must permit it.
    `script-src 'self' ${config?.cspNonce ? `'nonce-${config.cspNonce}'` : "'unsafe-inline'"} 'unsafe-eval' https://cdn.paddle.com ${CLOUDFLARE_INSIGHTS_SCRIPT}`,
    // Block inline event handler attributes (onclick="", onerror="", etc.)
    "script-src-attr 'none'",
    // Base UI's injected <style> elements now carry the document nonce (see
    // `CSPProvider` in __root.tsx), but 'unsafe-inline' cannot come off yet:
    // tldraw's `usePrint` appends a plain <style> to document.head that no
    // provider can reach. Nonce-only style-src has to wait on that.
    "style-src 'self' 'unsafe-inline'",
    // Explicit allowance for inline style attributes (style="…") — the landing
    // page's animated elements, and every StyleX dynamic style, which passes
    // its values as custom properties on the style attribute.
    "style-src-attr 'unsafe-inline'",
    // tldraw embeds some font faces as data URLs.
    "font-src 'self' data:",
    IMG_SRC,
    // blob: for media recorded/captured in browser; R2 hosts signed Meeting recordings.
    "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
    // LiveKit/whiteboard WebSockets only needed on meet routes (see buildMeetRouteCsp).
    // api.paddle.com: Paddle.js makes XHR calls to Paddle's API during checkout.
    [
      "connect-src 'self'",
      "https://*.r2.cloudflarestorage.com",
      // cdn.tldraw.com: tldraw license telemetry/watermark when no license key is configured.
      "https://cdn.tldraw.com",
      ...addonDomains.flatMap((d) => [`https://${d}`, `wss://${d}`]),
      // sandbox-api: Paddle.js in sandbox mode calls the sandbox host instead.
      // Both are listed rather than switched on the environment because this
      // policy is also baked into prerendered public assets at build time.
      "https://api.paddle.com",
      "https://sandbox-api.paddle.com",
      CLOUDFLARE_INSIGHTS_CONNECT,
    ].filter(Boolean).join(" "),
    // buy.paddle.com: Paddle checkout renders inside a sandboxed iframe.
    "frame-src https://buy.paddle.com https://sandbox-buy.paddle.com",
    // Whiteboard/PDF workers are created from same-origin or generated blob URLs.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss: ws: http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function getCSP(config?: SecurityHeadersConfig): string {
  return config?.isDevelopment ? DEVELOPMENT_CSP : buildProductionCsp(config);
}

// The complete set of security response headers for a given context, as a plain
// map. Both the Worker (`addSecurityHeaders`) and the static `_headers` generator
// render from this, guaranteeing the two stay identical.
export function buildSecurityHeaders(config: SecurityHeadersConfig = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": config.contentSecurityPolicy || (
      config.isMeetRoute && !config.isDevelopment
        ? buildMeetRouteCsp(config)
        : getCSP(config)
    ),
    // Use SAMEORIGIN to align with CSP frame-ancestors 'self' on meet routes
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": (config.isMeetRoute ?? false)
      ? PERMISSIONS_POLICY_MEET
      : PERMISSIONS_POLICY_DEFAULT,
    // Isolate this browsing context from cross-origin windows. Prevents
    // cross-origin attacks; safe because OAuth uses redirects (not popups).
    "Cross-Origin-Opener-Policy": "same-origin",
    // Prevent this resource from being embedded by cross-origin pages.
    "Cross-Origin-Resource-Policy": "same-site",
  };

  if (config.enableHSTS) {
    headers["Strict-Transport-Security"] = HSTS_VALUE;
  }

  return headers;
}

export function buildMeetRouteCsp(config?: {
  mediaNodeHosts?: string[];
  addonCspDomains?: string[];
  cspNonce?: string;
}): string {
  const addonDomains = config?.addonCspDomains ?? [];

  return [
    "default-src 'self'",
    // WebRTC signaling (LiveKit), whiteboard sync, R2 for assets/recordings.
    // Media and TURN are ICE traffic, which connect-src does not govern; only
    // each node's signalling origin needs listing. This list is also what
    // keeps the recorder page from connecting anywhere else.
    [
      "connect-src 'self'",
      "https://*.r2.cloudflarestorage.com",
      ...(config?.mediaNodeHosts ?? []).flatMap((host) => [`https://${host}`, `wss://${host}`]),
      // cdn.tldraw.com: tldraw license telemetry/watermark when no license key is configured.
      "https://cdn.tldraw.com",
      ...addonDomains.flatMap((d) => [`https://${d}`, `wss://${d}`]),
      CLOUDFLARE_INSIGHTS_CONNECT,
    ].filter(Boolean).join(" "),
    IMG_SRC,
    // 'unsafe-eval' required: MediaPipe tasks-vision runtime uses eval() for WASM initialization.
    // 'wasm-unsafe-eval' required: audio processing WASM modules.
    // blob: required: AudioWorklet loaded as a blob: script URL by the SDK.
    `script-src 'self' ${config?.cspNonce ? `'nonce-${config.cspNonce}'` : "'unsafe-inline'"} 'unsafe-eval' 'wasm-unsafe-eval' blob: ${CLOUDFLARE_INSIGHTS_SCRIPT}`,
    "script-src-attr 'none'",
    // 'unsafe-inline' required for whiteboard engine runtime styles
    "style-src 'self' 'unsafe-inline'",
    // Self-hosted fonts + data: for base64 font rendering
    "font-src 'self' data:",
    // blob: for PDF.js Web Worker and whiteboard canvas worker
    "worker-src 'self' blob:",
    // blob: for WebRTC recorded streams; R2 hosts signed Meeting recordings.
    "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}
