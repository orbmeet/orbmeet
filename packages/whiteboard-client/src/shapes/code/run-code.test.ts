import {
  CODE_RUN_CANCEL_PATH,
  CODE_RUN_PATH,
  type CodeRunResult,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { describe, expect, it, vi } from "vitest";
import { cancelCodeRun, runCode } from "./run-code";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

const result = (overrides: Partial<CodeRunResult> = {}): CodeRunResult => ({
  status: "success",
  phase: "run",
  stdout: "hello\n",
  stderr: "",
  compileStderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
  executionTimeMs: 42,
  ...overrides,
});

const jsonFetcher = (body: unknown, status = 200) =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;

describe("runCode", () => {
  it("posts the source and language to the run endpoint with the board token", async () => {
    const fetcher = jsonFetcher(result());

    const outcome = await runCode("print(1)", "python", { token: "tok", fetcher, runId: RUN_ID });

    expect(outcome).toMatchObject({ status: "success", stdout: "hello\n", executionTimeMs: 42 });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(CODE_RUN_PATH);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ runId: RUN_ID, language: "python", source: "print(1)" });
  });

  it("never sends a sandbox id — the server derives it from the token", async () => {
    // Accepting one from here would let any participant name another board's
    // container, so the request shape must not carry the field at all.
    const fetcher = jsonFetcher(result());
    await runCode("x", "python", { token: "tok", fetcher });
    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Object.keys(JSON.parse(init.body))).toEqual(["runId", "language", "source"]);
  });

  it("carries a compile failure through with its phase intact", async () => {
    const fetcher = jsonFetcher(result({
      status: "error",
      phase: "compile",
      stdout: "",
      stderr: "error[E0425]",
      exitCode: 1,
    }));

    const outcome = await runCode("fn main() { x }", "rust", { token: "tok", fetcher });

    expect(outcome.phase).toBe("compile");
    expect(outcome.stderr).toBe("error[E0425]");
  });

  it("refuses without a token instead of making a request that cannot succeed", async () => {
    const fetcher = jsonFetcher(result());

    const outcome = await runCode("print(1)", "python", { fetcher });

    expect(outcome.status).toBe("error");
    expect(outcome.stderr).toContain("permission");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "permission"],
    [403, "permission"],
    [429, "Too many runs"],
    [413, "too large"],
    [503, "unavailable"],
    [502, "failed"],
  ])("explains a %i without throwing", async (status, expected) => {
    const outcome = await runCode("print(1)", "python", {
      token: "tok",
      fetcher: jsonFetcher({ error: "nope" }, status),
    });

    expect(outcome.status).toBe("error");
    expect(outcome.stderr).toContain(expected);
  });

  it("reports a transport failure as a result rather than an exception", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const outcome = await runCode("print(1)", "python", { token: "tok", fetcher });

    expect(outcome.status).toBe("error");
    expect(outcome.stderr).toContain("Could not reach the code runner");
  });

  it("names a client-side timeout as one", async () => {
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    ) as unknown as typeof fetch;

    const outcome = await runCode("print(1)", "python", {
      token: "tok",
      fetcher,
      timeoutMs: 10,
    });

    expect(outcome.status).toBe("error");
    expect(outcome.stderr).toContain("did not respond in time");
  });

  it("does not blame the runner for a caller's own cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    ) as unknown as typeof fetch;

    const pending = runCode("print(1)", "python", {
      token: "tok",
      fetcher,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;

    expect(outcome.stderr).toContain("Could not reach the code runner");
    expect(outcome.stderr).not.toContain("did not respond in time");
  });

  it("rejects a response that does not match the contract", async () => {
    const outcome = await runCode("print(1)", "python", {
      token: "tok",
      fetcher: jsonFetcher({ status: "success" }),
    });

    expect(outcome.status).toBe("error");
    expect(outcome.stderr).toContain("unreadable");
  });

  it("rejects a body that is not JSON at all", async () => {
    const fetcher = vi.fn(async () => new Response("<html>502</html>", { status: 200 })) as
      unknown as typeof fetch;

    const outcome = await runCode("print(1)", "python", { token: "tok", fetcher });

    expect(outcome.stderr).toContain("unreadable");
  });
});

describe("cancelCodeRun", () => {
  it("sends an authenticated cancellation for the same run id", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await cancelCodeRun(RUN_ID, { token: "tok", fetcher });

    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(CODE_RUN_CANCEL_PATH);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ runId: RUN_ID });
  });
});
