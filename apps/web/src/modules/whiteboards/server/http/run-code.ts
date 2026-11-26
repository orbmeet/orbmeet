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
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
  readResponseBodyBytes,
} from "@/platform/http/response-body";
import { whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import {
  verifyActiveWhiteboardBearer,
  type ActiveWhiteboardAuth,
} from "@/modules/whiteboards/server/http/active-whiteboard-auth";
import {
  enforceBindingRateLimit,
  noStoreJsonResponse,
  readBoundedJsonRequestBody,
} from "@/modules/whiteboards/server/http/json-proxy-helpers";
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

export async function handleRunCode(request: Request, env: Env): Promise<Response> {
  const db = createDb(env.DB);
  const auth = await verifyActiveWhiteboardBearer(request, env, db);
  if (auth instanceof Response) return auth;

  // Running code writes its output to a synced shape, so it is an edit. The
  // access above is resolved from D1 with grants applied rather than read off
  // the token, so a revoked or handed-back grant takes effect immediately —
  // the same check the assistant-message and agent-stream endpoints make.
  if (!auth.access.canEditWhiteboard) {
    return new Response("Whiteboard edit access is required", { status: 403 });
  }

  const read = await readBoundedJsonRequestBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.response;

  const parsed = v.safeParse(codeRunRequestSchema, read.body);
  if (!parsed.success) {
    return noStoreJsonResponse({ error: `Invalid run request (max ${MAX_CODE_CHARS} characters)` }, 422);
  }

  const hasRunner = Boolean(
    env.CODE_RUNNER || env.CODE_RUNNER_URL || isLocalDevelopment(deploymentOf(env)),
  );
  if (!hasRunner || !env.CODE_RUNNER_SECRET) {
    // The ordinary state of a local `pnpm dev` without the runner Worker up.
    // Said plainly, because the alternative is a 500 that looks like a bug.
    logWarn("[run-code] runner binding unavailable");
    return noStoreJsonResponse({ error: "Code execution is not available in this environment" }, 503);
  }

  // Charged only for a run that will actually start: a refused, malformed or
  // undeliverable request costs no container time, so it costs no quota.
  // Keyed on the participant rather than IP so a shared meeting NAT does not
  // throttle everyone together.
  const limited = await enforceBindingRateLimit(
    env,
    env.CODE_RUN_RATE_LIMITER,
    `run-code:${whiteboardMeteringPrincipal(auth.access)}`,
    "[run-code]",
  );
  if (limited) return limited;

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
      return noStoreJsonResponse({ error: "Too many runs" }, 429);
    }

    // The run was stopped by a cancel. Said as itself: it is not a runner fault.
    if (response.status === 409) {
      return noStoreJsonResponse({ error: "Run cancelled" }, 409);
    }

    if (!response.ok) {
      logWarn("[run-code] runner returned an error", { status: response.status });
      return noStoreJsonResponse({ error: "Code runner unavailable" }, 502);
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
      return noStoreJsonResponse({ error: "Code runner returned too much data" }, 502);
    }
    if (error instanceof ResponseBodyTimeoutError || (error as Error)?.name === "TimeoutError") {
      // The app's deadline is not permission for the container to keep working.
      // Stop the registered phase before returning the gateway timeout.
      try {
        await forwardRunnerCancellation(env, runnerRequest);
      } catch (cancelError) {
        logWarn("[run-code] timed-out run could not be cancelled", cancelError);
      }
      return noStoreJsonResponse({ error: "Code runner timed out" }, 504);
    }
    return noStoreJsonResponse({ error: "Code runner unavailable" }, 502);
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

  const read = await readBoundedJsonRequestBody(request, 4 * 1024);
  if (!read.ok) return read.response;

  const parsed = v.safeParse(codeRunCancelRequestSchema, read.body);
  if (!parsed.success) return noStoreJsonResponse({ error: "Invalid cancel request" }, 422);

  const hasRunner = Boolean(
    env.CODE_RUNNER || env.CODE_RUNNER_URL || isLocalDevelopment(deploymentOf(env)),
  );
  if (!hasRunner || !env.CODE_RUNNER_SECRET) {
    return noStoreJsonResponse({ error: "Code execution is not available in this environment" }, 503);
  }

  try {
    const cancelled = await forwardRunnerCancellation(env, await runnerTarget(auth, parsed.output.runId));
    if (!cancelled) {
      return noStoreJsonResponse({ error: "Could not cancel code run" }, 502);
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logWarn("[cancel-code-run] runner request failed", error);
    return noStoreJsonResponse({ error: "Could not cancel code run" }, 502);
  }
}
