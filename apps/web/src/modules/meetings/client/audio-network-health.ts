export interface AudioSenderHealthSample {
  timestamp: number;
  packetsSent?: number;
  packetsLost?: number;
  jitter?: number;
  roundTripTime?: number;
}

export interface AudioNetworkHealth {
  degraded: boolean;
  packetLossRatio: number | null;
  jitter: number | null;
  roundTripTime: number | null;
  reasons: Array<"packet_loss" | "jitter" | "round_trip_time">;
}

const MIN_PACKETS_FOR_LOSS_SAMPLE = 20;
const DEGRADED_PACKET_LOSS_RATIO = 0.05;
const DEGRADED_JITTER_SECONDS = 0.1;
const DEGRADED_RTT_SECONDS = 0.5;

export function evaluateAudioNetworkHealth(
  previous: AudioSenderHealthSample,
  current: AudioSenderHealthSample,
): AudioNetworkHealth {
  const sentDelta = Math.max(
    0,
    (current.packetsSent ?? 0) - (previous.packetsSent ?? 0),
  );
  const lostDelta = Math.max(
    0,
    (current.packetsLost ?? 0) - (previous.packetsLost ?? 0),
  );
  const packetLossRatio =
    sentDelta >= MIN_PACKETS_FOR_LOSS_SAMPLE
      ? lostDelta / (sentDelta + lostDelta)
      : null;
  const jitter = current.jitter ?? null;
  const roundTripTime = current.roundTripTime ?? null;
  const reasons: AudioNetworkHealth["reasons"] = [];

  if (
    packetLossRatio !== null &&
    packetLossRatio >= DEGRADED_PACKET_LOSS_RATIO
  ) {
    reasons.push("packet_loss");
  }
  if (jitter !== null && jitter >= DEGRADED_JITTER_SECONDS) {
    reasons.push("jitter");
  }
  if (
    roundTripTime !== null &&
    roundTripTime >= DEGRADED_RTT_SECONDS
  ) {
    reasons.push("round_trip_time");
  }

  return {
    degraded: reasons.length > 0,
    packetLossRatio,
    jitter,
    roundTripTime,
    reasons,
  };
}
