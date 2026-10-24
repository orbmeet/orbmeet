import "@tanstack/react-start/server-only";

import { Errors } from "@/lib/app-errors";
import { logError } from "@/lib/logger";
import { getClientIP } from "./client-ip.server";
import { getClientIPFromRequest } from "./client-ip";
import { deploymentOf, isLocalDevelopment } from "./deployment";

// ─── Rate limiting ───────────────────────────────────────────────────

function rateLimitLogPayload(key: string, env: Env) {
  const keyScope = key.split(":")[0];
  // Truncated hash for log correlation without leaking PII
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const keyHash = Math.abs(hash).toString(16).padStart(12, "0").slice(0, 12);
  return { keyScope, keyHash, environment: env.ENVIRONMENT };
}

/** A Cloudflare rate-limit binding. */
interface Limiter {
  binding: RateLimit | undefined;
  /** Names the limiter in the refusal when its binding is missing. */
  name: string;
}

/**
 * Spend one unit of `key`'s budget, or throw RATE_LIMITED.
 *
 * Without the binding a deployment refuses outright (CONFIG_ERROR): a missing
 * limiter is a deployment fault, never a reason to stop limiting. Only a
 * developer's own run (`isLocalDevelopment`) goes unlimited without one.
 */
async function limit(env: Env, limiter: Limiter, key: string): Promise<void> {
  if (limiter.binding) {
    const { success } = await limiter.binding.limit({ key });
    if (!success) throw Errors.RATE_LIMITED();
    return;
  }
  if (isLocalDevelopment(deploymentOf(env))) return;
  logError(
    `[RateLimit] ${limiter.name} binding unavailable; rejecting request.`,
    rateLimitLogPayload(key, env),
  );
  throw Errors.CONFIG_ERROR(`${limiter.name} binding not configured`);
}

export async function enforceRateLimit(
  env: Env,
  key: string,
  useAuthLimiter = false,
): Promise<void> {
  await limit(
    env,
    useAuthLimiter
      ? { binding: env.AUTH_RATE_LIMITER, name: "Rate limiter" }
      : { binding: env.RATE_LIMITER, name: "Rate limiter" },
    key,
  );
}

export async function enforceIpRateLimit(env: Env, action: string): Promise<void> {
  const ip = getClientIP();
  await enforceRateLimit(env, `auth-ip:${action}:${ip}`, true);
}

/**
 * Pre-authentication ceiling for the internal transcription producer.
 *
 * The ingest route used the shared auth IP limiter, but that budget is sized for
 * a human retrying a login: 60 requests a minute for one address. Every meeting
 * a transcription host is running arrives from that host's single IP, so
 * meetings throttled *each other* — two busy ones exhausted the address budget
 * while neither came close to its own 100/min per-meeting limit. A rejection
 * leaves the segments in the agent's journal to be retried with backoff, so a
 * budget sized below real volume turns into transcripts that lag the meeting.
 *
 * The producer therefore gets its own aggregate budget instead of borrowing the
 * auth one. This still runs before HMAC verification and is still per-IP, so an
 * unauthenticated flood is bounded exactly as before; only the number it is
 * bounded to reflects what a legitimate producer actually sends. The per-meeting
 * limit after verification is unchanged and remains the real fairness control.
 */
export async function enforceTranscriptIngestPreAuthRateLimit(env: Env): Promise<void> {
  await limit(
    env,
    { binding: env.TRANSCRIPT_INGEST_RATE_LIMITER, name: "Transcript ingest rate limiter" },
    `transcript-ingest-ip:${getClientIP()}`,
  );
}

/**
 * Pre-authentication ceiling for a provider's webhook receiver.
 *
 * These routes read a bounded body and verify a signature with no route-local
 * limit in front of either, so an unauthenticated sender could spend Worker CPU
 * and a body read per request. The auth IP limiter is the wrong instrument for
 * them: every webhook for the whole fleet arrives from one provider's egress
 * addresses, so a 60/min address budget drops legitimate events long before an
 * attacker feels it — the trap the transcript ingest limiter above was created
 * to escape, and the one Paddle's receiver was still in.
 *
 * Both providers retry a rejected delivery, so a throttled event is delayed
 * rather than lost, but the budget is still sized for real fleet volume so
 * retries stay exceptional. The signature check remains the authorization
 * control; this only bounds the work done before reaching it. Each provider
 * gets its own key, so one provider's volume cannot starve the other.
 */
export async function enforceWebhookPreAuthRateLimit(
  env: Env,
  provider: "livekit" | "paddle",
): Promise<void> {
  await limit(
    env,
    {
      binding: provider === "livekit" ? env.LIVEKIT_WEBHOOK_RATE_LIMITER : env.PADDLE_WEBHOOK_RATE_LIMITER,
      name: "Webhook rate limiter",
    },
    `${provider}-webhook-ip:${getClientIP()}`,
  );
}

/**
 * Convert a fail-closed limiter exception at an HTTP boundary without hiding a
 * deployment or provider failure as ordinary client throttling.
 */
export function rateLimitErrorResponse(error: unknown, operation: string): Response {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "RATE_LIMITED") {
    return new Response("Too many requests", { status: 429 });
  }
  logError("[RateLimit] Limiter operation failed.", { operation, code });
  return new Response("Service unavailable", { status: 503 });
}

export async function enforceAutomationPreAuthRateLimit(
  env: Env,
  credentialId: string | null,
  clientIp?: string,
): Promise<void> {
  const ip = clientIp ?? getClientIP();
  await limit(
    env,
    { binding: env.AUTOMATION_IP_RATE_LIMITER, name: "Automation IP rate limiter" },
    `automation-ip:${ip}`,
  );

  // The caller supplies a digest of the full credential, not its attacker-
  // chosen public id. Legitimate integrations behind one NAT keep independent
  // budgets while rotating ids cannot manufacture free guessing buckets.
  await enforceRateLimit(
    env,
    `automation-credential:${ip}:${credentialId ?? "malformed"}`,
    true,
  );
}

/**
 * Pre-authorization ceiling for whiteboard asset reads and the PDF-import
 * control endpoints.
 *
 * These routes each do real work before they can decide whether the caller is
 * allowed: verify a whiteboard token, read the asset registry, resolve a
 * meeting's history access. None of that had a route-local limit in front of
 * it, so the only bound on how much of it an anonymous caller could spend was
 * how fast they could send requests.
 *
 * Sized for a browser rather than a person: opening one board fetches every
 * image on it at once, and the 100/min general budget would throttle ordinary
 * use long before it inconvenienced anyone. Keyed on the address, since these
 * requests are exactly the ones that arrive before an identity is established.
 */
export async function enforceWhiteboardAssetRateLimit(
  env: Env,
  request?: Request,
): Promise<void> {
  const ip = request ? getClientIPFromRequest(request, deploymentOf(env)) : getClientIP();
  await limit(
    env,
    { binding: env.ASSET_RATE_LIMITER, name: "Whiteboard asset rate limiter" },
    `whiteboard-asset-ip:${ip}`,
  );
}
