import { describe, expect, it } from "vitest";
import {
  MAX_DIAGNOSTIC_FIELDS,
  MAX_DIAGNOSTIC_KEY_LENGTH,
  MAX_DIAGNOSTIC_LIST_LENGTH,
  MAX_DIAGNOSTIC_VALUE_LENGTH,
  normaliseDiagnosticDetail,
  normaliseDiagnosticValue,
  parseClientDiagnostic,
} from "./diagnostic-contract";

describe("normaliseDiagnosticValue", () => {
  it("carries scalars through unchanged", () => {
    expect(normaliseDiagnosticValue("blocked")).toBe("blocked");
    expect(normaliseDiagnosticValue(42)).toBe(42);
    expect(normaliseDiagnosticValue(0)).toBe(0);
    expect(normaliseDiagnosticValue(true)).toBe(true);
    expect(normaliseDiagnosticValue(false)).toBe(false);
    expect(normaliseDiagnosticValue(null)).toBe(null);
  });

  it("truncates rather than dropping an oversized string", () => {
    const value = normaliseDiagnosticValue("x".repeat(1000));
    expect(value).toHaveLength(MAX_DIAGNOSTIC_VALUE_LENGTH);
  });

  it("keeps a bounded prefix of a string list", () => {
    const reasons = Array.from({ length: 50 }, (_, i) => `reason-${i}`);
    const value = normaliseDiagnosticValue(reasons);
    expect(value).toHaveLength(MAX_DIAGNOSTIC_LIST_LENGTH);
    expect((value as string[])[0]).toBe("reason-0");
  });

  it("refuses anything that could reach a log line as structure", () => {
    expect(normaliseDiagnosticValue({ nested: "value" })).toBeUndefined();
    expect(normaliseDiagnosticValue(() => "x")).toBeUndefined();
    expect(normaliseDiagnosticValue(undefined)).toBeUndefined();
    expect(normaliseDiagnosticValue(Number.NaN)).toBeUndefined();
    expect(normaliseDiagnosticValue(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("drops non-string entries from a list instead of carrying them", () => {
    expect(normaliseDiagnosticValue(["ok", { bad: 1 }, 2, "fine"])).toEqual([
      "ok",
      "fine",
    ]);
  });
});

describe("normaliseDiagnosticDetail", () => {
  it("keeps the capture classification the incident was filed to obtain", () => {
    // This is the payload `use-pre-join-devices` actually ships. Before the
    // contract existed, every one of these fields was stripped at ingest.
    expect(
      normaliseDiagnosticDetail({
        videoDevices: 1,
        audioDevices: 2,
        videoGranted: false,
        audioGranted: false,
        cameraReason: "blocked",
        microphoneReason: "blocked",
        videoErrorName: "NotAllowedError",
        audioErrorName: "NotAllowedError",
        usedSeparateProbes: true,
        enumerateTimedOut: false,
      }),
    ).toEqual({
      videoDevices: 1,
      audioDevices: 2,
      videoGranted: false,
      audioGranted: false,
      cameraReason: "blocked",
      microphoneReason: "blocked",
      videoErrorName: "NotAllowedError",
      audioErrorName: "NotAllowedError",
      usedSeparateProbes: true,
      enumerateTimedOut: false,
    });
  });

  it("caps the field count so a log line cannot be flooded", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field${i}`, i]),
    );
    expect(Object.keys(normaliseDiagnosticDetail(wide))).toHaveLength(
      MAX_DIAGNOSTIC_FIELDS,
    );
  });

  it("rejects oversized and empty keys", () => {
    const detail = normaliseDiagnosticDetail({
      ["k".repeat(MAX_DIAGNOSTIC_KEY_LENGTH + 1)]: "dropped",
      "": "dropped",
      kept: "kept",
    });
    expect(detail).toEqual({ kept: "kept" });
  });

  it("survives a non-object body", () => {
    expect(normaliseDiagnosticDetail(null)).toEqual({});
    expect(normaliseDiagnosticDetail("string")).toEqual({});
    expect(normaliseDiagnosticDetail([1, 2, 3])).toEqual({});
  });
});

describe("parseClientDiagnostic", () => {
  it("splits the envelope from the detail without losing either", () => {
    const parsed = parseClientDiagnostic({
      event: "device_probe_completed",
      ts: "2026-09-13T23:11:31.988Z",
      flowId: "flow-1",
      browser: { userAgent: "Browser/1" },
      microphoneReason: "blocked",
      audioGranted: false,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe("device_probe_completed");
    expect(parsed?.flowId).toBe("flow-1");
    expect(parsed?.browser?.userAgent).toBe("Browser/1");
    expect(parsed?.detail).toEqual({
      microphoneReason: "blocked",
      audioGranted: false,
    });
  });

  it("never lets one bad detail field cost the whole event", () => {
    // The reason detail is normalised rather than validated with `.catchall()`:
    // an event that fails to parse is an event the incident review does not have.
    const parsed = parseClientDiagnostic({
      event: "local_mic_failure",
      reason: "permission",
      hostile: { deeply: { nested: "object" } },
    });
    expect(parsed?.detail).toEqual({ reason: "permission" });
  });

  it("drops a descriptive envelope field that does not fit instead of the event", () => {
    const parsed = parseClientDiagnostic({
      event: "route_mounted",
      ts: "t".repeat(65),
      elapsedMs: -1,
      flowId: "flow-1",
    });
    expect(parsed?.event).toBe("route_mounted");
    expect(parsed?.ts).toBeUndefined();
    expect(parsed?.elapsedMs).toBeUndefined();
    expect(parsed?.flowId).toBe("flow-1");
  });

  it("rejects only an unusable envelope", () => {
    expect(parseClientDiagnostic({ detail: "no event name" })).toBeNull();
    expect(parseClientDiagnostic({ event: "" })).toBeNull();
    expect(parseClientDiagnostic(null)).toBeNull();
  });

  it("still refuses a forged browser snapshot", () => {
    expect(
      parseClientDiagnostic({
        event: "forged",
        browser: { arbitrary: { nested: "value" } },
      }),
    ).toBeNull();
    expect(
      parseClientDiagnostic({
        event: "forged",
        browser: { userAgent: "x".repeat(513) },
      }),
    ).toBeNull();
  });

  it("does not let a detail field shadow an envelope field", () => {
    const parsed = parseClientDiagnostic({
      event: "route_mounted",
      flowId: "real",
    });
    expect(parsed?.detail).not.toHaveProperty("flowId");
    expect(parsed?.flowId).toBe("real");
  });
});
