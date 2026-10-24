import { classifyWhiteboardChunk, isWhiteboardVendor } from "./whiteboard-chunks";

/**
 * Build settings that must remain scoped to one Vite environment. Top-level
 * build options are inherited by both the browser and Cloudflare Worker.
 */
export function createBuildEnvironments(analyze: boolean) {
  return {
    ssr: {
      build: {
        // cf uploads source maps that are present in Build Output. Keep them
        // server-only so production stack traces resolve without publishing
        // browser source maps as static assets.
        sourcemap: true,
        // Worker code is deployable output; keep it readable only for bundle
        // analysis, where the visualizer needs unminified region markers.
        minify: analyze ? false as const : "oxc" as const,
      },
    },
    client: {
      build: {
        // tldraw ships a ~6 MB pre-built distribution bundle.
        chunkSizeWarningLimit: 6500,
        rolldownOptions: {
          output: {
            codeSplitting: {
              minSize: 10_000,
              groups: [
                {
                  name: "vendor-react",
                  test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                  priority: 10,
                },
                {
                  name: "vendor-tanstack",
                  test: (id: string) =>
                    id.includes("/node_modules/@tanstack/") ||
                    id.includes("/node_modules/seroval/") ||
                    id.includes("/node_modules/cookie-es/") ||
                    id.includes("/node_modules/tiny-invariant/") ||
                    id.includes("/node_modules/use-sync-external-store/"),
                  priority: 9,
                },
                // Keep eager surface helpers together. Splitting these by entry
                // creates circular chunks with module-initialization hazards.
                {
                  name: "vendor-surface-core",
                  test: (id: string) =>
                    classifyWhiteboardChunk(id) === "vendor-surface-core",
                  priority: 8.5,
                },
                {
                  name: (id: string) => classifyWhiteboardChunk(id) ?? null,
                  priority: 8,
                  entriesAware: true,
                  entriesAwareMergeThreshold: 100_000,
                },
                {
                  name: "vendor-livekit-protobuf",
                  test: /[\\/]node_modules[\\/]@bufbuild[\\/]/,
                  priority: 7,
                },
                // Base UI and Floating UI also initialize cross-module state;
                // entry-aware splitting can execute consumers before exports.
                {
                  name: "vendor-base-ui",
                  test: (id: string) =>
                    id.includes("/node_modules/@base-ui/") ||
                    id.includes("/node_modules/@floating-ui/") ||
                    id.includes("/node_modules/tabbable/") ||
                    id.includes("/node_modules/react-remove-scroll"),
                  priority: 6,
                },
                {
                  name: "vendor-whiteboard-core",
                  test: isWhiteboardVendor,
                  priority: 5,
                  entriesAware: true,
                  entriesAwareMergeThreshold: 100_000,
                },
                {
                  name: "vendor-lucide",
                  test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
                  priority: 4,
                },
              ],
            },
          },
        },
      },
    },
  };
}
