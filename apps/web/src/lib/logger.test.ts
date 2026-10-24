import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureError(fn: () => void): string {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  fn();
  expect(spy).toHaveBeenCalledOnce();
  return spy.mock.calls[0][0];
}

describe("logError", () => {
  it("cuts cycles instead of overflowing the stack", () => {
    // Recording what went wrong must not itself throw: the recursive
    // serializer overflowed on a cyclic argument, and JSON.stringify would
    // have thrown on it too.
    const cyclic: Record<string, unknown> = { name: "room" };
    cyclic.self = cyclic;

    const line = captureError(() => logError("boom", cyclic));
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      msg: "boom",
      name: "room",
      self: "[Circular]",
    });
  });

  it("cuts a cycle reached through an array", () => {
    const list: unknown[] = [];
    list.push({ list });

    const line = captureError(() => logError("boom", { list }));
    expect(line).toContain("[Circular]");
  });

  it("keeps a value that legitimately appears twice in a tree", () => {
    const shared = { id: "a" };
    const line = captureError(() => logError("boom", { first: shared, second: shared }));
    expect(JSON.parse(line)).toMatchObject({
      first: { id: "a" },
      second: { id: "a" },
    });
  });

  it("truncates rather than recursing without bound", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let level = 0; level < 200; level += 1) deep = { deep };

    const line = captureError(() => logError("boom", deep));
    expect(line).toContain("[Truncated]");
  });

  it("still emits a line when a value cannot be serialized at all", () => {
    const hostile = {
      get boom(): never {
        throw new Error("getter");
      },
    };
    const line = captureError(() => logError("boom", { nested: { toJSON: () => hostile } }));
    expect(JSON.parse(line)).toMatchObject({ msg: "boom" });
  });
});
