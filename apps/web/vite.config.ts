import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { readClientVar } from "./scripts/lib/web-config.ts";
import { stylexOptions } from "../../stylex.config.ts";
import { localDevBindingOverrides } from "./build/config/cloudflare.ts";
import { createBuildEnvironments } from "./build/config/environments.ts";
import { privateAddonPlugins } from "./build/private-addon.ts";

import stylex from "@stylexjs/unplugin";
import { cloudflare } from "@cloudflare/vite-plugin";
import { publicDocumentPaths } from "./src/lib/public-routes.ts";
import { workerModuleGuard } from "./build/vite-plugins/worker-module-guard.ts";
import { finalizeBuildArtifacts } from "./build/vite-plugins/finalize-build-artifacts.ts";
import { staticAssetHeaders } from "./build/vite-plugins/static-asset-headers.ts";
import { visualizer } from "rollup-plugin-visualizer";

const enableCloudflareInspector = process.env.CLOUDFLARE_INSPECTOR === "true";

export default defineConfig(async ({ command, mode }) => {
  const useDevVars = command === "serve" || mode === "development";
  // `vite dev --mode e2e` is the browser smoke-test stack (e2e/run.ts). It
  // has its own vars file and persisted state, so a run never touches the dev
  // database or the remote scratch bucket.
  const e2e = mode === "e2e";
  const clientVarOptions = {
    devVarsUrl: new URL(e2e ? "./.dev.vars.e2e" : "./.dev.vars", import.meta.url),
    useDevVars,
  };
  const paddleClientToken = readClientVar("VITE_PADDLE_CLIENT_TOKEN", undefined, clientVarOptions) ?? "";
  const tldrawLicenseKey = readClientVar("VITE_TLDRAW_LICENSE_KEY", undefined, clientVarOptions) ?? "";

  return {
    define: {
      // Shared across Vite's browser and Cloudflare SSR environments. The
      // built-in import.meta.env.DEV differs between those transforms while
      // Start renders its React-owned document shell.
      __STYLEX_DEV__: JSON.stringify(command === "serve"),
      "import.meta.env.VITE_PADDLE_CLIENT_TOKEN": JSON.stringify(paddleClientToken),
      "import.meta.env.VITE_TLDRAW_LICENSE_KEY": JSON.stringify(tldrawLicenseKey),
      // Dev-only opt-in so the production intent-preload path can be exercised
      // locally: `ROUTER_PRELOAD=intent pnpm dev`. See src/router.tsx.
      "import.meta.env.VITE_ROUTER_PRELOAD": JSON.stringify(
        process.env.ROUTER_PRELOAD ?? "",
      ),
    },
    resolve: {
      tsconfigPaths: true,
    },
    optimizeDeps: {
      exclude: [
        "@tanstack/react-query-devtools",
        "@tanstack/react-router-devtools",
      ],
    },
    plugins: [
      // Substitute the private tldraw license override and fail the build if
      // it stops matching upstream (no-op in OSS clones without the addon).
      ...(await privateAddonPlugins()),
      workerModuleGuard(),
      // Cloudflare must precede tanstackStart: this is the plugin order every
      // TanStack Start hosting example uses, and the one upstream tests against.
      cloudflare({
        viteEnvironment: { name: "ssr" },
        inspectorPort: enableCloudflareInspector ? undefined : false,
        ...(e2e && { persistState: { path: ".cloudflare/e2e-state" } }),
        // Dev-server-only overrides: .dev.vars over text bindings, undeclared
        // .dev.vars keys as env vars, and the remote scratch-bucket R2 binding.
        // The hook requires a live Cloudflare session for that remote binding
        // and prerenders real storage — `vite build` keeps the committed
        // production bindings, and the build-time prerender crawl runs through
        // worker-entry.ts's loopback-request gate instead.
        ...(command === "serve" &&
          localDevBindingOverrides(clientVarOptions.devVarsUrl)),
      }),
      tanstackStart({
        importProtection: {
          include: [
            "src/**",
            "../../packages/ui/src/**",
            "**/packages/ui/src/**",
            "../../packages/whiteboard-client/src/**",
            "**/packages/whiteboard-client/src/**",
          ],
          client: {
            // Server-only: every `*.server.*` file and everything under a
            // `server/` directory. The exception is `*.functions.ts` — the
            // createServerFn wrappers, which Start replaces with RPC stubs in
            // the browser build (the convention in Start's server-functions
            // guide). A new server module is therefore protected by where it
            // lives, not by remembering a suffix.
            files: ["**/*.server.*", "**/server/**"],
            // Replaces Start's default, so node_modules is restated.
            excludeFiles: ["**/node_modules/**", "**/*.functions.ts"],
            // Checked after the Start compiler has replaced server function
            // handlers with RPC stubs, so a handler may import these freely.
            specifiers: [
              "@orbmeet/db",
              "@orbmeet/db/schema",
              "drizzle-orm",
              /^drizzle-orm\//,
              "livekit-server-sdk",
            ],
          },
        },
        sitemap: {
          enabled: true,
          host: "https://orbmeet.com",
        },
        // Exactly the public pages (src/lib/public-routes.ts). Start would
        // otherwise discover every static route, including private ones such as
        // /auth, and publish them as static Assets in place of a rendering.
        pages: publicDocumentPaths().map((path) => ({ path })),
        prerender: {
          enabled: true,
          crawlLinks: false,
          concurrency: 10,
          // No retries: Start re-queues a retry under a path it has already
          // seen, so the retry never runs and the failure is dropped instead of
          // failing the build (start-plugin-core 1.171 prerender.js).
          failOnError: true,
          autoStaticPathsDiscovery: false,
        },
      }),
      // StyleX must precede @vitejs/plugin-react so Fast Refresh still sees the
      // component after the style calls have been compiled away.
      //
      stylex.vite({
        ...stylexOptions,
        dev: command === "serve",
        // Two Vite environments (client + the Cloudflare Worker's ssr) compile
        // the same modules in dev. Without a shared on-disk rule store each one
        // only knows about the styles it happened to see, and the served CSS
        // depends on which environment loaded a module first.
        devPersistToDisk: true,
        // The root route owns the global CSS entry. Vite names that entry after
        // the root client chunk (`index-<hash>.css`); every other CSS asset is
        // route- or vendor-scoped. Append the collected atomic sheet there so
        // every document receives it before any lazy route executes.
        //
        // `check-web-build.mjs` independently proves that every emitted
        // application document links the asset containing the StyleX root
        // variables. If either Vite's naming contract or this selector changes,
        // a production build fails instead of silently shipping naked markup.
        cssInjectionTarget: (fileName: string) =>
          /(^|\/)index-[^/]+\.css$/.test(fileName),
      }),
      viteReact({
        compiler: {
          panicThreshold: "none",
          target: "19",
        },
      }),
      staticAssetHeaders(),
      process.env.ANALYZE === "true" &&
        visualizer({
          open: false,
          emitFile: true,
          filename: "stats.html",
          gzipSize: true,
          brotliSize: true,
        }),
      // Must stay last: its buildApp post hook has to run after TanStack Start's
      // post-build prerender so the sweep covers the prerendered output too.
      finalizeBuildArtifacts(),
    ],

    // Applies to every environment. Anything browser-shaped belongs under
    // `environments.client` instead — see the note there.
    build: {
      emptyOutDir: true,
    },

    environments: createBuildEnvironments(process.env.ANALYZE === "true"),
  };
});
