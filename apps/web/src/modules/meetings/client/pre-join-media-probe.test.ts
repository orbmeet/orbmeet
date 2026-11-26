import { describe, expect, it, vi } from "vitest";
import {
  acquirePreJoinMedia,
  classifyMediaCaptureFailure,
  isMediaPermissionFailure,
  shouldRetryMediaKindsSeparately,
  withProbeTimeout,
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

  it("opens the microphone when the operating system blocks only the camera", async () => {
    // macOS or Windows privacy settings: camera off, microphone on. Chromium
    // refuses the combined request without saying which kind.
    const systemDenied = Object.assign(new Error("Permission denied by system"), { name: "NotAllowedError" });
    const microphone = {} as MediaStream;
    const request = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) throw systemDenied;
      return microphone;
    });

    const result = await acquirePreJoinMedia(request);

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.audioStream).toBe(microphone);
    expect(result.audioError).toBeNull();
    expect(result.videoError).toBe(systemDenied);
  });

  it("asks for the microphone alone when only the camera is blocked for the site", async () => {
    const denied = mediaError("NotAllowedError");
    const microphone = {} as MediaStream;
    const request = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) throw denied;
      return microphone;
    });
    const queryPermission = vi.fn(async (name: "camera" | "microphone") =>
      name === "camera" ? "denied" as const : "prompt" as const);

    const result = await acquirePreJoinMedia(request, queryPermission);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith({ audio: true }, "audio");
    expect(result.audioStream).toBe(microphone);
    expect(result.videoError).toBe(denied);
  });

  it.each([
    ["both blocked", "denied", "denied"],
    ["nothing stored", "prompt", "prompt"],
    ["unknown", null, null],
  ] as const)("does not ask again when the stored permissions are %s", async (_label, camera, microphone) => {
    const denied = mediaError("NotAllowedError");
    const request = vi.fn(async () => {
      throw denied;
    });

    const result = await acquirePreJoinMedia(request, async (name) => (name === "camera" ? camera : microphone));

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.audioError).toBe(denied);
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

  it("waits for the prompt's answer after a combined timeout while one may be open", async () => {
    const request = vi.fn(async () => null);

    for (const queryPermission of [undefined, async () => "prompt" as const]) {
      request.mockClear();
      const result = await acquirePreJoinMedia(request, queryPermission);
      expect(request).toHaveBeenCalledTimes(1);
      expect(result.streams).toEqual([]);
    }
  });

  it("asks for each kind alone when a granted combined request hangs", async () => {
    const microphone = {} as MediaStream;
    // A wedged camera: anything asking for video never answers in time.
    const request = vi.fn(async (_constraints: MediaStreamConstraints, kind: string) =>
      kind === "audio" ? microphone : null);

    const result = await acquirePreJoinMedia(request, async () => "granted");

    expect(request.mock.calls.map(([, kind]) => kind)).toEqual(["audio_video", "video", "audio"]);
    expect(result.audioStream).toBe(microphone);
    expect(result.videoStream).toBeNull();
    expect(result.usedSeparateProbes).toBe(true);
  });
});

describe("withProbeTimeout", () => {
  const blocked = new Error("NotAllowedError");
  it.each([
    ["an Allow", true, { status: "fulfilled", value: "stream" }],
    ["a Block", false, { status: "rejected", reason: blocked }],
  ] as const)("hands over %s that arrives after it stopped waiting", async (_label, allowed, expected) => {
    vi.useFakeTimers();
    try {
      let answer!: () => void;
      const prompt = new Promise<string>((resolve, reject) => {
        answer = () => (allowed ? resolve("stream") : reject(blocked));
      });
      const onLate = vi.fn();

      const result = withProbeTimeout(prompt, 8_000, () => {}, onLate);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toBeNull();

      answer();
      await vi.waitFor(() => expect(onLate).toHaveBeenCalledWith(expected));
    } finally {
      vi.useRealTimers();
    }
  });
});
