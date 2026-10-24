// Builds the service worker into the client output after `vite build`, once
// the prerendered documents it precaches exist: bundles service-worker/sw.ts,
// then injects the precache manifest (Workbox `injectManifest`).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { injectManifest } from "workbox-build";
import { OFFLINE_URL } from "../service-worker/policy.ts";

const webDir = resolve(import.meta.dirname, "..");
// The Vite plugin emits the Build Output API tree; static assets (documents,
// icons, the service worker itself) live in the default Worker's assets dir.
const clientDir = resolve(webDir, ".cloudflare/output/v0/workers/default/assets");
const rel = (path) => relative(webDir, path);

for (const file of ["index.html", "offline.html", "manifest.json", "pages.json"]) {
  if (!existsSync(resolve(clientDir, file))) {
    throw new Error(`Cannot build the service worker: missing ${rel(clientDir)}/${file}`);
  }
}

// The app's entry chunks, as the landing page links them; their names are
// hashed, so the URL is the revision.
const entryAssets = new Set();
const landing = readFileSync(resolve(clientDir, "index.html"), "utf8");
for (const match of landing.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)) {
  entryAssets.add(match[1]);
}

// Readable offline: the prerendered public pages, from the prerender manifest
// so the list cannot drift from what was built. `/status` reports live service
// health, and an offline copy would present stale data as current.
const OFFLINE_EXCLUDED_DOCUMENTS = new Set(["/status"]);
const { pages } = JSON.parse(readFileSync(resolve(clientDir, "pages.json"), "utf8"));
if (!Array.isArray(pages)) throw new Error("Cannot build the service worker: pages.json has no pages array");
const publicDocuments = pages
  .map((page) => new URL(String(page.path ?? ""), "https://orbmeet.invalid").pathname)
  .filter((path) => !OFFLINE_EXCLUDED_DOCUMENTS.has(path))
  .sort();

const scratch = mkdtempSync(join(tmpdir(), "orbmeet-sw-"));
try {
  const bundled = join(scratch, "sw.js");
  await build({
    entryPoints: [resolve(webDir, "service-worker/sw.ts")],
    outfile: bundled,
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    logLevel: "warning",
    define: {
      PUBLIC_DOCUMENTS: JSON.stringify(publicDocuments),
      // Workbox strips its development logging on this.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  const { count, size, warnings } = await injectManifest({
    swSrc: bundled,
    swDest: resolve(clientDir, "sw.js"),
    globDirectory: clientDir,
    // The app's own fixed-URL files. Workbox revisions each by its content, so
    // a changed file is fetched again and an unchanged one is not.
    globPatterns: [
      "manifest.json",
      "favicon.svg",
      "apple-touch-icon.png",
      "fonts/**/*",
      "icons/**/*",
      "images/**/*",
      "sounds/**/*",
    ],
    modifyURLPrefix: { "": "/" },
    additionalManifestEntries: [
      {
        url: OFFLINE_URL,
        revision: createHash("sha256").update(readFileSync(resolve(clientDir, "offline.html"))).digest("hex"),
      },
      ...[...entryAssets].sort().map((url) => ({ url, revision: null })),
    ],
  });
  for (const warning of warnings) console.warn(`[service-worker] ${warning}`);
  console.log(
    `[service-worker] ${count} precache entries (${Math.round(size / 1024)} KiB), ${publicDocuments.length} offline documents`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
