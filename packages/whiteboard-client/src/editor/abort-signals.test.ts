import { describe, expect, it } from "vitest";
import { anySignal } from "./abort-signals";

const native = AbortSignal.any;

/**
 * Stand in for Safari 16.4-17.3 and Firefox 114-123, which ship no `any`. The
 * restore is in a `finally` so a failing assertion cannot leak the missing
 * global into the rest of the file.
 */
function withoutNativeAny(run: () => void) {
  Reflect.deleteProperty(AbortSignal, "any");
  try {
    run();
  } finally {
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      writable: true,
      value: native,
    });
  }
}

describe("anySignal", () => {
  it("uses the platform implementation when there is one", () => {
    const controller = new AbortController();
    const composed = anySignal([controller.signal, AbortSignal.timeout(10_000)]);

    expect(composed.aborted).toBe(false);
    controller.abort(new Error("teardown"));
    expect(composed.aborted).toBe(true);
  });

  it("aborts with the first source's reason where the platform has no `any`", () => {
    withoutNativeAny(() => {
      const first = new AbortController();
      const second = new AbortController();
      const composed = anySignal([first.signal, second.signal]);

      expect(composed.aborted).toBe(false);
      const reason = new Error("teardown");
      first.abort(reason);

      expect(composed.aborted).toBe(true);
      expect(composed.reason).toBe(reason);

      // A later abort on the other source cannot change what already happened.
      second.abort(new Error("timeout"));
      expect(composed.reason).toBe(reason);
    });
  });

  it("is already aborted when a source is, carrying that reason", () => {
    withoutNativeAny(() => {
      const reason = new Error("gone before we asked");
      const composed = anySignal([AbortSignal.abort(reason), new AbortController().signal]);

      expect(composed.aborted).toBe(true);
      expect(composed.reason).toBe(reason);
    });
  });

  it("stops listening to sources that outlive the composite", () => {
    withoutNativeAny(() => {
      const longLived = new AbortController();
      const request = new AbortController();
      let listeners = 0;
      const { addEventListener, removeEventListener } = longLived.signal;
      longLived.signal.addEventListener = (...args: Parameters<typeof addEventListener>) => {
        listeners += 1;
        return addEventListener.apply(longLived.signal, args);
      };
      longLived.signal.removeEventListener = (
        ...args: Parameters<typeof removeEventListener>
      ) => {
        listeners -= 1;
        return removeEventListener.apply(longLived.signal, args);
      };

      anySignal([longLived.signal, request.signal]);
      expect(listeners).toBe(1);

      // The per-request signal aborts; the page-lifetime one must not be left
      // holding a reference to every composite ever made from it.
      request.abort();
      expect(listeners).toBe(0);
    });
  });
});
