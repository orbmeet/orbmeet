import { afterEach, describe, expect, it, vi } from "vitest";
import { jobStepOf } from "./durable-job-workflow";

function workflowStep() {
  const sleeps: Array<{ name: string; at: number }> = [];
  const step = {
    do: vi.fn(),
    sleepUntil: async (name: string, at: Date | number) => {
      const time = new Date(at).getTime();
      // What the Workflow runtime does with a past time.
      if (time < Date.now()) throw new Error("You can't sleep until a time in the past, time-traveler");
      sleeps.push({ name, at: time });
    },
  };
  return { step: step as unknown as Parameters<typeof jobStepOf>[0], sleeps };
}

describe("jobStepOf", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits until a time still ahead", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const { step, sleeps } = workflowStep();

    await jobStepOf(step).sleepUntil("settle", 60_000);

    expect(sleeps).toEqual([{ name: "settle", at: 60_000 }]);
  });

  it("moves a time already past just ahead, so a late job still runs", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const { step, sleeps } = workflowStep();

    await jobStepOf(step).sleepUntil("settle", 5_000);

    expect(sleeps).toEqual([{ name: "settle", at: 11_000 }]);
  });
});
