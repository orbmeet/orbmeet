import "@tanstack/react-start/server-only";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { enforceIpRateLimit, rateLimitErrorResponse } from "@/platform/http/rate-limit.server";
import { getEnv } from "@/platform/runtime/server-runtime.server";

const MAX_REPORT_BODY_BYTES = 32 * 1024;

/**
 * One report a browser posted about itself, as JSON, or the response that
 * turns it away.
 *
 * Unauthenticated ingestion: a per-IP rate limit keeps it from flooding the
 * logs. Any limiter failure, a misconfigured binding included, refuses the
 * report rather than accepting unbounded writes.
 */
export async function readBrowserReport(request: Request, action: string): Promise<{ body: unknown } | Response> {
  const env = await getEnv();
  try {
    await enforceIpRateLimit(env, action);
  } catch (error) {
    return rateLimitErrorResponse(error, `${action}-pre-auth`);
  }

  let text: string;
  try {
    text = await readRequestBodyText(request, MAX_REPORT_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return new Response("Payload too large", { status: 413 });
    throw error;
  }
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
}

/** Where the report came from, as Cloudflare saw it. */
export function reportOrigin(request: Request): { ipCountry?: string; colo?: string } {
  return {
    ipCountry: request.headers.get("CF-IPCountry") ?? undefined,
    colo: request.headers.get("CF-Ray")?.split("-")[1] ?? undefined,
  };
}
