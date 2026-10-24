import {
  CODE_COMPILE_TIMEOUT_MS,
  CODE_CONTAINER_START_ALLOWANCE_MS,
  CODE_RUN_LIFECYCLE_OVERHEAD_MS,
  CODE_RUN_TIMEOUT_MS,
  CODE_RUNNER_BUDGET_MS,
  type CodeRunResult,
  type CodeRunnerRequest,
} from "@orbmeet/whiteboard-core/code-run-contract";
import {
  CELLRUN_PROBE,
  CELLRUN_SLOTS,
  CellrunExit,
  MAX_REPORT_BYTES,
  cellrunArgv,
  parseReport,
  reportComplete,
  toCodeRunResult,
} from "./cellrun";
import { RunTable } from "./run-table";

/**
 * How long a board's container stays up after its last run. Long enough that a
 * second run on the same board skips the container start, short enough that a
 * board left open overnight is not billed as if it were working.
 */
export const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1_000;

/**
 * How long one run's supervisor may take to report. Its phases stop
 * themselves at their own deadlines; this only bounds a supervisor that never
 * reports, which means the container cannot be trusted any more. The slot's
 * cleanup comes after the report and has its own deadline.
 */
export const REPORT_DEADLINE_MS = CODE_COMPILE_TIMEOUT_MS + CODE_RUN_TIMEOUT_MS
  + CODE_RUN_LIFECYCLE_OVERHEAD_MS;

/** How long starting a process in a running container may take. */
export const EXEC_DEADLINE_MS = 30_000;

/** How long a supervisor may spend cleaning its slot after reporting. */
const CLEANUP_DEADLINE_MS = 60_000;

const SIGTERM = 15;

/** The container operations a board uses: `ctx.container`, or a stand-in in tests. */
export type BoardContainer = Pick<
  Container,
  "running" | "start" | "exec" | "destroy" | "setInactivityTimeout"
>;

/**
 * What a run ends as, across the RPC boundary. Outcomes rather than thrown
 * errors, because an error crossing Durable Object RPC loses its prototype. A
 * throw is kept for what it really is: the runner failing, not the run.
 */
export type CodeRunOutcome =
  | { kind: "result"; result: CodeRunResult }
  | { kind: "busy" }
  | { kind: "cancelled" };

/** The runner failed this run; the caller can try again. */
export class RunnerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunnerUnavailableError";
  }
}

export interface BoardOptions {
  /** Keeps the slot-release bookkeeping alive past the request that started it. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Failures. */
  log?: (message: string, detail?: unknown) => void;
  /** What each container's kernel provides, once per container start. */
  info?: (message: string, detail?: unknown) => void;
}

/**
 * One board's code runner: its container and the runs in it.
 *
 * Each run is one `exec()` of cellrun in a free slot, with the source on
 * stdin and one report back on stdout. The container enforces every deadline
 * and stops every process itself; this side only decides which slot a run
 * gets and waits for the answer.
 *
 * When the answer does not come — a supervisor that never reports, a slot
 * that cannot be reset — the container is destroyed and the board starts over
 * on a fresh one. That is the only recovery path, and it is total: a fresh
 * container has no leftover processes, files or slots.
 */
export class Board {
  readonly #container: BoardContainer;
  readonly #table = new RunTable(CELLRUN_SLOTS, CODE_RUNNER_BUDGET_MS);
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #log: (message: string, detail?: unknown) => void;
  readonly #info: (message: string, detail?: unknown) => void;
  #starting: Promise<void> | null = null;

  constructor(container: BoardContainer, options: BoardOptions = {}) {
    this.#container = container;
    this.#waitUntil = options.waitUntil ?? ((promise) => void promise);
    this.#log = options.log ?? ((message, detail) => console.error(`[code-runner] ${message}`, detail ?? ""));
    this.#info = options.info ?? ((message, detail) => console.log(`[code-runner] ${message}`, detail ?? ""));
  }

  /** For tests: the state of each slot. */
  get slots() {
    return this.#table.slots;
  }

  async run(request: CodeRunnerRequest): Promise<CodeRunOutcome> {
    const { runId } = request;
    const admission = this.#table.admit(runId);
    if (admission.kind !== "admitted") return admission;
    const { slot, generation } = admission;

    let cleanup: { exited: boolean } | null = null;
    try {
      await this.#bounded(this.#ensureRunning(), CODE_CONTAINER_START_ALLOWANCE_MS, "the container did not start");
      if (generation !== this.#table.generation) {
        throw new RunnerUnavailableError("The container was replaced before the run began");
      }
      if (this.#table.isCancelled(runId)) return { kind: "cancelled" };

      const process = await this.#bounded(
        this.#container.exec(cellrunArgv(slot, request.language), {
          stdin: bytesStream(new TextEncoder().encode(request.source)),
          stdout: "pipe",
          stderr: "pipe",
        }),
        EXEC_DEADLINE_MS,
        "cellrun did not start",
      );
      // Drained from the start, so cellrun never blocks on a full pipe. It
      // closes only when cellrun exits, after the slot's cleanup.
      const diagnostics = readAll(process.stderr, 8 * 1024).catch(() => new Uint8Array(0));
      cleanup = this.#watchCleanup(process, diagnostics, slot, generation);
      // Held here as well as in the table: replacing the container clears the
      // table, and a run whose result is already on its way is not cancelled.
      let cancelled = false;
      const supervisor = {
        stop: () => {
          cancelled = true;
          stop(process);
        },
      };
      if (!this.#table.attach(runId, supervisor)) supervisor.stop();

      const report = await this.#bounded(readReport(process.stdout), REPORT_DEADLINE_MS, "cellrun did not report in time");

      // A run its caller cancelled is cancelled, whatever the container had
      // already finished: the caller asked for it to end, not for a result.
      if (cancelled) return { kind: "cancelled" };
      if (report.byteLength === 0) return await this.#withoutReport(process, diagnostics);
      const result = toCodeRunResult(parseReport(report), slot);
      if (!result) {
        throw new RunnerUnavailableError("cellrun reported no phase for a run that was not stopped");
      }
      return { kind: "result", result };
    } finally {
      // The slot stays taken while its supervisor is still cleaning it up.
      this.#table.finish(runId, generation, { draining: cleanup !== null && !cleanup.exited });
    }
  }

  /** Stops a run. False when no such run is in flight (it may arrive later). */
  cancel(runId: string): boolean {
    const { found, supervisor } = this.#table.cancel(runId);
    supervisor?.stop();
    return found;
  }

  /**
   * A supervisor that wrote no report exits right after, and its status says
   * why: the slot was held elsewhere, or the container is no longer fit.
   */
  async #withoutReport(process: ExecProcess, diagnostics: Promise<Uint8Array>): Promise<CodeRunOutcome> {
    const code = await withDeadline(process.exitCode, 5_000).catch(() => null);
    const detail = await afterExit(diagnostics);
    if (code === CellrunExit.SlotBusy) return { kind: "busy" };
    if (code === CellrunExit.JailUnavailable) {
      // Not this container's fault, so not replaced: a new one would run on the
      // same kernel. The probe logged at its start says what is missing.
      this.#log("this machine cannot enforce the jail; no run can start", detail);
      throw new RunnerUnavailableError("The sandbox cannot be enforced on this machine");
    }
    this.#log("cellrun failed without a report", { code, detail });
    throw new RunnerUnavailableError(`cellrun exited with ${code ?? "no status"}`);
  }

  /**
   * Frees the slot when its supervisor exits. A supervisor that says the
   * container is unfit, or never exits, gets the container replaced. The
   * returned flag says whether the exit has happened yet, which `run` needs:
   * it may come before or after the run itself is finished.
   */
  #watchCleanup(
    process: ExecProcess,
    diagnostics: Promise<Uint8Array>,
    slot: number,
    generation: number,
  ): { exited: boolean } {
    const state = { exited: false };
    const settled = withDeadline(process.exitCode, REPORT_DEADLINE_MS + CLEANUP_DEADLINE_MS)
      .then(async (code) => {
        if (code === CellrunExit.ReplaceContainer && generation === this.#table.generation) {
          await this.#replaceContainer("cellrun could not reset its slot", await afterExit(diagnostics));
        }
      }, async (error: unknown) => {
        if (generation === this.#table.generation) await this.#replaceContainer("cellrun never exited", error);
      })
      .finally(() => {
        state.exited = true;
        this.#table.release(slot, generation);
      });
    this.#waitUntil(settled);
    return state;
  }

  /**
   * Every wait on the container is bounded. One that runs out means the
   * container can no longer be trusted to answer, so it is replaced.
   */
  async #bounded<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
    try {
      return await withDeadline(promise, ms);
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error;
      await this.#replaceContainer(reason);
      throw new RunnerUnavailableError(reason, { cause: error });
    }
  }

  async #replaceContainer(reason: string, cause?: unknown): Promise<void> {
    this.#log(`replacing the container: ${reason}`, cause);
    this.#table.reset();
    this.#starting = null;
    try {
      await this.#container.destroy(reason);
    } catch (error) {
      this.#log("destroying the container failed", error);
    }
  }

  /** Logs what this container's kernel provides. Best effort: runs never wait on it. */
  async #probe(): Promise<void> {
    try {
      const process = await withDeadline(this.#container.exec(CELLRUN_PROBE, { stdout: "pipe", stderr: "pipe" }), 10_000);
      const [report] = await withDeadline(
        Promise.all([readAll(process.stdout, 8 * 1024), readAll(process.stderr, 1024)]),
        10_000,
      );
      this.#info("container probe", new TextDecoder().decode(report));
    } catch (error) {
      this.#log("the container probe failed", error);
    }
  }

  /**
   * Starts the container if it is not running, once for any number of runs
   * that arrive while it starts. The attempt is cleared when it settles, and
   * only if it is still the current one, so a failed start is retried by the
   * next run rather than remembered.
   */
  #ensureRunning(): Promise<void> {
    if (this.#container.running) return Promise.resolve();
    if (!this.#starting) {
      const attempt = (async () => {
        if (!this.#container.running) this.#container.start({ enableInternet: false });
        await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        this.#waitUntil(this.#probe());
      })();
      this.#starting = attempt;
      const clear = () => {
        if (this.#starting === attempt) this.#starting = null;
      };
      attempt.then(clear, clear);
    }
    return this.#starting;
  }
}

function stop(process: ExecProcess): void {
  try {
    process.kill(SIGTERM);
  } catch {
    // Already exited: there is nothing left to stop.
  }
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Reads cellrun's report, refusing more than any report can be. It is over at
 * its `end` record: cellrun closes its stdout there, but the stream may end
 * only when cellrun exits, after the slot's cleanup — which has its own
 * deadline, and is no reason to doubt a report already written.
 */
export async function readReport(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  let bytes = new Uint8Array(64 * 1024);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_REPORT_BYTES) {
        throw new RunnerUnavailableError(`cellrun wrote more than ${MAX_REPORT_BYTES} bytes`);
      }
      if (length + value.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(MAX_REPORT_BYTES, Math.max(bytes.byteLength * 2, length + value.byteLength)));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length += value.byteLength;
      if (reportComplete(bytes.subarray(0, length))) break;
    }
  } finally {
    // Nothing follows a whole report; an unread remainder is only held open.
    await reader.cancel().catch(() => undefined);
  }
  return bytes.slice(0, length);
}

/** Reads a stream to its end, keeping its first `maxBytes` and draining the rest. */
export async function readAll(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - length;
    if (room <= 0) continue;
    const kept = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(kept);
    length += kept.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A supervisor's stderr once it has exited, which is when the stream ends. */
async function afterExit(diagnostics: Promise<Uint8Array>): Promise<string> {
  const bytes = await withDeadline(diagnostics, 5_000).catch(() => new Uint8Array(0));
  return new TextDecoder().decode(bytes);
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`No answer within ${ms}ms`);
    this.name = "DeadlineError";
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
