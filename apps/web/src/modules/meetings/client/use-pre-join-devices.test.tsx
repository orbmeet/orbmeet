// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreJoinDevices } from "./use-pre-join-devices";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let getUserMedia: ReturnType<typeof vi.fn>;

function Harness() {
  usePreJoinDevices();
  return null;
}

function abortError(): Error {
  return Object.assign(new Error("Timeout starting video source"), { name: "AbortError" });
}

beforeEach(() => {
  vi.useFakeTimers();
  // A wedged camera, as Chrome reports one: every request that includes
  // video rejects ten seconds later, after the probe stopped waiting.
  getUserMedia = vi.fn((constraints: MediaStreamConstraints) =>
    constraints.video
      ? new Promise((_, reject) => setTimeout(() => reject(abortError()), 10_000))
      : Promise.resolve({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }));
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: "granted" }) },
  });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePreJoinDevices", () => {
  it("does not keep probing a device that always answers late", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    // The first probe, and one more on its late answer: never a probe per answer.
    const combined = getUserMedia.mock.calls.filter(([constraints]) => constraints.audio && constraints.video);
    expect(combined).toHaveLength(2);
  });
});
