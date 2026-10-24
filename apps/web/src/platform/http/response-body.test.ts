import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
  readResponseBodyBytes,
} from "./response-body";

afterEach(() => vi.useRealTimers());

describe("readResponseBodyBytes", () => {
  it("rejects and cancels a response that crosses the byte cap", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    }));

    await expect(readResponseBodyBytes(response, 5, 1_000))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a body that stalls after headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel,
    }));
    const read = readResponseBodyBytes(response, 1024, 5_000);
    const outcome = read.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toBeInstanceOf(ResponseBodyTimeoutError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
