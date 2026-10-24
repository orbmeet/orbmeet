import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTlsEndpoint } from "./healthcheck.js";
import {
  isUnhealthyTranscriptionConnection,
  readActiveTranscriptionConnectionStatuses,
  recordTranscriptionConnectionStatus,
  recordTranscriptionResultLoss,
  removeTranscriptionConnectionStatus,
  type TranscriptionConnectionStatus,
} from "./outbox/transcription-health.js";

describe("transcription health checks", () => {
  it("normalizes HTTPS and WSS endpoints", () => {
    expect(getTlsEndpoint("wss://livekit.example")).toEqual({
      host: "livekit.example",
      port: 443,
    });
    expect(getTlsEndpoint("https://api.example:8443/path")).toEqual({
      host: "api.example",
      port: 8443,
    });
  });

  it("rejects plaintext endpoints", () => {
    expect(() => getTlsEndpoint("http://api.example")).toThrow(
      "http: is not a TLS endpoint",
    );
  });

  // The verdict itself; what a caller does with it is separate, and
  // deliberately not a readiness failure — see `isUnhealthyTranscriptionConnection`.
  it("reports failed or stuck active transcription connections as unhealthy", () => {
    const now = Date.parse("2026-06-30T17:00:00.000Z");
    const status = (phase: TranscriptionConnectionStatus["phase"], updatedAt: string) => ({
      id: "connection-1",
      phase,
      pid: 123,
      updatedAt,
    });

    expect(isUnhealthyTranscriptionConnection(
      status("connecting", "2026-06-30T16:59:50.000Z"),
      now,
    )).toBe(false);
    expect(isUnhealthyTranscriptionConnection(
      status("connecting", "2026-06-30T16:59:40.000Z"),
      now,
    )).toBe(false);
    expect(isUnhealthyTranscriptionConnection(
      status("connecting", "2026-06-30T16:59:00.000Z"),
      now,
    )).toBe(true);
    expect(isUnhealthyTranscriptionConnection(
      status("failed", "2026-06-30T16:59:59.000Z"),
      now,
    )).toBe(true);
    // A status stamped well ahead of the reader's clock cannot be a connect
    // still in progress, and `now - updatedAt` stays negative forever — so the
    // grace period could never expire a genuinely stuck one.
    expect(isUnhealthyTranscriptionConnection(
      status("connecting", "2026-06-30T17:05:00.000Z"),
      now,
    )).toBe(true);
    // Coarse-clock noise is not a rollback.
    expect(isUnhealthyTranscriptionConnection(
      status("connecting", "2026-06-30T17:00:01.000Z"),
      now,
    )).toBe(false);
    expect(isUnhealthyTranscriptionConnection(
      status("connected", "2026-06-30T16:00:00.000Z"),
      now,
    )).toBe(false);
  });

  it("keeps invalid telemetry operations from replacing job outcomes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => recordTranscriptionConnectionStatus("invalid/id", "connecting"))
      .not.toThrow();
    expect(() => removeTranscriptionConnectionStatus("invalid/id"))
      .not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});

describe("transcription result loss counter", () => {
  // Real status directory is shared; a unique per-test id keeps this isolated.
  const id = `test-${randomUUID()}`;

  function statusById(): TranscriptionConnectionStatus | undefined {
    return readActiveTranscriptionConnectionStatuses().find((status) => status.id === id);
  }

  it("accrues on the connection's status and survives later phase rewrites", () => {
    recordTranscriptionConnectionStatus(id, "connected");
    try {
      recordTranscriptionResultLoss(id, "seg-a: result backlog reached 200");
      recordTranscriptionResultLoss(id, "seg-b: no capture timestamp");

      const status = statusById();
      expect(status?.droppedResults).toBe(2);
      expect(status?.lastDropReason).toContain("seg-b");
      expect(status?.phase).toBe("connected");

      // A Deepgram recovery rewrites the phase; the loss record must survive.
      recordTranscriptionConnectionStatus(id, "connecting");
      const afterReconnect = statusById();
      expect(afterReconnect?.phase).toBe("connecting");
      expect(afterReconnect?.droppedResults).toBe(2);
      expect(afterReconnect?.lastDropReason).toContain("seg-b");
    } finally {
      removeTranscriptionConnectionStatus(id);
    }
  });

  it("is a quiet no-op once the connection status is gone", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => recordTranscriptionResultLoss(`test-${randomUUID()}`, "late drop"))
        .not.toThrow();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
