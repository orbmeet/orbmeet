import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { AppPending } from "./app/shell/app-pending";
import { getServerErrorCode, getServerErrorStatusCode } from "./lib/error-inspection";
import { routeTree } from "./routeTree.gen";
import { CSP_NONCE_PLACEHOLDER } from "@/platform/http/csp-nonce";

// Link-hover preloading makes Vite eagerly transform lazy route graphs on every
// hover/focus, which can make localhost feel randomly slow — so dev defaults to
// no preloading. Run `ROUTER_PRELOAD=intent pnpm dev` to exercise the production
// preload path locally; preload-only regressions are otherwise unreachable in
// development. (vite.config.ts defines the VITE_ROUTER_PRELOAD replacement.)
function resolveDefaultPreload(): "intent" | false {
  if (!import.meta.env.DEV) return "intent";
  return import.meta.env.VITE_ROUTER_PRELOAD === "intent" ? "intent" : false;
}

// Per-request router instantiation for SSR isolation on Cloudflare Workers.
// Each request creates a new QueryClient and Router to prevent cross-request
// data leaks. The setupRouterSsrQueryIntegration handles hydration transfer.
export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5-minute freshness window
        gcTime: 1000 * 60 * 10, // 10-minute garbage collection window
        retry: (failureCount, error) => {
          // No retries during SSR to keep server rendering fast
          if (typeof window === "undefined") return false;
          // Don't retry errors that will always fail
          const code = getServerErrorCode(error);
          const statusCode = getServerErrorStatusCode(error);
          if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "VALIDATION_ERROR" || code === "NOT_FOUND" || code === "RATE_LIMITED" || statusCode === 429) {
            return false;
          }
          return failureCount < 2;
        },
      },
    },
  });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: resolveDefaultPreload(),
    // When TanStack Query owns caching, Router preloads should always re-run
    // loaders and let Query decide whether the cached result is still fresh.
    // Every route loader must therefore go through the QueryClient — a loader
    // that calls a server function directly would issue a fresh request on
    // every single hover. `app/boundaries/route-loaders-boundary.test.ts` enforces that.
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 150,
    defaultPendingMinMs: 100,
    defaultPendingComponent: AppPending,
    context: { queryClient },
    // Production HTML is prerendered once. The Worker replaces this marker
    // with a fresh nonce while streaming each private application document.
    ssr: typeof window === "undefined"
      ? { nonce: CSP_NONCE_PLACEHOLDER }
      : undefined,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
};
