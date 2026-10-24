import "@tanstack/react-start/server-only";

import { Errors } from "@/lib/app-errors";
import { readCloudflareContext } from "@/platform/runtime/cloudflare-context";
import { logWarn } from "@/lib/logger";

async function importCloudflareEnv(): Promise<Env | undefined> {
  try {
    const cloudflareWorkersModule = ["cloudflare", "workers"].join(":");
    const { env } = await import(/* @vite-ignore */ cloudflareWorkersModule);
    return env as Env;
  } catch {
    return undefined;
  }
}

/** Resolve the bindings for the current server request. */
export async function getEnv(): Promise<Env> {
  const env = readCloudflareContext()?.env ?? await importCloudflareEnv();
  if (!env) throw Errors.CONFIG_ERROR("Environment bindings not available");
  return env;
}

/** Resolve bindings without turning an unavailable runtime into an exception. */
export async function getOptionalEnv(): Promise<Env | undefined> {
  return readCloudflareContext()?.env ?? await importCloudflareEnv();
}

/** Return the request-scoped execution context used for deferred work. */
export function getCloudflareCtx(): ExecutionContext | undefined {
  const cloudflare = readCloudflareContext();
  if (import.meta.env.DEV && !cloudflare) {
    logWarn("[cloudflare] request context unavailable; deferred work will run inline");
  }
  return cloudflare?.ctx;
}
