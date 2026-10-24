/// <reference lib="webworker" />
// The app's service worker. scripts/build-service-worker.mjs bundles it and
// injects the precache manifest (Workbox `injectManifest`).
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { enable as enableNavigationPreload } from "workbox-navigation-preload";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute, setCatchHandler } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import {
  OFFLINE_URL,
  canonicalDocumentPath,
  isCacheableDocument,
  isImmutableAsset,
  isServerPath,
} from "./policy";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};
/** The prerendered public pages a visitor may read offline. Injected at build. */
declare const PUBLIC_DOCUMENTS: readonly string[];

// The offline page, the app's entry chunks, and its own fixed-URL files
// (fonts, icons, images, sounds, manifest), each revisioned by its content.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
enableNavigationPreload();
clientsClaim();

// The app offers an update; the waiting worker takes over when it is accepted.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

const sameOrigin = (url: URL) => url.origin === self.location.origin;

// Documents: the network first. A public page is kept, under its canonical
// path, so it can be read offline; nothing the server marked private is.
registerRoute(
  ({ request, url }) => request.mode === "navigate" && sameOrigin(url) && !isServerPath(url.pathname),
  new NetworkFirst({
    cacheName: "orbmeet-public-documents",
    plugins: [
      {
        cacheKeyWillBeUsed: async ({ request }) =>
          new URL(canonicalDocumentPath(new URL(request.url).pathname), self.location.origin).href,
        cacheWillUpdate: async ({ request, response }) =>
          isCacheableDocument(new URL(request.url).pathname, response, PUBLIC_DOCUMENTS) ? response : null,
      },
    ],
  }),
);

// Files whose URL names their content — Vite's hashed chunks, and the
// versioned MediaPipe and whiteboard engine trees — never change, so a cached
// copy is always right. Range requests (Safari media) go to the network: the
// Cache API stores no 206 and a cached 200 does not answer one.
registerRoute(
  ({ request, url }) => sameOrigin(url) && !request.headers.has("range") && isImmutableAsset(url.pathname),
  new CacheFirst({
    cacheName: "orbmeet-immutable",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 300 }),
    ],
  }),
);

// A document the network could not provide, and the cache does not hold.
setCatchHandler(async ({ request }) =>
  request.destination === "document"
    ? (await matchPrecache(OFFLINE_URL)) ?? Response.error()
    : Response.error());
