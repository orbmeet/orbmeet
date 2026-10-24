import { getGlobalStartContext } from "@tanstack/react-start";

// Cloudflare's `env` bindings and `ExecutionContext` reach server code through
// TanStack Start's registered request context: `src/server.ts` passes them to
// `handler(request, { context })`, Start threads them through global middleware,
// and everything downstream — server functions, server routes, SSR — reads them
// back here.
//
// Not a property bolted onto the Request object: any `new Request(...)` clone
// inside Start's pipeline would drop it silently, degrading `getEnv()` to the
// ambient `cloudflare:workers` binding and losing `ctx` (and therefore
// `waitUntil`) with no error. The registered context is the documented, typed
// path and survives request cloning.

export interface CloudflareContext {
  env?: Env;
  ctx?: ExecutionContext;
}

/**
 * Read the Cloudflare context for the in-flight request.
 *
 * Returns `undefined` outside a Start request — including the window before
 * global middleware has run, where `getGlobalStartContext()` throws by design.
 * Callers must treat that as "not available" and fall back, never as an error.
 */
export function readCloudflareContext(): CloudflareContext | undefined {
  try {
    return getGlobalStartContext();
  } catch {
    return undefined;
  }
}
