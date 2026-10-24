import * as v from "valibot";
import { createDb } from "@orbmeet/db";
import {
  CODE_RUNNER_BUDGET_MS,
  MAX_CODE_RUN_RESPONSE_BYTES,
  codeRunCancelRequestSchema,
  codeRunRequestSchema,
  codeRunnerRunIdFor,
  codeSandboxIdForRoom,
  type CodeRunnerRequest,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { MAX_CODE_CHARS } from "@orbmeet/whiteboard-core/code-shape-schema";

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
import { whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import {
  verifyActiveWhiteboardBearer,
  type ActiveWhiteboardAuth,
} from "@/modules/whiteboards/server/http/active-whiteboard-auth";
import { whiteboardMeteringPrincipal } from "@/modules/whiteboards/server/http/whiteboard-principal";
import { isLoopbackHostname } from "@/platform/http/loopback";
import { deploymentOf, isLocalDevelopment } from "@/platform/http/deployment";

/**
 * `MAX_CODE_CHARS` is a character bound and this is a byte bound, so it carries
 * headroom for multi-byte source plus the JSON envelope. The schema applies the
 * real limit; this only stops an unbounded read.
 */
const MAX_BODY_BYTES = 256 * 1024;

const CANCEL_FORWARD_TIMEOUT_MS = 5_000;

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Whether a configured runner URL keeps the shared secret off the network.
 *
 * TLS protects it in transit anywhere; loopback never puts it in transit at
 * all, which is the ordinary sidecar-runner deployment and has to keep
 * working. Anything else — a plaintext URL to another host — is refused, not
 * warned about, because a warning in a log nobody reads is not a control.
 */
function isPrivateRunnerUrl(value: string | undefined): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return isLoopbackHostname(url.hostname);
}

async function callCodeRunner(
  env: Env,
  path: "/run" | "/cancel",
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
): Promise<Response> {
  // The service binding is the designed reach: it never leaves Cloudflare's
  // network, and the runner is deployed with `workers_dev: false` precisely so
  // nothing else can address it. `CODE_RUNNER_URL` is the self-hosting escape
  // hatch for a runner reached some other way, and every request through it
  // carries the shared secret — so a plaintext URL to anywhere but this host
  // hands that secret to the network in clear text. A misconfigured value is
  // ignored rather than used, which fails closed onto the binding.
  const configuredRunnerUrl = isPrivateRunnerUrl(env.CODE_RUNNER_URL)
    ? env.CODE_RUNNER_URL
    : null;
  if (env.CODE_RUNNER_URL && !configuredRunnerUrl) {
    logWarn(
      "[run-code] Ignoring CODE_RUNNER_URL: it must be https:// or a loopback address",
    );
  }
  const runnerUrl = configuredRunnerUrl
    ?? (isLocalDevelopment(deploymentOf(env)) ? "http://127.0.0.1:8799" : null);

  if (runnerUrl) {
    try {
      return await fetch(`${runnerUrl}${path}`, init);
    } catch (error) {
      // Preserve deadline failures so the caller can cancel the run. Retrying
      // with an expired signal cannot recover it, even when a binding exists.
      if (!env.CODE_RUNNER || init.signal.aborted || (error as Error)?.name === "TimeoutError") {
        throw error;
      }
      // Fall through to service binding if direct fetch fails.
    }
  }

  if (!env.CODE_RUNNER) {
    throw new Error("Code runner binding unavailable");
  }

  return env.CODE_RUNNER.fetch(`https://code-runner.internal${path}`, init);
}

async function forwardRunnerCancellation(
  env: Env,
  request: Pick<CodeRunnerRequest, "runId" | "sandboxId">,
): Promise<boolean> {
  const hasRunner = Boolean(
    env.CODE_RUNNER || env.CODE_RUNNER_URL || isLocalDevelopment(deploymentOf(env)),
  );
  if (!hasRunner || !env.CODE_RUNNER_SECRET) return false;
  try {
    const response = await callCodeRunner(env, "/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Code-Runner-Secret": env.CODE_RUNNER_SECRET,
      },
      body: JSON.stringify({ runId: request.runId, sandboxId: request.sandboxId }),
      signal: AbortSignal.timeout(CANCEL_FORWARD_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * A run costs container seconds, so this gets a limiter of its own rather than
 * the general 100/min budget — and it is keyed on the participant, not the IP.
 * Everyone in a meeting room can share one NAT, and an IP key would have them
 * throttling each other.
 */
async function enforceCodeRunRateLimit(
  env: Env,
  principal: string,
): Promise<Response | null> {
  if (!env.CODE_RUN_RATE_LIMITER) {
    if (isLocalDevelopment(deploymentOf(env))) return null;
    logWarn("[run-code] rate limiter binding unavailable");
    return jsonResponse({ error: "Service unavailable" }, 503);
  }

  try {
    const { success } = await env.CODE_RUN_RATE_LIMITER.limit({ key: `run-code:${principal}` });
    return success ? null : jsonResponse({ error: "Too many requests" }, 429);
  } catch (error) {
    logWarn("[run-code] rate limiter failed", error);
    return jsonResponse({ error: "Service unavailable" }, 503);
  }
}

export async function handleRunCode(request: Request, env: Env): Promise<Response> {
  const db = createDb(env.DB);
  const auth = await verifyActiveWhiteboardBearer(request, env, db);
  if (auth instanceof Response) return auth;

  const limited = await enforceCodeRunRateLimit(env, whiteboardMeteringPrincipal(auth.access));
  if (limited) return limited;

  // Running code writes its output to a synced shape, so it is an edit. The
  // access above is resolved from D1 with grants applied rather than read off
  // the token, so a revoked or handed-back grant takes effect immediately —
  // the same check the assistant-message and agent-stream endpoints make.
  if (!auth.access.canEditWhiteboard) {
    return new Response("Whiteboard edit access is required", { status: 403 });
  }

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

  const parsed = v.safeParse(codeRunRequestSchema, body);
  if (!parsed.success) {
    return jsonResponse({ error: `Invalid run request (max ${MAX_CODE_CHARS} characters)` }, 422);
  }

  const hasRunner = Boolean(
    env.CODE_RUNNER || env.CODE_RUNNER_URL || isLocalDevelopment(deploymentOf(env)),
  );
  if (!hasRunner || !env.CODE_RUNNER_SECRET) {
    // The ordinary state of a local `pnpm dev` without the runner Worker up.
    // Said plainly, because the alternative is a 500 that looks like a bug.
    logWarn("[run-code] runner binding unavailable");
    return jsonResponse({ error: "Code execution is not available in this environment" }, 503);
  }

  // The sandbox id is derived here, from the verified token's room — never
  // accepted from the browser. Taking it from the request would let any
  // authenticated participant name another board's container and read what was
  // left in it. The run id is bound to the caller the same way.
  const runnerRequest: CodeRunnerRequest = {
    ...parsed.output,
    ...await runnerTarget(auth, parsed.output.runId),
  };

  // One budget for the whole exchange, shared by the request and by reading its
  // body. Given to each separately it would be the ceiling twice over, and a
  // runner that answered slowly and then dribbled its body could hold this
  // invocation for double what the ladder promises.
  const startedAt = Date.now();
  const remainingBudget = () => Math.max(0, CODE_RUNNER_BUDGET_MS - (Date.now() - startedAt));

  try {
    const response = await callCodeRunner(env, "/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Code-Runner-Secret": env.CODE_RUNNER_SECRET,
      },
      body: JSON.stringify(runnerRequest),
      signal: AbortSignal.timeout(CODE_RUNNER_BUDGET_MS),
    });

    // The board is already at its concurrency cap. That is the same answer the
    // per-participant limiter gives, so it reaches the browser as itself rather
    // than as a gateway failure the client would tell someone to retry blindly.
    if (response.status === 429) {
      return jsonResponse({ error: "Too many runs" }, 429);
    }

    // The run was stopped by a cancel. Said as itself: it is not a runner fault.
    if (response.status === 409) {
      return jsonResponse({ error: "Run cancelled" }, 409);
    }

    if (!response.ok) {
      logWarn("[run-code] runner returned an error", { status: response.status });
      return jsonResponse({ error: "Code runner unavailable" }, 502);
    }

    const payload = await readResponseBodyBytes(
      response,
      MAX_CODE_RUN_RESPONSE_BYTES,
      remainingBudget(),
    );
    return new Response(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logWarn("[run-code] runner request failed", error);
    if (error instanceof ResponseBodyTooLargeError) {
      return jsonResponse({ error: "Code runner returned too much data" }, 502);
    }
    if (error instanceof ResponseBodyTimeoutError || (error as Error)?.name === "TimeoutError") {
      // The app's deadline is not permission for the container to keep working.
      // Stop the registered phase before returning the gateway timeout.
      try {
        await forwardRunnerCancellation(env, runnerRequest);
      } catch (cancelError) {
        logWarn("[run-code] timed-out run could not be cancelled", cancelError);
      }
      return jsonResponse({ error: "Code runner timed out" }, 504);
    }
    return jsonResponse({ error: "Code runner unavailable" }, 502);
  }
}

/**
 * Where a run lives in the runner: its board's container, under an id bound
 * to the caller. Both come from the verified token, never from the browser.
 */
async function runnerTarget(
  auth: ActiveWhiteboardAuth,
  runId: string,
): Promise<Pick<CodeRunnerRequest, "runId" | "sandboxId">> {
  return {
    runId: await codeRunnerRunIdFor(whiteboardGrantPrincipalKey(auth.access.grantPrincipal), runId),
    sandboxId: await codeSandboxIdForRoom(auth.syncRoomId),
  };
}

/**
 * Cancels one of the caller's own runs on their board without spending another
 * run quota. Cancelling is part of running code, so it takes the same edit
 * access; and the run id is bound to the caller, so it reaches no one else's.
 */
export async function handleCancelCodeRun(request: Request, env: Env): Promise<Response> {
  const db = createDb(env.DB);
  const auth = await verifyActiveWhiteboardBearer(request, env, db);
  if (auth instanceof Response) return auth;
  if (!auth.access.canEditWhiteboard) {
    return new Response("Whiteboard edit access is required", { status: 403 });
  }

  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415);
  }

  let bodyText: string;
  try {
    bodyText = await readRequestBodyText(request, 4 * 1024);
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
  const parsed = v.safeParse(codeRunCancelRequestSchema, body);
  if (!parsed.success) return jsonResponse({ error: "Invalid cancel request" }, 422);

  const hasRunner = Boolean(
    env.CODE_RUNNER || env.CODE_RUNNER_URL || isLocalDevelopment(deploymentOf(env)),
  );
  if (!hasRunner || !env.CODE_RUNNER_SECRET) {
    return jsonResponse({ error: "Code execution is not available in this environment" }, 503);
  }

  try {
    const cancelled = await forwardRunnerCancellation(env, await runnerTarget(auth, parsed.output.runId));
    if (!cancelled) {
      return jsonResponse({ error: "Could not cancel code run" }, 502);
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logWarn("[cancel-code-run] runner request failed", error);
    return jsonResponse({ error: "Could not cancel code run" }, 502);
  }
}
