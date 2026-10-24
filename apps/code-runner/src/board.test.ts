import { CODE_RUN_TIMEOUT_MS } from "@orbmeet/whiteboard-core/code-run-contract";
import type { CodeLanguage } from "@orbmeet/whiteboard-core/code-shape-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board, EXEC_DEADLINE_MS, REPORT_DEADLINE_MS, RunnerUnavailableError, type BoardContainer } from "./board";
import { CELLRUN_SLOTS, MAX_REPORT_BYTES, cellrunArgv } from "./cellrun";

const encoder = new TextEncoder();

/** A report as cellrun.c writes it, for one phase that ran. */
function report(run: { stdout?: string; ended?: string; exit?: number } = {}, stopped = false): Uint8Array {
  const records: [string, string][] = [
    ["run.ended", run.ended ?? "exit"],
    ["run.exit", String(run.exit ?? 0)],
    ["run.ms", "12"],
    ["run.truncated", "0"],
    ["run.stdout", run.stdout ?? "ok\n"],
    ["run.stderr", ""],
    ["stopped", stopped ? "1" : "0"],
    ["end", ""],
  ];
  return encoder.encode(`cellrun 1\n${records.map(([key, value]) =>
    `${key} ${encoder.encode(value).byteLength}\n${value}\n`
  ).join("")}`);
}

/** One `exec()` of cellrun, driven by the test. */
class FakeSupervisor {
  readonly signals: number[] = [];
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #stderr!: ReadableStreamDefaultController<Uint8Array>;
  #exit!: (code: number) => void;
  readonly process: ExecProcess;

  constructor(readonly argv: string[], readonly source: Promise<string>) {
    const stdout = new ReadableStream<Uint8Array>({ start: (controller) => void (this.#stdout = controller) });
    const stderr = new ReadableStream<Uint8Array>({ start: (controller) => void (this.#stderr = controller) });
    const exitCode = new Promise<number>((resolve) => void (this.#exit = resolve));
    this.process = {
      stdin: null,
      stdout,
      stderr,
      pid: 4242,
      isPty: false,
      exitCode,
      output: () => Promise.reject(new Error("unused")),
      kill: (signal = 15) => void this.signals.push(signal),
      resize: () => {},
    };
  }

  /** Writes to stdout without closing it, as a transport may hold it open. */
  write(bytes: Uint8Array) {
    this.#stdout.enqueue(bytes);
  }

  /**
   * Writes a report and closes stdout, as cellrun does before cleaning up;
   * stderr stays open until it exits.
   */
  report(bytes: Uint8Array, diagnostics = "") {
    if (bytes.byteLength) this.#stdout.enqueue(bytes);
    if (diagnostics) this.#stderr.enqueue(encoder.encode(diagnostics));
    this.#stdout.close();
  }

  exit(code: number, diagnostics = "") {
    if (diagnostics) this.#stderr.enqueue(encoder.encode(diagnostics));
    this.#stderr.close();
    this.#exit(code);
  }
}

class FakeContainer implements BoardContainer {
  running = false;
  starts = 0;
  readonly destroyed: string[] = [];
  readonly supervisors: FakeSupervisor[] = [];
  startImpl: () => void = () => void (this.running = true);
  inactivity: () => Promise<void> = async () => {};
  /** Called for every exec, to script the supervisor's behaviour. */
  onExec: (supervisor: FakeSupervisor) => void = (supervisor) => {
    supervisor.report(report());
    supervisor.exit(0);
  };

  start() {
    this.starts += 1;
    this.startImpl();
  }

  setInactivityTimeout() {
    return this.inactivity();
  }

  async destroy(reason?: unknown) {
    this.destroyed.push(String(reason));
    this.running = false;
  }

  probes = 0;

  async exec(argv: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    if (!this.running) throw new Error("container is not running");
    if (argv[1] === "--probe") {
      this.probes += 1;
      const probe = new FakeSupervisor(argv, Promise.resolve(""));
      queueMicrotask(() => {
        probe.report(encoder.encode("landlock unavailable (Function not implemented)\n"));
        probe.exit(0);
      });
      return probe.process;
    }
    const stdin = options?.stdin;
    const source = stdin instanceof ReadableStream ? new Response(stdin).text() : Promise.resolve("");
    const supervisor = new FakeSupervisor(argv, source);
    this.supervisors.push(supervisor);
    queueMicrotask(() => this.onExec(supervisor));
    return supervisor.process;
  }
}

function setup() {
  const container = new FakeContainer();
  const pending: Promise<unknown>[] = [];
  const info: string[] = [];
  const logs: [string, unknown][] = [];
  const board = new Board(container, {
    waitUntil: (promise) => void pending.push(promise),
    log: (message, detail) => void logs.push([message, detail]),
    info: (message, detail) => void info.push(`${message}: ${String(detail)}`),
  });
  const run = (runId: string = crypto.randomUUID(), language: CodeLanguage = "python", source = 'print("ok")') =>
    board.run({ runId, language, source, sandboxId: "board-2cb5ddf410150fdff33e0d2840a0481f" });
  const settled = () => Promise.allSettled(pending);
  return { container, board, run, settled, info, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Board", () => {
  it("runs a cell as one cellrun exec, with the source on stdin", async () => {
    const { container, run } = setup();

    const outcome = await run("r1", "go", 'package main\nfunc main(){ println("hi") }');

    expect(outcome).toMatchObject({ kind: "result", result: { status: "success", stdout: "ok\n" } });
    expect(container.supervisors).toHaveLength(1);
    expect(container.supervisors[0]?.argv).toEqual(cellrunArgv(0, "go"));
    expect(await container.supervisors[0]?.source).toBe('package main\nfunc main(){ println("hi") }');
  });

  it("logs what the kernel provides, once per container start", async () => {
    const { container, run, settled, info } = setup();
    await Promise.all([run(), run()]);
    await settled();
    expect(container.probes).toBe(1);
    expect(info).toEqual(["container probe: landlock unavailable (Function not implemented)\n"]);
  });

  it("starts the container once for runs that arrive together", async () => {
    const { container, run } = setup();
    await Promise.all([run(), run(), run()]);
    expect(container.starts).toBe(1);
  });

  it("retries a container start that threw synchronously", async () => {
    // The start used to be remembered as failed for the life of the object.
    const { container, run } = setup();
    container.startImpl = () => {
      throw new Error("no capacity");
    };
    await expect(run()).rejects.toThrow("no capacity");

    container.startImpl = () => void (container.running = true);
    await expect(run()).resolves.toMatchObject({ kind: "result" });
    expect(container.starts).toBe(2);
  });

  it("retries a container start that failed later", async () => {
    const { container, run } = setup();
    container.inactivity = () => Promise.reject(new Error("transient"));
    await expect(run()).rejects.toThrow("transient");
    container.inactivity = async () => {};
    await expect(run()).resolves.toMatchObject({ kind: "result" });
  });

  it("gives concurrent runs different slots and refuses one past the limit", async () => {
    const { container, run } = setup();
    container.onExec = () => {};
    const runs = Array.from({ length: CELLRUN_SLOTS }, () => run());
    await vi.waitFor(() => expect(container.supervisors).toHaveLength(CELLRUN_SLOTS));

    expect(container.supervisors.map((supervisor) => supervisor.argv[1]).sort()).toEqual(["0", "1", "2"]);
    await expect(run()).resolves.toEqual({ kind: "busy" });

    for (const supervisor of container.supervisors) {
      supervisor.report(report());
      supervisor.exit(0);
    }
    await Promise.all(runs);
  });

  describe("slots", () => {
    it("holds a slot until its supervisor has cleaned it, not just until the result", async () => {
      const { container, board, run, settled } = setup();
      container.onExec = (supervisor) => supervisor.report(report());

      await expect(run()).resolves.toMatchObject({ kind: "result" });
      expect(board.slots).toEqual(["draining", "free", "free"]);

      container.supervisors[0]?.exit(0);
      await settled();
      expect(board.slots).toEqual(["free", "free", "free"]);
    });

    it("takes the report at its end record, however long the slot's cleanup keeps the streams open", async () => {
      // cellrun cleans the slot after reporting, and its stderr, and on some
      // transports its stdout, end only when it exits. A snippet that left a
      // slow tree to delete must not push its report past the deadline.
      vi.useFakeTimers();
      const { container, board, run, settled } = setup();
      container.onExec = (supervisor) => supervisor.write(report({ stdout: "done\n" }));

      await expect(run()).resolves.toMatchObject({ kind: "result", result: { stdout: "done\n" } });
      await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS + 1);
      expect(container.destroyed).toEqual([]);
      expect(board.slots).toEqual(["draining", "free", "free"]);

      container.supervisors[0]?.exit(0);
      await settled();
      expect(board.slots).toEqual(["free", "free", "free"]);
    });

    it("frees the slot when the supervisor exits before the run has finished", async () => {
      const { board, run, settled } = setup();
      await run();
      await settled();
      expect(board.slots).toEqual(["free", "free", "free"]);
    });

    it("answers busy when the container still holds the slot for someone else", async () => {
      const { container, board, run, settled } = setup();
      container.onExec = (supervisor) => {
        supervisor.report(new Uint8Array(0), "cellrun: slot 0 is still held\n");
        supervisor.exit(75);
      };
      await expect(run()).resolves.toEqual({ kind: "busy" });
      await settled();
      expect(board.slots).toEqual(["free", "free", "free"]);
      expect(container.destroyed).toEqual([]);
    });
  });

  describe("stopping", () => {
    it("stops the supervisor and ends the run as cancelled", async () => {
      const { container, board, run } = setup();
      container.onExec = () => {};
      const outcome = run("r1");
      await vi.waitFor(() => expect(container.supervisors).toHaveLength(1));

      expect(board.cancel("r1")).toBe(true);
      const supervisor = container.supervisors[0];
      expect(supervisor.signals).toEqual([15]);
      supervisor.report(report({ ended: "stopped", exit: 137 }, true));
      supervisor.exit(0);

      await expect(outcome).resolves.toEqual({ kind: "cancelled" });
    });

    it("ends a cancelled run as cancelled even when its program had already finished", async () => {
      const { container, board, run } = setup();
      container.onExec = () => {};
      const outcome = run("r1");
      await vi.waitFor(() => expect(container.supervisors).toHaveLength(1));

      board.cancel("r1");
      container.supervisors[0]?.report(report({ stdout: "finished anyway" }));
      container.supervisors[0]?.exit(0);
      await expect(outcome).resolves.toEqual({ kind: "cancelled" });
    });

    it("does not start the supervisor for a run cancelled while the container started", async () => {
      const { container, board, run } = setup();
      let started!: () => void;
      container.inactivity = () => new Promise((resolve) => void (started = resolve));
      const outcome = run("r1");
      await vi.waitFor(() => expect(container.starts).toBe(1));

      board.cancel("r1");
      started();
      await expect(outcome).resolves.toEqual({ kind: "cancelled" });
      expect(container.supervisors).toEqual([]);
    });

    it("does not even start the container for a run whose cancel arrived first", async () => {
      const { container, board, run } = setup();
      expect(board.cancel("r1")).toBe(false);
      await expect(run("r1")).resolves.toEqual({ kind: "cancelled" });
      expect(container.starts).toBe(0);
    });
  });

  describe("an unfit container", () => {
    it("is replaced when the supervisor cannot reset its slot", async () => {
      const { container, board, run, settled } = setup();
      container.onExec = (supervisor) => {
        supervisor.report(new Uint8Array(0), "cellrun: slot 0: processes survived SIGKILL\n");
        supervisor.exit(70);
      };

      await expect(run()).rejects.toBeInstanceOf(RunnerUnavailableError);
      await settled();
      expect(container.destroyed).toHaveLength(1);
      expect(board.slots).toEqual(["free", "free", "free"]);
    });

    it("is replaced after the result when cleanup is what failed, saying why", async () => {
      const { container, run, settled, logs } = setup();
      container.onExec = (supervisor) => {
        supervisor.report(report());
        supervisor.exit(70, "cellrun: slot 0: could not remove /cells/0\n");
      };

      await expect(run()).resolves.toMatchObject({ kind: "result" });
      await settled();
      expect(container.destroyed).toHaveLength(1);
      expect(logs).toContainEqual([
        "replacing the container: cellrun could not reset its slot",
        "cellrun: slot 0: could not remove /cells/0\n",
      ]);
    });

    it("is replaced when the supervisor never reports, and every slot starts over", async () => {
      vi.useFakeTimers();
      const { container, board, run } = setup();
      container.onExec = () => {};
      // Caught now, so the rejection is handled while the timers advance.
      const failure = run().catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS - 1);
      expect(container.destroyed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await failure).toBeInstanceOf(RunnerUnavailableError);
      expect(container.destroyed).toHaveLength(1);
      expect(board.slots).toEqual(["free", "free", "free"]);
      // The phase deadlines are the container's; this one is only the backstop.
      expect(REPORT_DEADLINE_MS).toBeGreaterThan(CODE_RUN_TIMEOUT_MS);
    });

    it("is replaced when it cannot even start the supervisor", async () => {
      vi.useFakeTimers();
      const { container, board, run } = setup();
      container.running = true;
      container.exec = () => new Promise(() => {});
      const failure = run().catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(EXEC_DEADLINE_MS);
      expect(await failure).toBeInstanceOf(RunnerUnavailableError);
      expect(container.destroyed).toEqual(["cellrun did not start"]);
      expect(board.slots).toEqual(["free", "free", "free"]);
    });

    it("is not replaced when the machine cannot enforce the jail at all", async () => {
      // A new container would run on the same kernel: replacing it would only
      // turn every attempt into a cold start.
      const { container, run, settled } = setup();
      container.onExec = (supervisor) => {
        supervisor.report(new Uint8Array(0), "cellrun: seccomp cannot be enforced here\n");
        supervisor.exit(69);
      };
      await expect(run()).rejects.toThrow(/cannot be enforced/);
      await settled();
      expect(container.destroyed).toEqual([]);
    });

    it("is not replaced for a report it cannot read", async () => {
      const { container, run } = setup();
      container.onExec = (supervisor) => {
        supervisor.report(new Uint8Array(MAX_REPORT_BYTES + 1));
        supervisor.exit(0);
      };
      await expect(run()).rejects.toBeInstanceOf(RunnerUnavailableError);

      container.onExec = (supervisor) => {
        supervisor.report(encoder.encode("not a report"));
        supervisor.exit(0);
      };
      await expect(run()).rejects.toThrow(/header/);
      expect(container.destroyed).toEqual([]);
    });
  });
});
