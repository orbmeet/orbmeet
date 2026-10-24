import * as v from "valibot";
import { CODE_LANGUAGES, MAX_CODE_CHARS } from "./code-shape-schema.ts";
import { sha256Hex } from "./crypto-utils.ts";

/** Stable endpoint the whiteboard posts a code cell's source to. */
export const CODE_RUN_PATH = "/api/whiteboard/run-code";
/** Cancels one in-flight run started through `CODE_RUN_PATH`. */
export const CODE_RUN_CANCEL_PATH = "/api/whiteboard/cancel-code-run";

/**
 * The bound the runner applies to each captured stream before the response is
 * built. Well above `MAX_CODE_OUTPUT_CHARS` — the shape's own display bound is
 * applied last, after every section has been merged, so clipping here would
 * decide that contest early and in the wrong place.
 */
export const MAX_CODE_RUN_STREAM_BYTES = 64 * 1024;

/**
 * Wall-clock ceilings the runner enforces per phase. Compilation gets the
 * larger budget because a cold `rustc` or `javac` genuinely spends seconds
 * there; a program that runs for ten is a runaway loop, not slow arithmetic.
 */
export const CODE_COMPILE_TIMEOUT_MS = 20_000;
export const CODE_RUN_TIMEOUT_MS = 10_000;

/**
 * What a first run on an idle board may spend before either phase begins:
 * starting a container and pulling a multi-gigabyte toolchain image.
 */
export const CODE_CONTAINER_START_ALLOWANCE_MS = 120_000;
/**
 * Everything a run spends in the container outside its two phases: waiting for
 * its slot, resetting it, copying Go's build cache, and draining output after
 * a phase is stopped. The runner gives up on a container that takes longer.
 */
export const CODE_RUN_LIFECYCLE_OVERHEAD_MS = 30_000;

/**
 * One ladder, derived rather than chosen three times, because the ordering is
 * the point: each rung must outlive the one below it.
 *
 * `CODE_RUNNER_BUDGET_MS` is everything a legitimate run can need, and bounds
 * the web Worker's whole call to the runner — the request *and* reading its
 * body, not each separately, or the real ceiling would be twice the number
 * written here. The browser then allows a little more than the server does, so
 * a run that overruns ends as the server's own 504 with a reason, rather than
 * as a client-side guess about a request the server is still working on.
 */
export const CODE_RUNNER_BUDGET_MS = CODE_CONTAINER_START_ALLOWANCE_MS
  + CODE_COMPILE_TIMEOUT_MS
  + CODE_RUN_TIMEOUT_MS
  + CODE_RUN_LIFECYCLE_OVERHEAD_MS;
export const CODE_RUN_REQUEST_TIMEOUT_MS = CODE_RUNNER_BUDGET_MS + 10_000;

/**
 * The largest serialized `CodeRunResult`, derived rather than guessed. A result
 * carries at most three captured streams (`stdout`, `stderr`, `compileStderr`),
 * each at most `MAX_CODE_RUN_STREAM_BYTES`, and JSON writes a control byte as
 * a six-byte `\u00XX` escape. The rest — the other fields and a deadline
 * notice — is small and fixed. A gateway that read less than this would turn
 * a run that respected every cap into a "too much data" error.
 */
export const MAX_CODE_RUN_RESPONSE_BYTES = 3 * 6 * MAX_CODE_RUN_STREAM_BYTES + 4 * 1024;

export const codeRunIdSchema = v.pipe(v.string(), v.uuid());

const codeRunRequestEntries = {
  runId: codeRunIdSchema,
  language: v.picklist(CODE_LANGUAGES),
  source: v.pipe(v.string(), v.maxLength(MAX_CODE_CHARS)),
};

export const codeRunRequestSchema = v.strictObject(codeRunRequestEntries);

export type CodeRunRequest = v.InferOutput<typeof codeRunRequestSchema>;

export const codeRunCancelRequestSchema = v.strictObject({
  runId: codeRunIdSchema,
});

export type CodeRunCancelRequest = v.InferOutput<typeof codeRunCancelRequestSchema>;

/**
 * Which phase produced this result. The distinction is the whole reason
 * compiling is a separate `exec` from running: a compiler's diagnostics are
 * about the source in front of the author, and labelling them "output" — as a
 * combined `sh -c 'compile && run'` would have to — reads as the program
 * having printed its own error messages.
 */
export type CodeRunPhase = "compile" | "run";

export interface CodeRunResult {
  status: "success" | "error";
  phase: CodeRunPhase;
  stdout: string;
  stderr: string;
  /**
   * What the compiler said about a compile that nonetheless succeeded — the
   * warnings. They belong to a phase the run passed through rather than ended
   * in, so they cannot live in `stderr` without reading as something the
   * program itself printed.
   */
  compileStderr: string;
  exitCode: number;
  /** The phase's process was still alive when its budget ran out. */
  timedOut: boolean;
  /** A stream reached `MAX_CODE_RUN_STREAM_BYTES` and lost its tail. */
  truncated: boolean;
  executionTimeMs: number;
}

export const codeRunResultSchema = v.object({
  status: v.picklist(["success", "error"]),
  phase: v.picklist(["compile", "run"]),
  stdout: v.string(),
  stderr: v.string(),
  // Absent tolerated, because the runner Worker deploys independently of the app
  // that reads its results: a runner still on the previous version would
  // otherwise fail this parse and every run would read as an unreadable
  // response. The runner always sends it.
  compileStderr: v.optional(v.string(), ""),
  exitCode: v.pipe(v.number(), v.safeInteger()),
  timedOut: v.boolean(),
  truncated: v.boolean(),
  executionTimeMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
}) satisfies v.GenericSchema<unknown, CodeRunResult>;

const SANDBOX_ID_PREFIX = "board-";
/** 128 bits of the digest. See `sha256Hex` for why that is enough. */
const SANDBOX_ID_DIGEST_CHARS = 32;

/**
 * The only shape a sandbox id may have. Stated exactly, rather than as a
 * permissive character class, because the runner should only ever see an id
 * this system derived — anything else is a bug or an intrusion, and either way
 * not something to start a container for.
 *
 * It also stays within 63 characters, the ceiling Cloudflare's sandbox
 * examples hold a sandbox name to (and the one the 0.x Sandbox SDK enforced),
 * so the id remains a valid name wherever it is used as one.
 */
export const codeSandboxIdSchema = v.pipe(
  v.string(),
  v.regex(
    new RegExp(`^${SANDBOX_ID_PREFIX}[0-9a-f]{${SANDBOX_ID_DIGEST_CHARS}}$`),
    "sandboxId must be a derived board sandbox id",
  ),
);

/**
 * The runner Worker's own request shape. It differs from the browser's by one
 * field: `sandboxId`, which the web Worker derives from the caller's verified
 * whiteboard token. It is never accepted from a browser — that would let any
 * authenticated participant name another board's container.
 */
export const codeRunnerRequestSchema = v.strictObject({
  ...codeRunRequestEntries,
  sandboxId: codeSandboxIdSchema,
});

export type CodeRunnerRequest = v.InferOutput<typeof codeRunnerRequestSchema>;

export const codeRunnerCancelRequestSchema = v.strictObject({
  runId: codeRunIdSchema,
  sandboxId: codeSandboxIdSchema,
});

/**
 * Sandbox id for a board. Per board room rather than per participant: everyone
 * editing one board shares a warm container, which is what keeps a second run
 * fast and the container count bounded by boards rather than by people.
 *
 * The tradeoff that buys is real and deliberate — collaborators on one board
 * share one machine. The runner still gives each concurrent run its own
 * unprivileged user and directory, and wipes both between runs, so one
 * participant cannot read, signal or leave anything for another's run; what
 * they do share is the container's CPU, memory and disk.
 *
 * A digest rather than the room id spelled into the name: the id has to land in
 * a restricted alphabet, and *normalizing* into one is lossy, so two different
 * boards could be folded onto a single container — the one boundary here that
 * has to hold. Hashing is injective for every input, needs no assumptions about
 * how room ids are generated, and keeps board identifiers out of container
 * names and their logs. The cost is that a container can no longer be read back
 * to a board by eye; recompute this from the room id instead.
 */
export async function codeSandboxIdForRoom(syncRoomId: string): Promise<string> {
  return `${SANDBOX_ID_PREFIX}${await sha256Hex(syncRoomId, SANDBOX_ID_DIGEST_CHARS)}`;
}

/**
 * The id the runner knows a run by: the browser's run id, bound to whoever
 * started it. A browser's id says nothing about whose run it is, so the web
 * Worker derives the runner's id from the caller's verified principal as well,
 * for the start and for every cancel. A cancel then reaches only a run its own
 * caller started; anyone else's names a run that does not exist.
 */
export async function codeRunnerRunIdFor(ownerKey: string, runId: string): Promise<string> {
  const hex = await sha256Hex(`${ownerKey}\n${runId}`, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
