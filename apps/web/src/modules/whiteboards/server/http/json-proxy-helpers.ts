import { logWarn } from "@/lib/logger";
import { deploymentOf, isLocalDevelopment } from "@/platform/http/deployment";
import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyText,
} from "@/platform/http/request-body";

export function noStoreJsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function enforceBindingRateLimit(
  env: Env,
  limiter: RateLimit | undefined,
  key: string,
  logPrefix: string,
): Promise<Response | null> {
  if (!limiter) {
    if (isLocalDevelopment(deploymentOf(env))) return null;
    logWarn(`${logPrefix} rate limiter binding unavailable`);
    return noStoreJsonResponse({ error: "Service unavailable" }, 503);
  }

  try {
    const { success } = await limiter.limit({ key });
    return success ? null : noStoreJsonResponse({ error: "Too many requests" }, 429);
  } catch (error) {
    logWarn(`${logPrefix} rate limiter failed`, error);
    return noStoreJsonResponse({ error: "Service unavailable" }, 503);
  }
}

export async function readBoundedJsonRequestBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      response: noStoreJsonResponse({ error: "Content-Type must be application/json" }, 415),
    };
  }

  let bodyText: string;
  try {
    bodyText = await readRequestBodyText(request, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: noStoreJsonResponse({ error: "Payload too large" }, 413) };
    }
    if (error instanceof RequestBodyTimeoutError) {
      return {
        ok: false,
        response: noStoreJsonResponse({ error: "Request body timed out" }, 408),
      };
    }
    throw error;
  }

  try {
    return { ok: true, body: JSON.parse(bodyText) as unknown };
  } catch {
    return { ok: false, response: noStoreJsonResponse({ error: "Invalid JSON" }, 400) };
  }
}
