import { AppError, Errors } from "@/lib/app-errors";
import type { PersonalAccessTokenScope } from "./bearer-auth";
import { authenticateAutomationRequest, tokenIdFromRaw } from "./bearer-auth";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import {
  enforceAutomationPreAuthRateLimit,
  enforceRateLimit,
} from "@/platform/http/rate-limit.server";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { hashSessionToken } from "@/platform/crypto/tokens.server";

const MAX_AUTOMATION_BODY_BYTES = 32 * 1024;

export function apiJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function automationApiErrorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      return apiJson(
        { error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } },
        500,
      );
    }
    return apiJson(
      { error: { code: error.code, message: error.message, details: error.data } },
      error.statusCode,
    );
  }
  if (error instanceof RequestBodyTooLargeError) {
    return apiJson({ error: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large" } }, 413);
  }
  return apiJson(
    { error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } },
    500,
  );
}

export async function readAutomationJson(request: Request): Promise<unknown> {
  const text = await readRequestBodyText(request, MAX_AUTOMATION_BODY_BYTES);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw Errors.VALIDATION("Request body must be valid JSON");
  }
}

export async function readAutomationJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await readAutomationJson(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Errors.VALIDATION("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function handleAutomationApi(
  request: Request,
  scope: PersonalAccessTokenScope | null,
  handler: (input: {
    env: Env;
    principal: Awaited<ReturnType<typeof authenticateAutomationRequest>>;
  }) => Promise<Response>,
): Promise<Response> {
  try {
    const env = await getOptionalEnv();
    if (!env) return apiJson({ error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" } }, 503);
    const authorization = request.headers.get("Authorization");
    const rawToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const credentialId = tokenIdFromRaw(rawToken);
    const credentialRateKey = credentialId
      ? (await hashSessionToken(rawToken)).slice(0, 32)
      : null;
    await enforceAutomationPreAuthRateLimit(env, credentialRateKey);
    const principal = await authenticateAutomationRequest(request, env, scope);
    await enforceRateLimit(env, `automation:${principal.tokenId}`);
    await enforceRateLimit(env, `automation-user:${principal.user.id}`);
    return await handler({ env, principal });
  } catch (error) {
    return automationApiErrorResponse(error);
  }
}
