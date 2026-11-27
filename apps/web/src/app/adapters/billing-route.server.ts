import "@tanstack/react-start/server-only";
import * as v from "valibot";
import {
  enforceIpRateLimit,
  enforceRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { polarClientFromEnv } from "@/modules/billing/server/polar";

export type BillingPostAuthResult<T> =
  | { ok: true; env: Env; userId: string; body: T }
  | { ok: false; response: Response };

/**
 * Shared auth, rate-limit, and bounded JSON validation preamble for billing
 * Start REST endpoints (`/api/billing/checkout`, `/api/billing/portal`).
 */
export async function authenticateBillingPostRequest<
  S extends v.GenericSchema,
>(
  request: Request,
  options: {
    action: "checkout" | "portal";
    schema: S;
    maxBodyBytes: number;
    allowEmptyBody?: boolean;
  },
): Promise<BillingPostAuthResult<v.InferOutput<S>>> {
  const env = await getOptionalEnv();
  // Billing is on only when the code that calls Polar can build a client:
  // the same check, so a blank token or a mistyped POLAR_SERVER is a 503
  // here, not a failure further in.
  if (!env || !polarClientFromEnv(env)) {
    return { ok: false, response: new Response("Service unavailable", { status: 503 }) };
  }

  try {
    await enforceIpRateLimit(env, `billing-${options.action}`);
  } catch (error) {
    return {
      ok: false,
      response: rateLimitErrorResponse(error, `billing-${options.action}-pre-auth`),
    };
  }

  const session = await verifySessionFromRawRequest(request, env);
  if (!session) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  try {
    await enforceRateLimit(env, `billing:${options.action}:${session.userId}`, true);
  } catch (error) {
    return {
      ok: false,
      response: rateLimitErrorResponse(error, `billing-${options.action}-user`),
    };
  }

  let rawBody: unknown;
  try {
    const text = await readRequestBodyText(request, options.maxBodyBytes);
    rawBody = options.allowEmptyBody && !text ? {} : JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: new Response("Request body too large", { status: 413 }) };
    }
    return { ok: false, response: new Response("Invalid JSON", { status: 400 }) };
  }

  const parsed = v.safeParse(options.schema, rawBody);
  if (!parsed.success) {
    return { ok: false, response: new Response("Invalid request", { status: 400 }) };
  }

  return { ok: true, env, userId: session.userId, body: parsed.output };
}
