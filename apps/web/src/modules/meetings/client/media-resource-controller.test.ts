import { describe, expect, it, vi } from "vitest";
import { MediaOperationQueue, MediaResourceController } from "./media-resource-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("MediaResourceController", () => {
  it("disposes an acquisition that resolves after unmount", async () => {
    const release = vi.fn();
    const controller = new MediaResourceController<string>(release);
    const pending = deferred<string>();
    const acquired = controller.acquire(() => pending.promise);
    await Promise.resolve();
    controller.clear();
    pending.resolve("old camera");
    expect(await acquired).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith("old camera");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("keeps the newer camera when acquisitions finish out of order", async () => {
    const release = vi.fn();
    const controller = new MediaResourceController<string>(release);
    const pending = deferred<string>();
    const first = controller.acquire(() => pending.promise);
    await Promise.resolve();
    expect(await controller.acquire(async () => "new camera")).toBe("new camera");
    pending.resolve("old camera");
    await first;
    expect(controller.getSnapshot().resource).toBe("new camera");
    expect(release).toHaveBeenCalledExactlyOnceWith("old camera");
  });

  it("waits for cleanup before replacement and supports setup after cleanup", async () => {
    const cleanup = deferred<void>();
    const controller = new MediaResourceController<string>(() => cleanup.promise);
    await controller.acquire(async () => "first");
    controller.clear();
    controller.clear();
    const factory = vi.fn(async () => "second");
    const acquired = controller.acquire(factory);
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await acquired).toBe("second");
  });

  it("reports cleanup errors and permits recovery from acquisition failure", async () => {
    const onError = vi.fn();
    const controller = new MediaResourceController<string>(() => { throw new Error("cleanup"); }, onError);
    await controller.acquire(async () => "first");
    await expect(controller.acquire(async () => { throw new Error("permission"); })).rejects.toThrow("permission");
    expect(onError).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("failed");
    await controller.acquire(async () => "recovered");
    expect(controller.getSnapshot().resource).toBe("recovered");
  });
});

it("serializes processor changes and recovers after one fails", async () => {
  const queue = new MediaOperationQueue();
  const gate = deferred<void>();
  const order: string[] = [];
  const first = queue.run(async () => { await gate.promise; order.push("first"); throw new Error("processor"); });
  const rejected = first.catch((error: unknown) => error);
  const second = queue.run(async () => { order.push("second"); });
  expect(order).toEqual([]);
  gate.resolve();
  expect(await rejected).toEqual(new Error("processor"));
  await second;
  expect(order).toEqual(["first", "second"]);
});
