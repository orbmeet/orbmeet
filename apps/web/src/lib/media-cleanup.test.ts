// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { stopMediaElementsInScope } from "./media-cleanup";

describe("stopMediaElementsInScope", () => {
  it("does not fall back to document-wide media cleanup when the scope is gone", () => {
    const stop = vi.fn();
    const video = document.createElement("video");
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      value: { getTracks: () => [{ stop }] },
      writable: true,
    });
    document.body.appendChild(video);

    stopMediaElementsInScope(null);

    expect(stop).not.toHaveBeenCalled();
    expect(video.srcObject).not.toBeNull();
    video.remove();
  });
});
