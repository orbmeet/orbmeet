import * as v from "valibot";
import {
  CODE_RUN_CANCEL_PATH,
  CODE_RUN_PATH,
  CODE_RUN_REQUEST_TIMEOUT_MS,
  codeRunResultSchema,
  type CodeRunResult,
} from "@orbmeet/whiteboard-core/code-run-contract";
import type { CodeLanguage } from "@orbmeet/whiteboard-core/code-shape-schema";
import { anySignal } from "../../editor/abort-signals";

export interface RunCodeOptions {
  runId?: string;
  token?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends a cell's source to the runner and returns what came back.
 *
 * It resolves rather than throws on every failure, including transport ones.
 * A run always has something to show — the shape writes `output` and `status`
 * from this either way — so a network error that arrived as an exception would
 * only be turned back into this shape by every caller, one `catch` at a time.
 */
export async function runCode(
  source: string,
  language: CodeLanguage,
  options: RunCodeOptions = {},
): Promise<CodeRunResult> {
  const startedAt = performance.now();
  const runId = options.runId ?? crypto.randomUUID();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const failure = (stderr: string): CodeRunResult => ({
    status: "error",
    phase: "run",
    stdout: "",
    stderr,
    compileStderr: "",
    exitCode: -1,
    timedOut: false,
    truncated: false,
    executionTimeMs: elapsed(),
  });

  if (!options.token) {
    return failure("You do not have permission to run code on this board.");
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? CODE_RUN_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? anySignal([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(CODE_RUN_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ runId, language, source }),
      signal,
    });
  } catch {
    // Both arms of the composed signal land here. Only the timeout is worth
    // naming: a cancelled run is one the caller already knows it abandoned.
    if (timeout.aborted) {
      return failure("The runner did not respond in time. Try again in a moment.");
    }
    return failure("Could not reach the code runner. Check your connection and try again.");
  }

  if (!response.ok) {
    return failure(describeRunFailure(response.status));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure("The code runner returned an unreadable response.");
  }

  const parsed = v.safeParse(codeRunResultSchema, payload);
  if (!parsed.success) {
    return failure("The code runner returned an unreadable response.");
  }

  return parsed.output;
}

export async function cancelCodeRun(
  runId: string,
  options: Pick<RunCodeOptions, "token" | "fetcher"> = {},
): Promise<void> {
  if (!options.token) return;
  try {
    await (options.fetcher ?? fetch)(CODE_RUN_CANCEL_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ runId }),
      keepalive: true,
    });
  } catch {
    // Cancellation is best effort from the UI. The runner's own phase
    // deadlines remain the backstop if the browser loses its connection.
  }
}

function describeRunFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "You do not have permission to run code on this board.";
  }
  if (status === 429) {
    return "Too many runs. Wait a moment and try again.";
  }
  if (status === 409) {
    return "The run was stopped.";
  }
  if (status === 413 || status === 422) {
    return "That snippet is too large to run.";
  }
  if (status === 503) {
    return "Code execution is unavailable right now. Try again in a moment.";
  }
  return "The code runner failed. Try again in a moment.";
}
