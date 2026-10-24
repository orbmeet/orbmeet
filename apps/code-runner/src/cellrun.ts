import {
  CODE_COMPILE_TIMEOUT_MS,
  CODE_RUN_TIMEOUT_MS,
  MAX_CODE_RUN_STREAM_BYTES,
  type CodeRunResult,
} from "@orbmeet/whiteboard-core/code-run-contract";
import type { CodeLanguage } from "@orbmeet/whiteboard-core/code-shape-schema";

/**
 * The runner's side of `cellrun` (cellrun.c), the supervisor that runs one
 * code cell inside the board's container.
 *
 * The Durable Object starts it once per run, passes the source on stdin, and
 * reads one report from stdout. Every budget it enforces arrives here as an
 * argument, so the contract in whiteboard-core stays the only place they are
 * stated.
 */
export const CELLRUN = "/usr/local/bin/cellrun";

/** Concurrent runs per board. Must equal CELLRUN_SLOTS in the Dockerfile. */
export const CELLRUN_SLOTS = 3;

/** What cellrun's exit status says about the container. */
export const CellrunExit = {
  /** A report was written, whatever the snippet itself did. */
  Reported: 0,
  /** Invalid arguments or source: a runner bug, not a container fault. */
  Usage: 64,
  /** This kernel or runtime cannot enforce the jail. A new container would not help. */
  JailUnavailable: 69,
  /** A slot could not be reset or a phase could not be stopped. */
  ReplaceContainer: 70,
  /** The slot is still held by a supervisor this object did not start. */
  SlotBusy: 75,
} as const;

/** Reports what the kernel and runtime provide, for the runner's logs. */
export const CELLRUN_PROBE: [string, ...string[]] = [CELLRUN, "--probe"];

export function cellrunArgv(slot: number, language: CodeLanguage): [string, ...string[]] {
  return [
    CELLRUN,
    String(slot),
    language,
    String(CODE_COMPILE_TIMEOUT_MS),
    String(CODE_RUN_TIMEOUT_MS),
    String(MAX_CODE_RUN_STREAM_BYTES),
  ];
}

/** The directory a slot's run works in, as toolchains print it. */
function slotDirectory(slot: number): string {
  return `/cells/${slot}`;
}

type PhaseName = "compile" | "run";

/**
 * How a phase ended: on its own, killed by the kernel (in practice for memory),
 * or stopped by its deadline, the disk floor, or a Stop.
 */
type PhaseEnding = "exit" | "killed" | "timeout" | "disk" | "stopped";

export interface PhaseReport {
  ended: PhaseEnding;
  exitCode: number;
  elapsedMs: number;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

export interface CellrunReport {
  compile?: PhaseReport;
  run?: PhaseReport;
  /** A Stop reached cellrun at some point during the run. */
  stopped: boolean;
}

/**
 * The most a well-formed report can be: two phases of two capped streams, and
 * framing. Anything longer is not a report.
 */
export const MAX_REPORT_BYTES = 2 * 2 * MAX_CODE_RUN_STREAM_BYTES + 4 * 1024;

export class CellrunProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CellrunProtocolError";
  }
}

const HEADER = "cellrun 1\n";
const ENDINGS: readonly PhaseEnding[] = ["exit", "killed", "timeout", "disk", "stopped"];
const PHASE_FIELDS = ["ended", "exit", "ms", "truncated", "stdout", "stderr"] as const;
type PhaseField = (typeof PHASE_FIELDS)[number];

/**
 * Walks a report's framing: `cellrun 1\n`, then `<key> <length>\n<bytes>\n`
 * records, closed by an `end` record. Null while more bytes are needed;
 * throws for framing no further bytes could make right.
 */
function frame(bytes: Uint8Array): { records: Map<string, Uint8Array>; length: number } | null {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  const header = ascii(0, Math.min(bytes.length, HEADER.length));
  if (!HEADER.startsWith(header)) throw new CellrunProtocolError("missing report header");
  if (header.length < HEADER.length) return null;

  const records = new Map<string, Uint8Array>();
  let offset = HEADER.length;
  for (;;) {
    const space = bytes.indexOf(0x20, offset);
    if ((space < 0 ? bytes.length : space) - offset > 32) throw new CellrunProtocolError("malformed record header");
    const newline = space < 0 ? -1 : bytes.indexOf(0x0a, space);
    if (newline < 0) return null;
    const key = ascii(offset, space);
    const lengthText = ascii(space + 1, newline);
    if (!/^\d{1,9}$/.test(lengthText)) throw new CellrunProtocolError(`malformed length for ${key}`);
    const start = newline + 1;
    const end = start + Number(lengthText);
    if (end >= bytes.length) return null;
    if (bytes[end] !== 0x0a) throw new CellrunProtocolError(`record ${key} is not terminated`);
    if (records.has(key)) throw new CellrunProtocolError(`duplicate record ${key}`);
    records.set(key, bytes.subarray(start, end));
    offset = end + 1;
    if (key === "end") return { records, length: offset };
  }
}

/**
 * Whether `bytes` hold a whole report, judged by its framing alone, so a
 * reader knows the report is over without waiting for the stream to end.
 * Throws as soon as the framing is wrong.
 */
export function reportComplete(bytes: Uint8Array): boolean {
  return frame(bytes) !== null;
}

/**
 * Parses a report. Strict throughout, because the only producer is cellrun
 * itself, and anything else is a fault to surface, not to tolerate.
 */
export function parseReport(bytes: Uint8Array): CellrunReport {
  const framed = frame(bytes);
  if (!framed) throw new CellrunProtocolError("the report is cut short");
  if (framed.length !== bytes.length) throw new CellrunProtocolError("data after the end record");
  // Byte-faithful: a program's leading BOM is part of what it printed.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const fields = new Map([...framed.records].map(([key, value]) => [key, decoder.decode(value)]));

  const phase = (name: PhaseName): PhaseReport | undefined => {
    const field = (suffix: PhaseField) => fields.get(`${name}.${suffix}`);
    if (PHASE_FIELDS.every((suffix) => field(suffix) === undefined)) return undefined;
    const ended = field("ended") as PhaseEnding;
    if (!ENDINGS.includes(ended)) throw new CellrunProtocolError(`${name} has no valid ending`);
    return {
      ended,
      exitCode: integer(field("exit"), `${name}.exit`),
      elapsedMs: integer(field("ms"), `${name}.ms`),
      truncated: flag(field("truncated"), `${name}.truncated`),
      stdout: required(field("stdout"), `${name}.stdout`),
      stderr: required(field("stderr"), `${name}.stderr`),
    };
  };
  const known = new Set(["stopped", "end", ...(["compile", "run"] as const).flatMap((name) =>
    PHASE_FIELDS.map((suffix) => `${name}.${suffix}`)
  )]);
  for (const key of fields.keys()) {
    if (!known.has(key)) throw new CellrunProtocolError(`unknown record ${key}`);
  }

  const report: CellrunReport = { stopped: flag(fields.get("stopped"), "stopped") };
  const compile = phase("compile");
  const run = phase("run");
  if (compile) report.compile = compile;
  if (run) report.run = run;
  return report;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new CellrunProtocolError(`missing ${name}`);
  return value;
}

function integer(value: string | undefined, name: string): number {
  const text = required(value, name);
  if (!/^-?\d{1,12}$/.test(text)) throw new CellrunProtocolError(`${name} is not an integer`);
  return Number(text);
}

function flag(value: string | undefined, name: string): boolean {
  const text = required(value, name);
  if (text !== "0" && text !== "1") throw new CellrunProtocolError(`${name} is not a flag`);
  return text === "1";
}

/**
 * What the author sees for a finished run. Null when no phase ran, which only
 * a Stop can cause.
 *
 * The result describes the phase the run ended in: the compile when it failed
 * (its diagnostics are the result), otherwise the program. A successful
 * compile's stderr — the warnings — travels alongside as `compileStderr`.
 */
export function toCodeRunResult(report: CellrunReport, slot: number): CodeRunResult | null {
  const final = report.run ?? report.compile;
  if (!final) return null;
  const phase: PhaseName = report.run ? "run" : "compile";
  const directory = slotDirectory(slot);
  const compileStderr = report.run ? report.compile?.stderr ?? "" : "";
  return {
    status: final.ended === "exit" && final.exitCode === 0 ? "success" : "error",
    phase,
    stdout: stripDirectory(final.stdout, directory),
    stderr: stripDirectory(withEndingNotice(final, phase), directory),
    compileStderr: stripDirectory(compileStderr, directory),
    exitCode: final.exitCode,
    timedOut: final.ended === "timeout",
    truncated: final.truncated || (report.run !== undefined && (report.compile?.truncated ?? false)),
    executionTimeMs: (report.compile?.elapsedMs ?? 0) + (report.run?.elapsedMs ?? 0),
  };
}

/**
 * A stopped process reports whatever exit the signal produced, which tells
 * the author nothing. Why it was stopped is the explanation, so it is stated
 * outright and appended: the output up to the stop is usually where the
 * runaway loop is visible.
 */
function withEndingNotice(report: PhaseReport, phase: PhaseName): string {
  const seconds = (ms: number) => Math.round(ms / 1000);
  const notice = report.ended === "timeout"
    ? phase === "compile"
      ? `Compilation timed out after ${seconds(CODE_COMPILE_TIMEOUT_MS)}s.`
      : `Execution timed out after ${seconds(CODE_RUN_TIMEOUT_MS)}s — check for an infinite loop or slow I/O.`
    : report.ended === "disk"
    ? "Stopped: this board's runner is almost out of disk space. Write less to disk."
    : report.ended === "killed"
    ? "Killed by the system — most likely the program ran out of memory."
    : "";
  if (!notice) return report.stderr;
  const separator = report.stderr && !report.stderr.endsWith("\n") ? "\n" : "";
  return `${report.stderr}${separator}${notice}`;
}

/**
 * Rewrites the run directory out of a toolchain's messages, so a traceback
 * reads `main.py` rather than `/cells/0/main.py` — the file the author wrote,
 * not the container's layout. The directory named on its own is the working
 * directory, `.`; a longer path that merely starts with the same characters
 * (`/cells/01`) is left alone.
 */
export function stripDirectory(text: string, directory: string): string {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?:/|(?![\\w.-]))`, "g"), (match) =>
    match.endsWith("/") ? "" : "."
  );
}
