import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeRunnerRunIdFor,
  codeSandboxIdForRoom,
  MAX_CODE_RUN_STREAM_BYTES,
  type CodeRunResult,
} from "@orbmeet/whiteboard-core/code-run-contract";

const verifyActiveWhiteboardBearerMock = vi.fn();

vi.mock("@orbmeet/db", () => ({ createDb: () => ({}) }));

vi.mock("@/modules/whiteboards/server/http/active-whiteboard-auth", () => ({
  verifyActiveWhiteboardBearer: verifyActiveWhiteboardBearerMock,
}));

vi.mock("@/lib/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const { handleCancelCodeRun, handleRunCode } = await import(
  "@/modules/whiteboards/server/http/run-code"
);

const RUN_ID = "00000000-0000-4000-8000-000000000001";
/** The id the runner knows user-1's run by. */
const RUNNER_RUN_ID = await codeRunnerRunIdFor("user:user-1", RUN_ID);

const RESULT: CodeRunResult = {
  status: "success",
  phase: "run",
  stdout: "hello\n",
  stderr: "",
  compileStderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
  executionTimeMs: 12,
};

function runnerFetch(body: unknown = RESULT, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {},
    ENVIRONMENT: "production",
    CODE_RUN_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CODE_RUNNER: { fetch: runnerFetch() },
    CODE_RUNNER_SECRET: "shared-secret",
    ...overrides,
  } as unknown as Env;
}

function request(body: unknown = { language: "python", source: "print(1)" }, init: RequestInit = {}) {
  return new Request("https://orbmeet.com/api/whiteboard/run-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    body: typeof body === "string" ? body : JSON.stringify({ runId: RUN_ID, ...(body as object) }),
    ...init,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyActiveWhiteboardBearerMock.mockResolvedValue({
    meetingId: "meet-1",
    syncRoomId: "Room_ABC",
    token: "tok",
    access: {
      canEditWhiteboard: true,
      userId: "user-1",
      participantIdentity: "user-1",
      billingPrincipalType: "user",
      billingPrincipalId: "user-1",
      grantPrincipal: { type: "user", id: "user-1" },
    },
  });
});

describe("handleRunCode", () => {
  it("proxies an authorized run and returns the runner's result", async () => {
    const env = testEnv();

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(RESULT);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("derives the sandbox id from the verified token, not the request", async () => {
    // The whole isolation model rests on this: a client-supplied id would let
    // any participant reach another board's container.
    const env = testEnv();
    const response = await handleRunCode(
      request({ language: "python", source: "print(1)", sandboxId: "board-someone-else" }),
      env,
    );

    // `sandboxId` is not part of the browser's schema, so the body is rejected
    // outright rather than quietly ignored.
    expect(response.status).toBe(422);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("sends the room's own sandbox id and the shared secret to the runner", async () => {
    const env = testEnv();

    await handleRunCode(request(), env);

    const [, init] = (env.CODE_RUNNER.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Code-Runner-Secret"]).toBe("shared-secret");
    expect(JSON.parse(init.body)).toEqual({
      runId: RUNNER_RUN_ID,
      language: "python",
      source: "print(1)",
      sandboxId: await codeSandboxIdForRoom("Room_ABC"),
    });
  });

  it("gives rooms that differ only in case different containers", async () => {
    // The boundary between boards is the one this system cannot get wrong, and
    // folding room ids into a restricted alphabet used to be able to: the room
    // id validator admits uppercase, and lowercasing it made two rooms one.
    const env = testEnv();

    await handleRunCode(request(), env);
    verifyActiveWhiteboardBearerMock.mockResolvedValue({
      meetingId: "meet-1",
      syncRoomId: "room_abc",
      token: "tok",
      access: {
        canEditWhiteboard: true,
        userId: "user-1",
        participantIdentity: "user-1",
        billingPrincipalType: "user",
        billingPrincipalId: "user-1",
        grantPrincipal: { type: "user", id: "user-1" },
      },
    });
    await handleRunCode(request(), env);

    const calls = (env.CODE_RUNNER.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const first = JSON.parse(calls[0][1].body).sandboxId;
    const second = JSON.parse(calls[1][1].body).sandboxId;
    expect(first).not.toBe(second);
  });

  it("passes an authentication failure through untouched", async () => {
    verifyActiveWhiteboardBearerMock.mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const env = testEnv();

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(401);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("refuses a participant who cannot edit the board", async () => {
    // A run writes its output to a synced shape, so it is an edit.
    verifyActiveWhiteboardBearerMock.mockResolvedValue({
      meetingId: "meet-1",
      syncRoomId: "Room_ABC",
      token: "tok",
      access: {
        canEditWhiteboard: false,
        userId: "user-1",
        participantIdentity: "user-1",
        billingPrincipalType: "user",
        billingPrincipalId: "user-1",
        grantPrincipal: { type: "user", id: "user-1" },
      },
    });
    const env = testEnv();

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(403);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("rate limits per participant rather than per address", async () => {
    const env = testEnv();

    await handleRunCode(request(), env);

    expect(env.CODE_RUN_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: "run-code:user:user-1",
    });
  });

  it("answers 429 once the limiter refuses, before any container is touched", async () => {
    const env = testEnv({
      CODE_RUN_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
    });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(429);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("rejects a language the runner has no toolchain for", async () => {
    const env = testEnv();
    const response = await handleRunCode(
      request({ language: "json", source: "{}" }),
      env,
    );

    expect(response.status).toBe(422);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("rejects source past the shape's own cap", async () => {
    const env = testEnv();
    const response = await handleRunCode(
      request({ language: "python", source: "x".repeat(50_001) }),
      env,
    );
    expect(response.status).toBe(422);
  });

  it("rejects a body too large to read", async () => {
    const env = testEnv();
    const response = await handleRunCode(
      request({ language: "python", source: "x".repeat(400_000) }),
      env,
    );
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON", async () => {
    const response = await handleRunCode(request("{not json"), testEnv());
    expect(response.status).toBe(400);
  });

  it("requires a JSON content type", async () => {
    const response = await handleRunCode(
      new Request("https://orbmeet.com/api/whiteboard/run-code", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: "Bearer tok" },
        body: "print(1)",
      }),
      testEnv(),
    );
    expect(response.status).toBe(415);
  });

  it("says plainly that execution is unavailable when the runner is not bound", async () => {
    // The ordinary state of a local dev server with no runner Worker running.
    const response = await handleRunCode(request(), testEnv({ CODE_RUNNER: undefined }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("not available"),
    });
  });

  it("treats a missing shared secret as unavailable rather than calling unauthenticated", async () => {
    const env = testEnv({ CODE_RUNNER_SECRET: undefined });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(503);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("reports a runner error as a gateway failure, not as program output", async () => {
    const env = testEnv({ CODE_RUNNER: { fetch: runnerFetch({ error: "boom" }, 503) } });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(502);
  });

  it("passes the runner's own busy signal through as one", async () => {
    // The board is at its concurrency cap. Reported as a gateway failure this
    // would tell the user the runner is broken, when the honest answer is the
    // same one the per-participant limiter gives: wait a moment.
    const env = testEnv({
      CODE_RUNNER: { fetch: runnerFetch({ error: "This board is already running code" }, 429) },
    });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(429);
  });

  it("passes a cancelled run through as cancelled, not as a runner fault", async () => {
    const env = testEnv({
      CODE_RUNNER: { fetch: runnerFetch({ error: "Run cancelled" }, 409) },
    });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(409);
  });

  it("accepts the largest result a run can produce", async () => {
    // Every stream at its cap, all control characters: JSON escapes each into
    // six bytes. The gateway's bound is derived from exactly this case.
    const control = "\u0001".repeat(MAX_CODE_RUN_STREAM_BYTES);
    const result = {
      status: "error",
      phase: "run",
      stdout: control,
      stderr: control,
      compileStderr: control,
      exitCode: 137,
      timedOut: true,
      truncated: true,
      executionTimeMs: 10_000,
    };
    const env = testEnv({ CODE_RUNNER: { fetch: runnerFetch(result) } });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(200);
  });

  it("reports a runner that threw as a gateway failure", async () => {
    const env = testEnv({
      CODE_RUNNER: { fetch: vi.fn(async () => { throw new Error("no route"); }) },
    });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(502);
  });

  it("preserves URL-only timeouts and forwards cancellation", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new DOMException("deadline", "TimeoutError"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const env = testEnv({
        CODE_RUNNER: undefined,
        CODE_RUNNER_URL: "http://127.0.0.1:8799",
      });
      const response = await handleRunCode(request(), env);

      expect(response.status).toBe(504);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe("http://127.0.0.1:8799/cancel");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The shared secret rides on every runner request, so a plaintext URL to
  // another host would put it on the wire. Loopback (above) never leaves the
  // machine and stays allowed; this must fall back to the binding instead.
  it("ignores a plaintext CODE_RUNNER_URL pointing off-host", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const env = testEnv({ CODE_RUNNER_URL: "http://runner.example.com:8799" });
      const response = await handleRunCode(request(), env);

      // The service binding answered, not the configured URL.
      expect(fetch).not.toHaveBeenCalled();
      expect(response.status).not.toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the container process when the runner request times out", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new DOMException("deadline", "TimeoutError"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const env = testEnv({ CODE_RUNNER: { fetch } });

    const response = await handleRunCode(request(), env);

    expect(response.status).toBe(504);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("https://code-runner.internal/cancel");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      runId: RUNNER_RUN_ID,
      sandboxId: await codeSandboxIdForRoom("Room_ABC"),
    });
  });
});

describe("handleCancelCodeRun", () => {
  it("cancels a URL-only run using its full run identity", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const env = testEnv({
        CODE_RUNNER: undefined,
        CODE_RUNNER_URL: "http://127.0.0.1:8799",
      });

      const response = await handleCancelCodeRun(request({ runId: RUN_ID }), env);

      expect(response.status).toBe(204);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:8799/cancel");
      expect(init.headers).toMatchObject({ "X-Code-Runner-Secret": "shared-secret" });
      expect(JSON.parse(init.body as string)).toEqual({
        runId: RUNNER_RUN_ID,
        sandboxId: await codeSandboxIdForRoom("Room_ABC"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards an authenticated cancellation to the caller's board", async () => {
    const env = testEnv({
      CODE_RUNNER: { fetch: vi.fn(async () => new Response(null, { status: 204 })) },
    });
    const response = await handleCancelCodeRun(request({ runId: RUN_ID }), env);

    expect(response.status).toBe(204);
    const [url, init] = (env.CODE_RUNNER.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://code-runner.internal/cancel");
    expect(JSON.parse(init.body)).toEqual({
      runId: RUNNER_RUN_ID,
      sandboxId: await codeSandboxIdForRoom("Room_ABC"),
    });
  });

  it("refuses a viewer: cancelling is part of running code", async () => {
    verifyActiveWhiteboardBearerMock.mockResolvedValue({
      meetingId: "meet-1",
      syncRoomId: "Room_ABC",
      token: "tok",
      access: {
        canEditWhiteboard: false,
        userId: "viewer",
        participantIdentity: "viewer",
        billingPrincipalType: "user",
        billingPrincipalId: "viewer",
        grantPrincipal: { type: "user", id: "viewer" },
      },
    });
    const env = testEnv();

    const response = await handleCancelCodeRun(request({ runId: RUN_ID }), env);

    expect(response.status).toBe(403);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });

  it("reaches only the caller's own run, whatever run id another editor sends", async () => {
    verifyActiveWhiteboardBearerMock.mockResolvedValue({
      meetingId: "meet-1",
      syncRoomId: "Room_ABC",
      token: "tok",
      access: {
        canEditWhiteboard: true,
        userId: null,
        participantIdentity: "guest_1",
        billingPrincipalType: "user",
        billingPrincipalId: "user-1",
        grantPrincipal: { type: "guest_admission", id: "adm_1" },
      },
    });
    const env = testEnv({
      CODE_RUNNER: { fetch: vi.fn(async () => new Response(null, { status: 204 })) },
    });

    await handleCancelCodeRun(request({ runId: RUN_ID }), env);

    const [, init] = (env.CODE_RUNNER.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).runId).not.toBe(RUNNER_RUN_ID);
  });

  it("does not expose cancellation without a valid board token", async () => {
    verifyActiveWhiteboardBearerMock.mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const env = testEnv();

    const response = await handleCancelCodeRun(request({ runId: RUN_ID }), env);

    expect(response.status).toBe(401);
    expect(env.CODE_RUNNER.fetch).not.toHaveBeenCalled();
  });
});
