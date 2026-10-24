import { describe, expect, it, vi } from "vitest";

import { handlePipeError, handleStdoutError } from "./process-errors.ts";

describe("stdout errors", () => {
  it("treats a closed downstream pipe as successful termination", () => {
    const exit = vi.fn();
    handleStdoutError(Object.assign(new Error("closed pipe"), { code: "EPIPE" }), exit);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not hide unrelated output failures", () => {
    const error = Object.assign(new Error("I/O failed"), { code: "EIO" });
    expect(() => handleStdoutError(error, vi.fn())).toThrow(error);
  });

  it("preserves failure status when stderr's pipe is closed", () => {
    const exit = vi.fn();
    handlePipeError(Object.assign(new Error("closed pipe"), { code: "EPIPE" }), exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
