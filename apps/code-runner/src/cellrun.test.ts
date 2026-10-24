import {
  CODE_COMPILE_TIMEOUT_MS,
  CODE_RUN_TIMEOUT_MS,
  MAX_CODE_RUN_RESPONSE_BYTES,
  MAX_CODE_RUN_STREAM_BYTES,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { describe, expect, it } from "vitest";
import {
  CELLRUN,
  CellrunProtocolError,
  MAX_REPORT_BYTES,
  cellrunArgv,
  parseReport,
  reportComplete,
  stripDirectory,
  toCodeRunResult,
  type CellrunReport,
  type PhaseReport,
} from "./cellrun";

/** Builds a report the way cellrun.c writes one. */
function encode(records: [string, string | Uint8Array][], { header = "cellrun 1\n", end = true } = {}) {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode(header)];
  for (const [key, value] of [...records, ...(end ? [["end", ""] as [string, string]] : [])]) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    parts.push(encoder.encode(`${key} ${bytes.byteLength}\n`), bytes, encoder.encode("\n"));
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function phaseRecords(name: string, phase: Partial<PhaseReport> = {}): [string, string][] {
  const full = { ended: "exit", exitCode: 0, elapsedMs: 5, truncated: false, stdout: "", stderr: "", ...phase };
  return [
    [`${name}.ended`, full.ended],
    [`${name}.exit`, String(full.exitCode)],
    [`${name}.ms`, String(full.elapsedMs)],
    [`${name}.truncated`, full.truncated ? "1" : "0"],
    [`${name}.stdout`, full.stdout],
    [`${name}.stderr`, full.stderr],
  ];
}

const phase = (overrides: Partial<PhaseReport> = {}): PhaseReport => ({
  ended: "exit",
  exitCode: 0,
  elapsedMs: 5,
  truncated: false,
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("cellrunArgv", () => {
  it("passes the slot, the language and the contract's budgets, never the source", () => {
    expect(cellrunArgv(2, "go")).toEqual([
      CELLRUN,
      "2",
      "go",
      String(CODE_COMPILE_TIMEOUT_MS),
      String(CODE_RUN_TIMEOUT_MS),
      String(MAX_CODE_RUN_STREAM_BYTES),
    ]);
  });
});

describe("parseReport", () => {
  it("reads a two-phase report", () => {
    const report = parseReport(encode([
      ...phaseRecords("compile", { stderr: "warning: x\n", elapsedMs: 900 }),
      ...phaseRecords("run", { stdout: "hello\n", exitCode: 3 }),
      ["stopped", "0"],
    ]));

    expect(report).toEqual({
      compile: phase({ stderr: "warning: x\n", elapsedMs: 900 }),
      run: phase({ stdout: "hello\n", exitCode: 3 }),
      stopped: false,
    } satisfies CellrunReport);
  });

  it("reads a report with no phase, which only a Stop produces", () => {
    expect(parseReport(encode([["stopped", "1"]]))).toEqual({ stopped: true });
  });

  it("keeps output byte-faithful, including newlines and a leading BOM", () => {
    const report = parseReport(encode([...phaseRecords("run", { stdout: "﻿a\nb\n\n" }), ["stopped", "0"]]));
    expect(report.run?.stdout).toBe("﻿a\nb\n\n");
  });

  it("refuses a report that was cut short", () => {
    const whole = encode([...phaseRecords("run", { stdout: "hello" }), ["stopped", "0"]]);
    for (const length of [0, 5, 20, whole.byteLength - 1]) {
      expect(() => parseReport(whole.subarray(0, length))).toThrow(CellrunProtocolError);
    }
    expect(() => parseReport(encode([["stopped", "0"]], { end: false }))).toThrow(CellrunProtocolError);
  });

  it("refuses anything that is not exactly a report", () => {
    expect(() => parseReport(encode([["stopped", "0"]], { header: "cellrun 2\n" }))).toThrow(/header/);
    expect(() => parseReport(encode([["surprise", "1"], ["stopped", "0"]]))).toThrow(/unknown record/);
    expect(() => parseReport(encode([["stopped", "0"], ["stopped", "0"]]))).toThrow(/duplicate/);
    expect(() => parseReport(encode([...phaseRecords("run", { ended: "crashed" as never }), ["stopped", "0"]])))
      .toThrow(/ending/);
    const trailing = new Uint8Array([...encode([["stopped", "0"]]), 0x78]);
    expect(() => parseReport(trailing)).toThrow(/after the end/);
  });

  it("knows a report is whole at its end record, before its stream ends", () => {
    // A record body that looks like framing must not end the report early.
    const whole = encode([...phaseRecords("run", { stdout: "end 0\n\n" }), ["stopped", "0"]]);
    for (let length = 0; length < whole.byteLength; length += 1) {
      expect(reportComplete(whole.subarray(0, length))).toBe(false);
    }
    expect(reportComplete(whole)).toBe(true);
  });

  it("knows a report is wrong as soon as its framing is", () => {
    expect(() => reportComplete(new TextEncoder().encode("cellrun 2"))).toThrow(/header/);
    expect(() => reportComplete(new TextEncoder().encode(`cellrun 1\n${"k".repeat(40)}`))).toThrow(/record header/);
    expect(() => reportComplete(new TextEncoder().encode("cellrun 1\nrun.ms x\n"))).toThrow(/length/);
  });

  it("leaves room for the largest report cellrun can write", () => {
    const full = "\u0001".repeat(MAX_CODE_RUN_STREAM_BYTES);
    const largest = encode([
      ...phaseRecords("compile", { stdout: full, stderr: full, elapsedMs: 99_999_999 }),
      ...phaseRecords("run", { stdout: full, stderr: full, exitCode: 255, elapsedMs: 99_999_999 }),
      ["stopped", "1"],
    ]);
    expect(largest.byteLength).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  });
});

describe("toCodeRunResult", () => {
  it("reports an interpreted run as the run phase", () => {
    const result = toCodeRunResult({ run: phase({ stdout: "hi\n", elapsedMs: 40 }), stopped: false }, 0);
    expect(result).toEqual({
      status: "success",
      phase: "run",
      stdout: "hi\n",
      stderr: "",
      compileStderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      executionTimeMs: 40,
    });
  });

  it("reports a failed compile as the result, its diagnostics once", () => {
    const result = toCodeRunResult({
      compile: phase({ exitCode: 1, stderr: "/cells/1/main.c:1: error\n" }),
      stopped: false,
    }, 1);
    expect(result).toMatchObject({
      status: "error",
      phase: "compile",
      stderr: "main.c:1: error\n",
      compileStderr: "",
      exitCode: 1,
    });
  });

  it("carries a successful compile's warnings beside the program's own output", () => {
    const result = toCodeRunResult({
      compile: phase({ stderr: "/cells/2/main.c:2: warning: unused\n", elapsedMs: 700 }),
      run: phase({ stdout: "done\n", elapsedMs: 30 }),
      stopped: false,
    }, 2);
    expect(result).toMatchObject({
      status: "success",
      phase: "run",
      stdout: "done\n",
      stderr: "",
      compileStderr: "main.c:2: warning: unused\n",
      executionTimeMs: 730,
    });
  });

  it("explains a run that hit its deadline, on its own line", () => {
    const result = toCodeRunResult({
      run: phase({ ended: "timeout", exitCode: 137, stderr: "partial" }),
      stopped: false,
    }, 0);
    expect(result?.status).toBe("error");
    expect(result?.timedOut).toBe(true);
    expect(result?.stderr).toBe(
      `partial\nExecution timed out after ${CODE_RUN_TIMEOUT_MS / 1000}s — check for an infinite loop or slow I/O.`,
    );
  });

  it("names compilation when the compiler is what ran out of time", () => {
    const result = toCodeRunResult({ compile: phase({ ended: "timeout", exitCode: 137 }), stopped: false }, 0);
    expect(result?.phase).toBe("compile");
    expect(result?.stderr).toBe(`Compilation timed out after ${CODE_COMPILE_TIMEOUT_MS / 1000}s.`);
  });

  it("explains a run stopped at the disk floor, which is not a timeout", () => {
    const result = toCodeRunResult({ run: phase({ ended: "disk", exitCode: 137, stderr: "x\n" }), stopped: false }, 0);
    expect(result?.status).toBe("error");
    expect(result?.timedOut).toBe(false);
    expect(result?.stderr).toMatch(/^x\nStopped: .*disk space/);
  });

  it("says a process the kernel killed most likely ran out of memory", () => {
    const result = toCodeRunResult({ run: phase({ ended: "killed", exitCode: 137, stdout: "allocated\n" }), stopped: false }, 0);
    expect(result).toMatchObject({ status: "error", exitCode: 137, timedOut: false, stdout: "allocated\n" });
    expect(result?.stderr).toMatch(/ran out of memory/);
  });

  it("reports a non-zero exit as an error without inventing a message", () => {
    const result = toCodeRunResult({ run: phase({ exitCode: 3, stderr: "" }), stopped: false }, 0);
    expect(result).toMatchObject({ status: "error", exitCode: 3, stderr: "" });
  });

  it("says the output was cut short when the warnings were", () => {
    const result = toCodeRunResult({
      compile: phase({ truncated: true }),
      run: phase(),
      stopped: false,
    }, 0);
    expect(result?.truncated).toBe(true);
  });

  it("has no result when no phase ran", () => {
    expect(toCodeRunResult({ stopped: true }, 0)).toBeNull();
  });
});

describe("stripDirectory", () => {
  it("reports the file the author wrote, not the container's path to it", () => {
    expect(stripDirectory('File "/cells/0/main.py", line 2', "/cells/0")).toBe('File "main.py", line 2');
  });

  it("reports the directory itself as the working directory", () => {
    expect(stripDirectory("/cells/0\n", "/cells/0")).toBe(".\n");
    expect(stripDirectory("tmp=/cells/0 home=/cells/0/.home", "/cells/0")).toBe("tmp=. home=.home");
  });

  it("leaves a longer path that only starts the same way alone", () => {
    expect(stripDirectory("/cells/01/x and /cells/0-old", "/cells/0")).toBe("/cells/01/x and /cells/0-old");
  });
});

describe("the gateway's response bound", () => {
  it("fits the largest result the runner can return", () => {
    const control = "\u0001".repeat(MAX_CODE_RUN_STREAM_BYTES);
    const result = toCodeRunResult({
      compile: phase({ stderr: control }),
      run: phase({ ended: "timeout", exitCode: 137, stdout: control, stderr: control }),
      stopped: false,
    }, 2);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(MAX_CODE_RUN_RESPONSE_BYTES);
  });
});
