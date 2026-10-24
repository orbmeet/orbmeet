import "@tanstack/react-start/server-only";

import { getRequest } from "@tanstack/react-start/server";
import { readCloudflareContext } from "@/platform/runtime/cloudflare-context";
import { getClientIPFromRequest } from "./client-ip";
import { deploymentOf } from "./deployment";

/** The current server-function or route request's client IP; see ./client-ip.ts. */
export function getClientIP(): string {
  try {
    const request = getRequest();
    const env = readCloudflareContext()?.env;
    return getClientIPFromRequest(request, deploymentOf(env));
  } catch {
    return "unknown";
  }
}
