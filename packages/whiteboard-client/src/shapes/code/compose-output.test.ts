import { MAX_CODE_RUN_STREAM_BYTES } from "@orbmeet/whiteboard-core/code-run-contract";
import {
  CODE_SHAPE_PROPS,
  MAX_CODE_OUTPUT_CHARS,
} from "@orbmeet/whiteboard-core/code-shape-schema";
import { describe, expect, it } from "vitest";
import { composeOutput, type ComposableRun } from "./compose-output";

const run = (overrides: Partial<ComposableRun> = {}): ComposableRun => ({
  stdout: "",
  stderr: "",
  compileStderr: "",
  phase: "run",
  truncated: false,
  ...overrides,
});

describe("composeOutput", () => {
  it("returns an empty string when the run said nothing", () => {
    expect(composeOutput(run())).toBe("");
  });

  it("joins both streams when they fit", () => {
    expect(composeOutput(run({ stdout: "out\n", stderr: "err\n" }))).toBe("out\nerr");
  });

  it("never exceeds what the shape's validator accepts", () => {
    // The regression this function exists for: both streams arrive already at
    // their own bound, and the merged string used to be written unbounded.
    const composed = composeOutput(run({
      stdout: "a".repeat(MAX_CODE_OUTPUT_CHARS),
      stderr: "b".repeat(MAX_CODE_OUTPUT_CHARS),
    }));

    expect(composed.length).toBeLessThanOrEqual(MAX_CODE_OUTPUT_CHARS);
    expect(() => CODE_SHAPE_PROPS.output.validate(composed)).not.toThrow();
  });

  it("stays inside the bound with every section present at once", () => {
    const composed = composeOutput(run({
      stdout: "a".repeat(MAX_CODE_OUTPUT_CHARS),
      stderr: "b".repeat(MAX_CODE_OUTPUT_CHARS),
      compileStderr: "c".repeat(MAX_CODE_OUTPUT_CHARS),
      truncated: true,
    }));

    expect(composed.length).toBeLessThanOrEqual(MAX_CODE_OUTPUT_CHARS);
    expect(() => CODE_SHAPE_PROPS.output.validate(composed)).not.toThrow();
  });

  it("keeps the error when stdout is what has to give way", () => {
    const composed = composeOutput(
      run({ stdout: "x".repeat(500), stderr: "ReferenceError: nope" }),
      100,
    );

    expect(composed.length).toBeLessThanOrEqual(100);
    expect(composed).toContain("ReferenceError: nope");
    expect(composed).toContain("output truncated");
  });

  it("drops stdout entirely when the error alone fills the budget", () => {
    const composed = composeOutput(
      run({ stdout: "x".repeat(500), stderr: "e".repeat(500) }),
      100,
    );

    expect(composed.length).toBeLessThanOrEqual(100);
    expect(composed.startsWith("e")).toBe(true);
  });

  it("marks a truncated single stream", () => {
    const composed = composeOutput(run({ stdout: "y".repeat(500) }), 100);
    expect(composed.length).toBe(100);
    expect(composed).toContain("output truncated");
  });

  it("labels a failed compile's diagnostics as the compiler's own", () => {
    // Without the label these read as something the program printed, which is
    // the distinction the separate compile phase exists to preserve.
    const composed = composeOutput(run({
      phase: "compile",
      stderr: "main.c:1:1: error: expected declaration",
    }));

    expect(composed).toBe("Compile error:\nmain.c:1:1: error: expected declaration");
  });

  it("keeps the warnings from a compile that succeeded, ahead of the output", () => {
    const composed = composeOutput(run({
      stdout: "42",
      compileStderr: "main.c:3:5: warning: unused variable 'x'",
    }));

    expect(composed).toBe("Compile warnings:\nmain.c:3:5: warning: unused variable 'x'\n42");
  });

  it("does not label a failed compile's diagnostics as warnings as well", () => {
    // On the compile-error path the diagnostics are the result, and
    // `compileStderr` is empty — a run that reported both would be saying the
    // same text twice under two names.
    const composed = composeOutput(run({
      phase: "compile",
      stderr: "error[E0425]",
      compileStderr: "error[E0425]",
    }));

    expect(composed).toBe("Compile error:\nerror[E0425]");
  });

  it("says so when the runner stopped capturing", () => {
    // `truncated` used to be carried the whole way here and then dropped, so a
    // clipped stream looked like a program that simply stopped printing.
    const composed = composeOutput(run({ stdout: "partial", truncated: true }));

    expect(composed).toContain(`${MAX_CODE_RUN_STREAM_BYTES / 1024} KB`);
    expect(composed.startsWith("partial")).toBe(true);
  });

  it("keeps the capture notice even when the output has to be cut for it", () => {
    const composed = composeOutput(
      run({ stdout: "z".repeat(500), truncated: true }),
      80,
    );

    expect(composed.length).toBeLessThanOrEqual(80);
    expect(composed).toContain("stopped capturing");
  });
});
