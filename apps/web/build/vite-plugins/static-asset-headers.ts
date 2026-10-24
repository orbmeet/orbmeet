// The `_headers` file Cloudflare Assets applies to the responses it serves
// without the Worker: the prerendered public pages and every static file.
//
// `_headers` rules never reach Worker responses, so the security block here is
// rendered by buildSecurityHeaders() in src/platform/http/csp.ts — the same
// function the Worker applies — from the same deployment values the Worker
// is built with (build/config/worker-target.ts). The file is a build output,
// emitted into the client bundle by the plugin below; nothing is committed.
import type { Plugin } from "vite";
import { buildSecurityHeaders, whiteboardCspDomains } from "../../src/platform/http/csp.ts";
import { deployVars } from "../config/worker-target.ts";

// Static cache-control rules — not security-derived, so they are authored here.
//
// /assets/* names carry content hashes and the vendor trees carry versions, so
// those cache for good. The app's own fixed-URL files below change in place:
// they revalidate (Cloudflare Assets emits ETags, so that is a cheap 304), and
// the service worker precaches them by content revision on top.
const CACHE_RULES = `# Vite-generated assets have content hashes in their filenames — safe to cache indefinitely.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# The browser must revalidate the service worker and manifest on every visit.
/sw.js
  Cache-Control: no-cache
/manifest.json
  Cache-Control: no-cache

# MediaPipe and the whiteboard engine's assets live under versioned paths
# (/wasm/mediapipe/<version>/, /wasm/models/<name>-<hash>, /wb-assets/<version>/),
# so a URL always names the same bytes.
/wasm/*
  Cache-Control: public, max-age=31536000, immutable
/wb-assets/*
  Cache-Control: public, max-age=31536000, immutable

# Fonts, sounds, images, and PWA icons change rarely but are not hash-versioned.
/fonts/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/sounds/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/images/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/icons/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/apple-touch-icon.png
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800`;

/**
 * Render `_headers` for the deployment at `appUrl`, whose whiteboard sync
 * servers are named under its domain. A prerendered page can client-navigate into a
 * Whiteboard without loading a new document, so its policy must already
 * admit those hosts.
 */
export function renderHeadersFile(appUrl: string): string {
  // Served by Cloudflare Assets over HTTPS in production, so HSTS is on and the
  // non-meet (camera/mic disabled) policy applies.
  const headers = buildSecurityHeaders({
    enableHSTS: true,
    addonCspDomains: whiteboardCspDomains(appUrl),
  });

  const securityBlock = [
    "# Security headers for responses Cloudflare Assets serves without the Worker.",
    "# Rendered from buildSecurityHeaders() in apps/web/src/platform/http/csp.ts.",
    "/*",
    ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`),
  ].join("\n");

  return `${CACHE_RULES}\n\n${securityBlock}\n`;
}

/** Emit `_headers` into the browser bundle, which Cloudflare Assets serves. */
export function staticAssetHeaders(): Plugin {
  return {
    name: "orbmeet:static-asset-headers",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: renderHeadersFile(deployVars.APP_URL),
      });
    },
  };
}
