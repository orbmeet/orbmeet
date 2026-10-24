import * as v from "valibot";
import {
  mathInkRequestSchema,
  MATHINK_MAX_RAW_POINTS,
} from "@orbmeet/whiteboard-core/mathink-contract";

import { logWarn } from "@/lib/logger";
import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyText,
} from "@/platform/http/request-body";
import {
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
  readResponseBodyBytes,
} from "@/platform/http/response-body";
import { createDb } from "@orbmeet/db";
import { verifyActiveWhiteboardBearer } from "@/modules/whiteboards/server/http/active-whiteboard-auth";
import { getClientIPFromRequest } from "@/platform/http/client-ip";
import { deploymentOf, isLocalDevelopment } from "@/platform/http/deployment";

const MAX_BODY_BYTES = 1024 * 1024;
const ORIGIN_TIMEOUT_MS = 30_000;
const MAX_ORIGIN_RESPONSE_BYTES = 256 * 1024;

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function enforceMathInkRateLimit(request: Request, env: Env): Promise<Response | null> {
  if (!env.MATHINK_RATE_LIMITER) {
    if (isLocalDevelopment(deploymentOf(env))) return null;
    logWarn("[mathink] rate limiter binding unavailable");
    return jsonResponse({ error: "Service unavailable" }, 503);
  }

  try {
    const { success } = await env.MATHINK_RATE_LIMITER.limit({
      key: `mathink:${getClientIPFromRequest(request, deploymentOf(env))}`,
    });
    return success ? null : jsonResponse({ error: "Too many requests" }, 429);
  } catch (error) {
    logWarn("[mathink] rate limiter failed", error);
    return jsonResponse({ error: "Service unavailable" }, 503);
  }
}

function originConfig(env: Env): { url: string; secret: string } | null {
  const rawUrl = env.MATHINK_ORIGIN_URL?.trim();
  const secret = env.MATHINK_ORIGIN_SECRET?.trim();
  if (!rawUrl || !secret) return null;

  try {
    const url = new URL(rawUrl);
    if (!isLocalDevelopment(deploymentOf(env)) && url.protocol !== "https:") return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/recognize`;
    url.search = "";
    url.hash = "";
    return { url: url.toString(), secret };
  } catch {
    return null;
  }
}

export async function handleMathInkRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const limited = await enforceMathInkRateLimit(request, env);
  if (limited) return limited;

  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415);
  }

  let bodyText: string;
  try {
    bodyText = await readRequestBodyText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: "Payload too large" }, 413);
    }
    if (error instanceof RequestBodyTimeoutError) {
      return jsonResponse({ error: "Request body timed out" }, 408);
    }
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const parsed = v.safeParse(mathInkRequestSchema, body);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid strokes" }, 422);
  }
  const rawPointCount = parsed.output.strokes.reduce((total, stroke) => total + stroke.length, 0);
  if (rawPointCount > MATHINK_MAX_RAW_POINTS) {
    return jsonResponse({ error: `Raw point count exceeds ${MATHINK_MAX_RAW_POINTS}` }, 422);
  }

  const config = originConfig(env);
  if (!config) {
    logWarn("[mathink] origin configuration unavailable");
    return jsonResponse({ error: "Service unavailable" }, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.output),
      signal: controller.signal,
    });

    if (response.status >= 500) {
      logWarn("[mathink] origin returned an error", { status: response.status });
      return jsonResponse({ error: "Recognition service unavailable" }, 502);
    }

    const responseBody = await readResponseBodyBytes(
      response,
      MAX_ORIGIN_RESPONSE_BYTES,
      ORIGIN_TIMEOUT_MS,
    );
    return new Response(responseBody, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logWarn("[mathink] origin request failed", error);
    const timedOut = controller.signal.aborted || error instanceof ResponseBodyTimeoutError;
    if (error instanceof ResponseBodyTooLargeError) {
      return jsonResponse({ error: "Recognition service returned too much data" }, 502);
    }
    return jsonResponse(
      { error: "Recognition service unavailable" },
      timedOut ? 504 : 502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Public-route boundary: recognition spends vendor quota, so it requires the
 * same live whiteboard bearer used by the other whiteboard-origin proxies. */
export async function handleAuthenticatedMathInkRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyActiveWhiteboardBearer(request, env, createDb(env.DB));
  if (auth instanceof Response) return auth;
  return handleMathInkRequest(request, env);
}
