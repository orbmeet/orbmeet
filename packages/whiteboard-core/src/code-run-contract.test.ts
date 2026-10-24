import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  CODE_COMPILE_TIMEOUT_MS,
  CODE_CONTAINER_START_ALLOWANCE_MS,
  CODE_RUN_LIFECYCLE_OVERHEAD_MS,
  CODE_RUN_REQUEST_TIMEOUT_MS,
  CODE_RUN_TIMEOUT_MS,
  CODE_RUNNER_BUDGET_MS,
  codeRunnerRequestSchema,
  codeSandboxIdForRoom,
  codeSandboxIdSchema,
} from "./code-run-contract.ts";

/** The longest sandbox name Cloudflare's sandbox tooling accepts. */
const SDK_SANDBOX_ID_MAX = 63;

describe("codeSandboxIdForRoom", () => {
  it("derives an id the runner's own schema accepts", () => {
    // The two are stated in one file so they cannot drift; this is the assertion
    // that says so. A derivation the schema rejects would fail as a 422 with no
    // indication that the caller did nothing wrong.
    return expect(
      codeSandboxIdForRoom("whiteboard_01hq").then((id) =>
        v.safeParse(codeSandboxIdSchema, id).success
      ),
    ).resolves.toBe(true);
  });

  it("stays inside the SDK's own ceiling", async () => {
    const id = await codeSandboxIdForRoom("w".repeat(64));
    expect(id.length).toBeLessThanOrEqual(SDK_SANDBOX_ID_MAX);
  });

  it("gives the same board the same container", async () => {
    const [first, second] = await Promise.all([
      codeSandboxIdForRoom("whiteboard_01hq"),
      codeSandboxIdForRoom("whiteboard_01hq"),
    ]);
    expect(first).toBe(second);
  });

  it("gives rooms that differ only in case different containers", async () => {
    // The regression this replaced: room ids may contain uppercase, and the id
    // was lowercased into its alphabet — so two boards shared one container and
    // the between-board boundary, the one that has to hold, did not.
    const [upper, lower] = await Promise.all([
      codeSandboxIdForRoom("Room_ABC"),
      codeSandboxIdForRoom("room_abc"),
    ]);
    expect(upper).not.toBe(lower);
  });

  it("gives rooms that differ only in punctuation different containers", async () => {
    const [dotted, dashed] = await Promise.all([
      codeSandboxIdForRoom("room.1"),
      codeSandboxIdForRoom("room-1"),
    ]);
    expect(dotted).not.toBe(dashed);
  });
});

describe("codeRunnerRequestSchema", () => {
  it("refuses a sandbox id this system did not derive", async () => {
    // The runner should only ever see a derived id. Anything else is a bug or an
    // intrusion, and either way not something to start a container for.
    const base = {
      runId: "00000000-0000-4000-8000-000000000001",
      language: "python",
      source: "print(1)",
    } as const;

    expect(v.safeParse(codeRunnerRequestSchema, {
      ...base,
      sandboxId: await codeSandboxIdForRoom("whiteboard_01hq"),
    }).success).toBe(true);

    for (const sandboxId of ["board-room_abc", "board-dev", "board-", "../etc", "BOARD-ABC"]) {
      expect(v.safeParse(codeRunnerRequestSchema, { ...base, sandboxId }).success).toBe(false);
    }
  });
});

describe("codeRunResultSchema", () => {
  it("reads a result from a runner that predates compile diagnostics", async () => {
    // The runner Worker deploys on its own schedule. A parse that required the
    // newer field would turn every run into "unreadable response" for as long as
    // the runner lagged the app.
    const { codeRunResultSchema } = await import("./code-run-contract.ts");
    const parsed = v.safeParse(codeRunResultSchema, {
      status: "success",
      phase: "run",
      stdout: "42\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      executionTimeMs: 9,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.output.compileStderr).toBe("");
  });
});

describe("the timeout ladder", () => {
  it("gives each rung more room than the one below it", () => {
    // The ordering is the whole point: a rung shorter than the one it contains
    // reports a run that is still working as a failure, and the browser giving up
    // first is how a user ends up with a client-side guess instead of the
    // server's own reason.
    expect(CODE_RUNNER_BUDGET_MS).toBeGreaterThan(
      CODE_CONTAINER_START_ALLOWANCE_MS + CODE_COMPILE_TIMEOUT_MS + CODE_RUN_TIMEOUT_MS,
    );
    expect(CODE_RUN_LIFECYCLE_OVERHEAD_MS).toBeGreaterThan(0);
    expect(CODE_RUN_REQUEST_TIMEOUT_MS).toBeGreaterThan(CODE_RUNNER_BUDGET_MS);
  });
});
