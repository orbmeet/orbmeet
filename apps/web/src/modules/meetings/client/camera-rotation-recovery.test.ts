import { describe, expect, it } from "vitest";
import { shouldRestartCameraAfterRotation } from "./camera-rotation-recovery";

describe("shouldRestartCameraAfterRotation", () => {
  it("does not restart when the viewport did not actually rotate (rotation lock)", () => {
    // Rotation lock on: an orientation event fired but the viewport stayed
    // portrait. The track being landscape here is a real-world possibility
    // (physical device turned while the UI stayed locked) and must NOT trigger
    // a restart, since the interface has no new orientation for the track.
    expect(
      shouldRestartCameraAfterRotation({
        lastViewportPortrait: true,
        viewportPortrait: true,
        trackWidth: 1280,
        trackHeight: 720,
      }),
    ).toEqual({ restart: false, nextViewportPortrait: true });
  });

  it("restarts when the viewport rotated and the track is stuck in the old orientation", () => {
    expect(
      shouldRestartCameraAfterRotation({
        lastViewportPortrait: true,
        viewportPortrait: false,
        trackWidth: 720,
        trackHeight: 1280,
      }),
    ).toEqual({ restart: true, nextViewportPortrait: false });
  });

  it("does not restart when the viewport rotated and the track already followed", () => {
    expect(
      shouldRestartCameraAfterRotation({
        lastViewportPortrait: true,
        viewportPortrait: false,
        trackWidth: 1280,
        trackHeight: 720,
      }),
    ).toEqual({ restart: false, nextViewportPortrait: false });
  });

  it("consumes the rotation but does not restart when track dimensions are unavailable", () => {
    expect(
      shouldRestartCameraAfterRotation({
        lastViewportPortrait: true,
        viewportPortrait: false,
        trackWidth: undefined,
        trackHeight: undefined,
      }),
    ).toEqual({ restart: false, nextViewportPortrait: false });
  });

  it("processes a given rotation at most once", () => {
    // First event: portrait -> landscape, track stuck -> restart.
    const first = shouldRestartCameraAfterRotation({
      lastViewportPortrait: true,
      viewportPortrait: false,
      trackWidth: 720,
      trackHeight: 1280,
    });
    expect(first).toEqual({ restart: true, nextViewportPortrait: false });

    // A second spurious event with the same (locked) viewport must not restart
    // again, even if the track dimensions still read as stuck.
    const second = shouldRestartCameraAfterRotation({
      lastViewportPortrait: first.nextViewportPortrait,
      viewportPortrait: false,
      trackWidth: 720,
      trackHeight: 1280,
    });
    expect(second).toEqual({ restart: false, nextViewportPortrait: false });
  });

  it("restarts again after a genuine return to the previous orientation", () => {
    const first = shouldRestartCameraAfterRotation({
      lastViewportPortrait: true,
      viewportPortrait: false,
      trackWidth: 720,
      trackHeight: 1280,
    });
    expect(first.restart).toBe(true);

    // Rotate back landscape -> portrait, track stuck in landscape.
    expect(
      shouldRestartCameraAfterRotation({
        lastViewportPortrait: first.nextViewportPortrait,
        viewportPortrait: true,
        trackWidth: 1280,
        trackHeight: 720,
      }),
    ).toEqual({ restart: true, nextViewportPortrait: true });
  });
});
