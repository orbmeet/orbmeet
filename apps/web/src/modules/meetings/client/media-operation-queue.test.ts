import { describe, expect, it, vi } from "vitest";
import { MediaOperationQueue } from "./media-operation-queue";

describe("MediaOperationQueue", () => {
  it("runs rapid user intents in order instead of dropping later actions", async () => {
    const queue = new MediaOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after an earlier operation fails", async () => {
    const queue = new MediaOperationQueue();
    const later = vi.fn();
    await expect(queue.enqueue(async () => {
      throw new Error("capture failed");
    })).rejects.toThrow("capture failed");
    await queue.enqueue(async () => { later(); });
    expect(later).toHaveBeenCalledOnce();
  });
});
