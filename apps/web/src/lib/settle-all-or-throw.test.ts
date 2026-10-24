import { describe, expect, it } from "vitest";

import { settleSequentiallyOrThrow } from "./settle-all-or-throw";

describe("settleSequentiallyOrThrow", () => {
  it("runs tasks serially and continues after a rejection", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (label: string, reject = false) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(label);
      active -= 1;
      if (reject) throw new Error(label);
      return label;
    };

    await expect(settleSequentiallyOrThrow("maintenance failed", [
      { label: "first", run: run("first") },
      { label: "second", run: run("second", true) },
      { label: "third", run: run("third") },
    ])).rejects.toMatchObject({
      message: "maintenance failed: second",
      errors: [expect.objectContaining({ message: "second" })],
    });
    expect(events).toEqual(["first", "second", "third"]);
    expect(maxActive).toBe(1);
  });
});
