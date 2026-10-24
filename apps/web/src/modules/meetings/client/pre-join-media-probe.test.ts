import { describe, expect, it, vi } from "vitest";
import {
  acquirePreJoinMedia,
  classifyMediaCaptureFailure,
  getMicrophoneCaptureFailureMessage,
  isMediaPermissionFailure,
  shouldRetryMediaKindsSeparately,
} from "./pre-join-media-probe";

function mediaError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe("pre-join media probe policy", () => {
  it.each(["NotAllowedError", "PermissionDeniedError"])(
    "does not issue another prompt after %s",
    (name) => {
      const error = mediaError(name);
      expect(isMediaPermissionFailure(error)).toBe(true);
      expect(shouldRetryMediaKindsSeparately(error)).toBe(false);
    },
  );

  it.each(["NotFoundError", "NotReadableError", "OverconstrainedError"])(
    "retries camera and microphone independently after %s",
    (name) => {
      expect(shouldRetryMediaKindsSeparately(mediaError(name))).toBe(true);
    },
  );

  it.each([
    ["NotAllowedError", "permission-denied"],
    ["NotFoundError", "not-found"],
    ["NotReadableError", "device-in-use"],
    ["OverconstrainedError", "constraints"],
    ["AbortError", "unknown"],
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(classifyMediaCaptureFailure(mediaError(name))).toBe(kind);
  });

  it("does not claim an unknown capture failure means the microphone is busy", () => {
    expect(getMicrophoneCaptureFailureMessage(mediaError("AbortError"))).not.toContain("in use");
  });

  it("uses one combined request on the healthy path", async () => {
    const combined = {} as MediaStream;
    const request = vi.fn(async () => combined);

    const result = await acquirePreJoinMedia(request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      { audio: true, video: true },
      "audio_video",
    );
    expect(result.audioStream).toBe(combined);
    expect(result.videoStream).toBe(combined);
    expect(result.usedSeparateProbes).toBe(false);
  });

  it("does not retry after permission denial", async () => {
    const denied = mediaError("NotAllowedError");
    const request = vi.fn(async () => {
      throw denied;
    });

    const result = await acquirePreJoinMedia(request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.audioError).toBe(denied);
    expect(result.videoError).toBe(denied);
  });

  it("salvages audio when combined capture and camera fallback fail", async () => {
    const microphone = {} as MediaStream;
    const request = vi.fn(
      async (_constraints: MediaStreamConstraints, kind: string) => {
        if (kind === "audio_video") throw mediaError("NotReadableError");
        if (kind === "video") throw mediaError("NotReadableError");
        return microphone;
      },
    );

    const result = await acquirePreJoinMedia(request);

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.audioStream).toBe(microphone);
    expect(result.videoStream).toBeNull();
    expect(result.usedSeparateProbes).toBe(true);
  });

  it("does not start fallback requests after a combined timeout", async () => {
    const request = vi.fn(async () => null);

    const result = await acquirePreJoinMedia(request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.streams).toEqual([]);
  });
});
