import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecorderBootstrapToken,
  RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS,
  verifyRecorderBootstrapToken,
} from "./recorder-bootstrap-token";

const ENV = { AUTH_SECRET: "test-secret-at-least-32-chars-long!!" };
const MEETING_ID = "mtg_123";

describe("recorder bootstrap token", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a valid recorder bootstrap token", async () => {
    const token = await createRecorderBootstrapToken(ENV, MEETING_ID);

    const claims = await verifyRecorderBootstrapToken(token, ENV);

    expect(claims.purpose).toBe("whiteboard-recorder-bootstrap");
    expect(claims.meetingId).toBe(MEETING_ID);
    expect(claims.nonce).toMatch(/^[a-f0-9-]{36}$/i);
    expect(claims.exp - claims.iat).toBe(RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS);
  });

  it("rejects tokens signed with another secret", async () => {
    const token = await createRecorderBootstrapToken(ENV, MEETING_ID);

    await expect(verifyRecorderBootstrapToken(token, { AUTH_SECRET: "wrong-secret" })).rejects.toThrow(
      "Invalid recorder bootstrap token signature",
    );
  });

  it("rejects tampered payloads", async () => {
    const token = await createRecorderBootstrapToken(ENV, MEETING_ID);
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      meetingId: string;
    };
    decoded.meetingId = "mtg_other";
    const tamperedPayload = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expect(
      verifyRecorderBootstrapToken(`${tamperedPayload}.${signature}`, ENV),
    ).rejects.toThrow("Invalid recorder bootstrap token signature");
  });

  it("rejects issued-at values too far in the future", async () => {
    vi.useFakeTimers();
    const token = await createRecorderBootstrapToken(ENV, MEETING_ID);
    vi.setSystemTime(Date.now() - 120_000);

    await expect(verifyRecorderBootstrapToken(token, ENV)).rejects.toThrow(
      "Recorder bootstrap token issued-at is in the future",
    );
  });

  it("rejects expired tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const token = await createRecorderBootstrapToken(ENV, MEETING_ID);
    vi.setSystemTime(Date.now() + (RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS + 120) * 1000);

    await expect(verifyRecorderBootstrapToken(token, ENV)).rejects.toThrow(
      "Recorder bootstrap token has expired",
    );
  });
});
