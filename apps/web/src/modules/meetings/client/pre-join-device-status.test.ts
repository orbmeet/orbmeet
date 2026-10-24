import { describe, expect, it } from "vitest";

import {
  type DeviceUnavailableReason,
  type MediaKindStatus,
  applyDeviceChangeToStatus,
  classifyDeviceFailure,
  getDeviceNotice,
  getDevicePickerPlaceholder,
  getToggleBlockedReason,
  willJoinSilent,
} from "./pre-join-device-status";

function mediaError(name: string): DOMException {
  return new DOMException(`${name} raised`, name);
}

const READY: MediaKindStatus = { state: "ready" };

function blocked(reason: DeviceUnavailableReason): MediaKindStatus {
  return { state: "unavailable", reason };
}

describe("classifyDeviceFailure", () => {
  it.each([
    ["NotAllowedError", "permission-denied"],
    ["PermissionDeniedError", "permission-denied"],
    ["SecurityError", "permission-denied"],
    ["NotFoundError", "not-found"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["OverconstrainedError", "constraints"],
  ])("maps %s to %s", (name, expected) => {
    expect(classifyDeviceFailure({ error: mediaError(name), enumeratedCount: 1 })).toBe(expected);
  });

  it("keeps permission-denied even when the device list looks empty", () => {
    // The regression this whole module exists for. A denied prompt leaves the
    // device with a blank deviceId, the concrete filter drops it, and the old
    // code concluded "no microphone" from the empty list.
    expect(
      classifyDeviceFailure({ error: mediaError("NotAllowedError"), enumeratedCount: 0 }),
    ).toBe("permission-denied");
  });

  it("falls back to not-found only when nothing was enumerated", () => {
    expect(classifyDeviceFailure({ error: new Error("boom"), enumeratedCount: 0 })).toBe("not-found");
    expect(classifyDeviceFailure({ error: new Error("boom"), enumeratedCount: 2 })).toBe("unknown");
  });

  it("reports a timeout regardless of the underlying error", () => {
    expect(
      classifyDeviceFailure({ error: mediaError("NotAllowedError"), enumeratedCount: 0, timedOut: true }),
    ).toBe("timeout");
  });
});

describe("getDevicePickerPlaceholder", () => {
  it("says blocked, not undetected, for a denied permission", () => {
    const label = getDevicePickerPlaceholder("microphone", blocked("permission-denied"));
    expect(label).toBe("Microphone blocked");
    expect(label).not.toMatch(/detected/i);
  });

  it("reserves 'No microphone detected' for genuinely absent hardware", () => {
    expect(getDevicePickerPlaceholder("microphone", blocked("not-found"))).toBe(
      "No microphone detected",
    );
  });

  it("distinguishes a busy device", () => {
    expect(getDevicePickerPlaceholder("camera", blocked("in-use"))).toBe("Camera in use");
  });

  it("shows a loading state while pending", () => {
    expect(getDevicePickerPlaceholder("camera", { state: "pending" })).toBe("Loading…");
  });
});

describe("getToggleBlockedReason", () => {
  it("returns null for a working device so the toggle stays a plain toggle", () => {
    expect(getToggleBlockedReason("microphone", READY)).toBeNull();
    expect(getToggleBlockedReason("microphone", { state: "pending" })).toBeNull();
  });

  it("points a denied microphone at the browser, not at the hardware", () => {
    const reason = getToggleBlockedReason("microphone", blocked("permission-denied"));
    expect(reason).toMatch(/blocked in your browser/i);
    expect(reason).not.toMatch(/connect one/i);
  });

  it("points a missing microphone at the hardware, not at the browser", () => {
    const reason = getToggleBlockedReason("microphone", blocked("not-found"));
    expect(reason).toMatch(/connect one/i);
    expect(reason).not.toMatch(/browser settings/i);
  });
});

describe("getDeviceNotice", () => {
  it("is silent when both kinds work", () => {
    expect(getDeviceNotice({ camera: READY, microphone: READY })).toBeNull();
  });

  it("is silent while the probe is still running", () => {
    expect(getDeviceNotice({ camera: { state: "pending" }, microphone: READY })).toBeNull();
  });

  it("merges a shared reason into one sentence about both devices", () => {
    const notice = getDeviceNotice({
      camera: blocked("permission-denied"),
      microphone: blocked("permission-denied"),
    });
    expect(notice?.message).toBe(
      "Camera and microphone access is blocked in your browser. Allow it in the address bar, then retry.",
    );
    expect(notice?.consequence).toMatch(/audio and video off/i);
  });

  it("names the consequence of a lost microphone in terms of being heard", () => {
    const notice = getDeviceNotice({ camera: READY, microphone: blocked("not-found") });
    expect(notice?.consequence).toMatch(/no one will hear you/i);
  });

  it("does not offer a retry that cannot help", () => {
    const insecure = getDeviceNotice({
      camera: blocked("insecure-context"),
      microphone: blocked("insecure-context"),
    });
    expect(insecure?.retryable).toBe(false);

    const denied = getDeviceNotice({ camera: READY, microphone: blocked("permission-denied") });
    expect(denied?.retryable).toBe(true);
  });

  it("reports both reasons when they differ", () => {
    const notice = getDeviceNotice({
      camera: blocked("in-use"),
      microphone: blocked("permission-denied"),
    });
    expect(notice?.message).toMatch(/blocked in your browser/i);
    expect(notice?.message).toMatch(/in use by another app/i);
  });
});

describe("willJoinSilent", () => {
  it("is true only when the microphone is unusable", () => {
    expect(willJoinSilent({ camera: blocked("not-found"), microphone: READY })).toBe(false);
    expect(willJoinSilent({ camera: READY, microphone: blocked("permission-denied") })).toBe(true);
  });
});

describe("applyDeviceChangeToStatus", () => {
  // The regression: a concrete device id is only ever exposed after a grant, so
  // a `devicechange` reporting none is equally consistent with "no hardware"
  // and "blocked" — and the blocked verdict is the one that tells the user what
  // to do about it.
  it("keeps a permission block when a hotplug reports no devices", () => {
    expect(
      applyDeviceChangeToStatus(
        { state: "unavailable", reason: "permission-denied" },
        false,
      ),
    ).toEqual({ state: "unavailable", reason: "permission-denied" });
  });

  it("clears a permission block once concrete devices appear", () => {
    expect(
      applyDeviceChangeToStatus(
        { state: "unavailable", reason: "permission-denied" },
        true,
      ),
    ).toEqual({ state: "ready" });
  });

  it("recovers from not-found when a device is plugged in", () => {
    expect(
      applyDeviceChangeToStatus({ state: "unavailable", reason: "not-found" }, true),
    ).toEqual({ state: "ready" });
  });

  it("reports not-found when a working device is unplugged", () => {
    expect(applyDeviceChangeToStatus({ state: "ready" }, false)).toEqual({
      state: "unavailable",
      reason: "not-found",
    });
  });

  // Enumeration says nothing about whether acquisition would succeed, so an
  // acquisition verdict stands until something actually reprobes.
  it("leaves an in-use verdict alone while the device is still listed", () => {
    expect(
      applyDeviceChangeToStatus({ state: "unavailable", reason: "in-use" }, true),
    ).toEqual({ state: "unavailable", reason: "in-use" });
  });

  it("leaves an environment verdict alone when no devices are listed", () => {
    expect(
      applyDeviceChangeToStatus(
        { state: "unavailable", reason: "insecure-context" },
        false,
      ),
    ).toEqual({ state: "unavailable", reason: "insecure-context" });
  });
});
