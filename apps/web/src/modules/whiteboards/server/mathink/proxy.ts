import * as v from "valibot";
import {
  mathInkRequestSchema,
  MATHINK_MAX_RAW_POINTS,
} from "@orbmeet/whiteboard-core/mathink-contract";

import { logWarn } from "@/lib/logger";
import {
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
  readResponseBodyBytes,
} from "@/platform/http/response-body";
import { createDb } from "@orbmeet/db";
import { verifyActiveWhiteboardBearer } from "@/modules/whiteboards/server/http/active-whiteboard-auth";
import {
  enforceBindingRateLimit,
  noStoreJsonResponse,
  readBoundedJsonRequestBody,
} from "@/modules/whiteboards/server/http/json-proxy-helpers";
import { getClientIPFromRequest } from "@/platform/http/client-ip";
import { deploymentOf, isLocalDevelopment } from "@/platform/http/deployment";

const MAX_BODY_BYTES = 1024 * 1024;
const ORIGIN_TIMEOUT_MS = 30_000;
const MAX_ORIGIN_RESPONSE_BYTES = 256 * 1024;

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

  const limited = await enforceBindingRateLimit(
    env,
    env.MATHINK_RATE_LIMITER,
    `mathink:${getClientIPFromRequest(request, deploymentOf(env))}`,
    "[mathink]",
  );
  if (limited) return limited;

  const read = await readBoundedJsonRequestBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;

  const parsed = v.safeParse(mathInkRequestSchema, read.body);
  if (!parsed.success) {
    return noStoreJsonResponse({ error: "Invalid strokes" }, 422);
  }
  const rawPointCount = parsed.output.strokes.reduce((total, stroke) => total + stroke.length, 0);
  if (rawPointCount > MATHINK_MAX_RAW_POINTS) {
    return noStoreJsonResponse({ error: `Raw point count exceeds ${MATHINK_MAX_RAW_POINTS}` }, 422);
  }

  const config = originConfig(env);
  if (!config) {
    logWarn("[mathink] origin configuration unavailable");
    return noStoreJsonResponse({ error: "Service unavailable" }, 503);
  }

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.output),
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    });

    if (response.status >= 500) {
      logWarn("[mathink] origin returned an error", { status: response.status });
      return noStoreJsonResponse({ error: "Recognition service unavailable" }, 502);
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
    const timedOut =
      error instanceof ResponseBodyTimeoutError || (error as Error)?.name === "TimeoutError";
    if (error instanceof ResponseBodyTooLargeError) {
      return noStoreJsonResponse({ error: "Recognition service returned too much data" }, 502);
    }
    return noStoreJsonResponse(
      { error: "Recognition service unavailable" },
      timedOut ? 504 : 502,
    );
  }
}

/** Public-route boundary: recognition spends vendor quota, so it requires the
 * same live whiteboard bearer used by the other whiteboard-origin proxies, and,
 * as recognized ink is placed on the board, edit access to it — resolved from
 * D1 with grants applied, so a revoked grant takes effect at once. */
export async function handleAuthenticatedMathInkRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyActiveWhiteboardBearer(request, env, createDb(env.DB));
  if (auth instanceof Response) return auth;
  if (!auth.access.canEditWhiteboard) {
    return new Response("Whiteboard edit access is required", { status: 403 });
  }
  return handleMathInkRequest(request, env);
}
