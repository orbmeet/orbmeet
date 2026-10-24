import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { incomingRequest } from "../../test/requests.ts";
import { getContentLength, readBoundedJson, readStreamWithTimeouts } from "./http.ts";

/** A body the test writes into as it goes. */
function controlledBody(): { body: PassThrough; controller: { enqueue(chunk: Uint8Array): void; close(): void } } {
  const body = new PassThrough();
  return { body, controller: { enqueue: (chunk) => body.write(chunk), close: () => body.end() } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readStreamWithTimeouts", () => {
  it("accepts a progressing upload that exceeds the idle timeout in total", async () => {
    vi.useFakeTimers();
    const { body, controller } = controlledBody();
    const chunks: number[] = [];
    const read = readStreamWithTimeouts(
      body,
      { idleMs: 100, totalMs: 500 },
      (chunk) => {
        chunks.push(chunk[0]);
      },
    );

    for (const value of [1, 2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(80);
      controller.enqueue(Uint8Array.of(value));
    }
    controller.close();

    await expect(read).resolves.toBeUndefined();
    expect(chunks).toEqual([1, 2, 3, 4]);
  });

  it("rejects an upload that stops making progress", async () => {
    vi.useFakeTimers();
    const { body } = controlledBody();
    const read = readStreamWithTimeouts(
      body,
      { idleMs: 100, totalMs: 500 },
      () => {},
    );

    const rejection = read.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(await rejection).toEqual(new Error("read_timeout"));
  });

  it("rejects a trickling upload at the total deadline", async () => {
    vi.useFakeTimers();
    const { body, controller } = controlledBody();
    const read = readStreamWithTimeouts(
      body,
      { idleMs: 100, totalMs: 200 },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(80);
    controller.enqueue(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(80);
    controller.enqueue(Uint8Array.of(2));

    const rejection = read.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(41);
    expect(await rejection).toEqual(new Error("read_timeout"));
  });
});

describe("readBoundedJson body shape", () => {
  const post = (body: string) =>
    incomingRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

  it("rejects every JSON value that is not an object", async () => {
    // Callers read properties off the result, so `null` parsed cleanly and
    // then threw a TypeError on first access instead of answering 400.
    for (const body of ["null", "true", "1", '"x"', "[]"]) {
      await expect(readBoundedJson(post(body))).rejects.toThrow("invalid_json");
    }
  });

  it("accepts an ordinary object body", async () => {
    await expect(readBoundedJson<{ url?: string }>(post('{"url":"https://a.test"}')))
      .resolves.toEqual({ url: "https://a.test" });
  });
});

describe("getContentLength", () => {
  const withHeader = (value: string) =>
    getContentLength(incomingRequest({ method: "POST", headers: { "Content-Length": value } }));

  it("reads a plain non-negative integer", () => {
    expect(withHeader("0")).toBe(0);
    expect(withHeader(" 1024 ")).toBe(1024);
  });

  it("treats anything that is not a size as undeclared", () => {
    // `parseInt` read a prefix and stopped, so each of these came back as a
    // small (or negative) number that sailed past the size check.
    for (const value of ["5x", "0x1000", "-1", "1e9", "", "  ", "1.5"]) {
      expect(withHeader(value)).toBeNull();
    }
  });
});
