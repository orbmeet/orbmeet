// Post-build guards for the Build Output under apps/web/.cloudflare/output.
// Runs after `vite build` and fails the build on regressions that would
// otherwise ship silently:
//
//   1. client bundle — no server code, schema, or secret identifiers in the
//      browser, and every application document links the single StyleX sheet.
//   2. Worker bundle — stays well under Cloudflare's 10 MB compressed limit,
//      keeps the entry module small, and excludes browser-only libraries that
//      the SSR stubs are supposed to remove.
//   3. public pages — each one is prerendered and carries no request-time
//      nonce marker, since Assets serves it without the Worker.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { publicDocumentPaths } from "../src/lib/public-routes.ts";
import { CSP_NONCE_PLACEHOLDER } from "../src/platform/http/csp-nonce.ts";

const root = resolve(import.meta.dirname, "../../..");
// The Vite plugin emits the Build Output API tree: static assets (documents,
// icons, the service worker) in the default Worker's assets dir, the Worker
// bundle itself (entry + chunks) in its bundle dir.
const outputDir = resolve(root, "apps/web/.cloudflare/output/v0/workers/default");
const clientDir = resolve(outputDir, "assets");
const serverDir = resolve(outputDir, "bundle");
const rel = (path) => relative(root, path);

function fail(scope, failures) {
  if (failures.length > 0) throw new Error(`[${scope}] failed:\n${failures.join("\n")}`);
}

function listFiles(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, predicate);
    return predicate(entry.name) ? [fullPath] : [];
  });
}

// ---------------------------------------------------------------------------
// 1. Client bundle
// ---------------------------------------------------------------------------
function checkClientBundle() {
  const assetsDir = resolve(clientDir, "assets");
  if (!existsSync(assetsDir)) throw new Error(`Client bundle not found at ${rel(assetsDir)}. Run the web build first.`);

  const forbidden = [
    [/drizzle:SQLite|sqliteTable|meeting_artifacts|upload_reservations/, "Drizzle schema/runtime must not ship in the browser bundle."],
    [/livekit-server-sdk/, "LiveKit server SDK must stay out of the browser bundle."],
    [/R2_SECRET_ACCESS_KEY|AI_API_KEY|AUTH_SECRET|GOOGLE_CLIENT_SECRET|PADDLE_API_KEY|WHITEBOARD_COMMAND_KEYS|WHITEBOARD_CALLBACK_KEYS/, "Server secret identifiers must stay out of the browser bundle."],
  ];

  const failures = [];
  const clientSourceMaps = listFiles(clientDir, (name) => name.endsWith(".map"));
  if (clientSourceMaps.length > 0) {
    failures.push(
      `Browser source maps must not be published as static assets: ${clientSourceMaps.map(rel).join(", ")}`,
    );
  }
  let totalJsBytes = 0;
  const cssByName = new Map();
  for (const name of readdirSync(assetsDir)) {
    const fullPath = join(assetsDir, name);
    if (name.endsWith(".css")) {
      cssByName.set(name, readFileSync(fullPath, "utf8"));
      continue;
    }
    if (!name.endsWith(".js")) continue;
    totalJsBytes += statSync(fullPath).size;
    const code = readFileSync(fullPath, "utf8");
    for (const [pattern, reason] of forbidden) {
      if (pattern.test(code)) failures.push(`${rel(fullPath)}: ${reason}`);
    }
  }

  const stylexAssets = [...cssByName]
    .filter(([, css]) => /:root, \.x[\w-]+\s*\{[\s\S]*?--x[\w-]+:/.test(css))
    .map(([name]) => name);
  if (stylexAssets.length !== 1) {
    failures.push(`Expected exactly one CSS asset containing the StyleX root variables, found: ${stylexAssets.join(", ") || "(none)"}`);
  } else {
    const href = `href="/assets/${stylexAssets[0]}"`;
    // Hand-written pages in public/ that carry their own styles: the offline
    // fallback, and where another app's built-in browser is sent.
    const standalonePages = new Set(["offline.html", "open-in-browser.html"]);
    for (const htmlPath of listFiles(clientDir, (name) => name.endsWith(".html") && !standalonePages.has(name))) {
      if (!readFileSync(htmlPath, "utf8").includes(href)) {
        failures.push(`${rel(htmlPath)} does not link the StyleX stylesheet ${href}`);
      }
    }
  }

  fail("client-bundle", failures);
  console.log(`[client-bundle] ok (${totalJsBytes} JS bytes)`);
}

// ---------------------------------------------------------------------------
// 2. Worker bundle
// ---------------------------------------------------------------------------
function checkWorkerBundle() {
  const assetsDir = resolve(serverDir, "assets");
  if (!existsSync(assetsDir)) throw new Error(`Worker bundle not found at ${rel(assetsDir)}. Run the web build first.`);

  const forbiddenFiles = [
    [/^vendor-surface-text-.*\.js$/, "Markdown/KaTeX renderer must stay client-only."],
    [/^whiteboard-runtime-.*\.js$/, "The whiteboard client runtime must be SSR-stubbed in the Worker build."],
  ];
  const forbiddenContent = [
    [/node_modules\/\.pnpm\/react-markdown@/, "react-markdown is a browser renderer and should not ship in the Worker."],
    [/node_modules\/\.pnpm\/rehype-katex@/, "rehype-katex is a browser renderer and should not ship in the Worker."],
    [/node_modules\/\.pnpm\/remark-math@/, "remark-math is only needed by browser Markdown rendering."],
    [/node_modules\/\.pnpm\/katex@/, "KaTeX is only needed by browser Markdown rendering."],
    [/node_modules\/\.pnpm\/@simplewebauthn\+browser@/, "@simplewebauthn/browser must be SSR-stubbed in the Worker build."],
    [/node_modules\/\.pnpm\/@base-ui\+react@/, "@base-ui/react must be SSR-stubbed in the Worker build."],
    [/node_modules\/\.pnpm\/@base-ui\+utils@/, "@base-ui utils must be SSR-stubbed in the Worker build."],
    [/node_modules\/\.pnpm\/@floating-ui\+/, "Floating UI is only needed by client-side Base UI components."],
    [/node_modules\/\.pnpm\/react-remove-scroll/, "react-remove-scroll is only needed by client-side overlays."],
    [/verifyAttestation(?:Android|Apple|Packed|TPM|FIDOU2F)/, "Direct-attestation verifiers must stay out because passkey registration requests attestation none."],
    [/SettingsService\.setRootCertificates/, "Unused WebAuthn attestation root certificates must stay out of the Worker bundle."],
  ];

  const failures = [];
  const entryPath = join(serverDir, "index.js");
  const entrySourceMapPath = `${entryPath}.map`;
  if (!existsSync(entrySourceMapPath)) {
    failures.push(`${rel(entrySourceMapPath)} is missing; production Worker stack traces would not resolve.`);
  }
  // The entry module is evaluated for every new isolate; heavy application code
  // must stay behind route-specific dynamic imports.
  const MAX_ENTRY_BYTES = 16 * 1024;
  const entryBytes = readFileSync(entryPath).byteLength;
  if (entryBytes > MAX_ENTRY_BYTES) {
    failures.push(`${rel(entryPath)} is ${entryBytes} bytes, exceeding the ${MAX_ENTRY_BYTES}-byte entry budget. Move route implementations behind dynamic imports.`);
  }

  let totalJsBytes = 0;
  let totalCompressedBytes = 0;
  const jsFiles = [entryPath, ...readdirSync(assetsDir).filter((n) => n.endsWith(".js")).map((n) => join(assetsDir, n))];
  for (const fullPath of jsFiles) {
    const name = fullPath.slice(fullPath.lastIndexOf("/") + 1);
    const buffer = readFileSync(fullPath);
    totalJsBytes += buffer.length;
    // Cloudflare's limit applies to the gzip-compressed size.
    totalCompressedBytes += gzipSync(buffer, { level: 9 }).length;
    for (const [pattern, reason] of forbiddenFiles) {
      if (pattern.test(name)) failures.push(`${rel(fullPath)}: ${reason}`);
    }
    const code = buffer.toString("utf8");
    for (const [pattern, reason] of forbiddenContent) {
      if (pattern.test(code)) failures.push(`${rel(fullPath)}: ${reason}`);
    }
  }

  // The Workers Paid limit is 10 MB. The budget sits far below it: the only
  // thing keeping tldraw, livekit, pdf-lib, etc. out of the Worker is the SSR
  // stubbing, and a regression there would inflate the bundle silently.
  const MAX_COMPRESSED_BYTES = 3 * 1024 * 1024;
  if (totalCompressedBytes > MAX_COMPRESSED_BYTES) {
    failures.push(
      `Worker bundle is ${(totalCompressedBytes / 1024 / 1024).toFixed(2)} MB gzip (raw ${totalJsBytes} bytes), ` +
        "exceeding its 3 MB compressed budget. Check for an SSR stub regression or a new heavy server-path dependency.",
    );
  }

  fail("worker-bundle", failures);
  console.log(`[worker-bundle] ok (${totalJsBytes} JS bytes, ${(totalCompressedBytes / 1024).toFixed(0)} KB compressed)`);
}

// ---------------------------------------------------------------------------
// 3. Public pages
// ---------------------------------------------------------------------------
function checkPublicPages() {
  const failures = [];
  for (const path of publicDocumentPaths()) {
    const artifact = path === "/" ? "index.html" : `${path.slice(1)}/index.html`;
    const artifactPath = resolve(clientDir, artifact);
    if (!existsSync(artifactPath)) {
      failures.push(`Missing prerendered HTML for ${path}: ${rel(artifactPath)}`);
      continue;
    }
    if (readFileSync(artifactPath, "utf8").includes(CSP_NONCE_PLACEHOLDER)) {
      failures.push(`Static prerender for ${path} still contains a request-time nonce marker`);
    }
  }
  fail("public-pages", failures);
  console.log(`[public-pages] ok (${publicDocumentPaths().length} pages)`);
}

checkClientBundle();
checkWorkerBundle();
checkPublicPages();
