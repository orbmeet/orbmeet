import { describe, expect, it } from "vitest";
import { getRemoteMessageDelta } from "./use-meeting-ui";

describe("chat notification counter", () => {
  it("counts events independently of bounded history length", () => {
    expect(getRemoteMessageDelta(100, 101)).toBe(1);
    expect(getRemoteMessageDelta(100, 105)).toBe(5);
  });

  it("treats a counter reset as a new baseline", () => {
    expect(getRemoteMessageDelta(10, 0)).toBe(0);
  });
});
