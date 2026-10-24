import { describe, expect, it } from "vitest";
import { SerialQueue } from "./queue";

describe("SerialQueue", () => {
  it("runs work one piece at a time, in arrival order", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run(async () => {
      events.push("first started");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("first finished");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second started");
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(["first started"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first started", "first finished", "second started"]);
  });

  it("keeps going after a piece fails", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("refused");
    });
    await expect(failed).rejects.toThrow("refused");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });

  it("refuses a piece whose turn comes after its deadline, and runs the ones behind it", async () => {
    const queue = new SerialQueue();
    let releaseFirst!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const late = queue.run(async () => "ran", Date.now() + 10);
    const unhurried = queue.run(async () => "ran");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();

    await first;
    await expect(late).rejects.toMatchObject({ code: "BUSY" });
    await expect(unhurried).resolves.toBe("ran");
  });
});
