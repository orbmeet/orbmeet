import { describe, expect, it } from "vitest";
import { evaluateAudioNetworkHealth } from "./audio-network-health";

describe("evaluateAudioNetworkHealth", () => {
  it("reports healthy conversational audio", () => {
    expect(
      evaluateAudioNetworkHealth(
        { timestamp: 1_000, packetsSent: 100, packetsLost: 1 },
        {
          timestamp: 6_000,
          packetsSent: 200,
          packetsLost: 2,
          jitter: 0.02,
          roundTripTime: 0.08,
        },
      ),
    ).toMatchObject({ degraded: false, reasons: [] });
  });

  it("detects material packet loss over the sample window", () => {
    const health = evaluateAudioNetworkHealth(
      { timestamp: 1_000, packetsSent: 100, packetsLost: 0 },
      { timestamp: 6_000, packetsSent: 200, packetsLost: 10 },
    );

    expect(health.degraded).toBe(true);
    expect(health.packetLossRatio).toBeCloseTo(10 / 110);
    expect(health.reasons).toContain("packet_loss");
  });

  it("does not classify DTX-sized packet windows as packet loss", () => {
    const health = evaluateAudioNetworkHealth(
      { timestamp: 1_000, packetsSent: 100, packetsLost: 0 },
      { timestamp: 6_000, packetsSent: 102, packetsLost: 2 },
    );

    expect(health.packetLossRatio).toBeNull();
    expect(health.degraded).toBe(false);
  });

  it("detects high jitter and round-trip time independently", () => {
    const health = evaluateAudioNetworkHealth(
      { timestamp: 1_000 },
      { timestamp: 6_000, jitter: 0.12, roundTripTime: 0.7 },
    );

    expect(health.reasons).toEqual(["jitter", "round_trip_time"]);
  });
});
