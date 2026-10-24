import { describe, expect, it, vi } from "vitest";
import { commitUploadBeforePublish } from "./managed-upload";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("commitUploadBeforePublish", () => {
  it("does not publish the collaborative record until the upload is durable", async () => {
    const commit = deferred();
    const events: string[] = [];
    const operation = commitUploadBeforePublish(
      {
        commit: async () => {
          events.push("commit-started");
          await commit.promise;
          events.push("commit-finished");
        },
        rollback: vi.fn(async () => {}),
      },
      () => {
        events.push("published");
      },
    );

    await vi.waitFor(() => expect(events).toEqual(["commit-started"]));
    commit.resolve();
    await operation;

    expect(events).toEqual(["commit-started", "commit-finished", "published"]);
  });

  it("does not publish when commit fails and attempts to release the upload", async () => {
    const failure = new Error("commit failed");
    const rollback = vi.fn(async () => {});
    const publish = vi.fn();

    await expect(commitUploadBeforePublish(
      { commit: async () => { throw failure; }, rollback },
      publish,
    )).rejects.toBe(failure);

    expect(publish).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not roll durable bytes back when local publication fails", async () => {
    const failure = new Error("editor closed");
    const rollback = vi.fn(async () => {});

    await expect(commitUploadBeforePublish(
      { commit: async () => {}, rollback },
      () => { throw failure; },
    )).rejects.toBe(failure);

    expect(rollback).not.toHaveBeenCalled();
  });
});
