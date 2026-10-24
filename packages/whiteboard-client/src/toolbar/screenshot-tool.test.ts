import { describe, expect, it } from "vitest";
import { claimScreenshotCapture } from "./screenshot-tool";

describe("claimScreenshotCapture", () => {
  it("allows only one in-flight capture for an editor", () => {
    const editor = {};
    const release = claimScreenshotCapture(editor);

    expect(release).toBeTypeOf("function");
    expect(claimScreenshotCapture(editor)).toBeNull();

    release?.();
    expect(claimScreenshotCapture(editor)).toBeTypeOf("function");
  });

  it("does not block a different mounted editor", () => {
    const firstEditor = {};
    const secondEditor = {};

    expect(claimScreenshotCapture(firstEditor)).toBeTypeOf("function");
    expect(claimScreenshotCapture(secondEditor)).toBeTypeOf("function");
  });

  it("releases idempotently", () => {
    const editor = {};
    const release = claimScreenshotCapture(editor);

    release?.();
    release?.();

    expect(claimScreenshotCapture(editor)).toBeTypeOf("function");
  });
});
