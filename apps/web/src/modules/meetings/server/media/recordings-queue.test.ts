import { describe, expect, it } from "vitest";
import {
  RECORDING_UPLOAD_MAX_RETRIES,
  RECORDINGS_QUEUE_RETENTION_SECONDS,
  recordingRetryDelaySeconds,
} from "./recordings-queue";

describe("recording upload retries", () => {
  it("back off from a minute to a day", () => {
    expect(recordingRetryDelaySeconds(1)).toBe(60);
    expect(recordingRetryDelaySeconds(2)).toBe(120);
    expect(recordingRetryDelaySeconds(RECORDING_UPLOAD_MAX_RETRIES)).toBe(24 * 60 * 60);
  });

  it("all fall inside the queue's retention, with no day of it left unused", () => {
    let elapsed = 0;
    for (let attempts = 1; attempts <= RECORDING_UPLOAD_MAX_RETRIES; attempts += 1) {
      elapsed += recordingRetryDelaySeconds(attempts);
    }
    expect(elapsed).toBeLessThan(RECORDINGS_QUEUE_RETENTION_SECONDS);
    expect(elapsed + recordingRetryDelaySeconds(RECORDING_UPLOAD_MAX_RETRIES + 1))
      .toBeGreaterThanOrEqual(RECORDINGS_QUEUE_RETENTION_SECONDS);
  });
});
