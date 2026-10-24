import * as React from "react";
import { Track, type LocalAudioTrack, type Room } from "livekit-client";
import {
  evaluateAudioNetworkHealth,
  type AudioSenderHealthSample,
} from "@/modules/meetings/client/audio-network-health";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";

const AUDIO_HEALTH_SAMPLE_INTERVAL_MS = 5_000;

export function useMeetingAudioNetworkHealth({
  room,
  isMicOn,
  code,
}: {
  room: Room | undefined;
  isMicOn: boolean;
  code: string;
}): void {
  React.useEffect(() => {
    if (!room || !isMicOn) return;

    let active = true;
    let sampling = false;
    let previous: AudioSenderHealthSample | null = null;
    let degradationReported = false;

    const sample = async () => {
      if (sampling) return;
      const publication = room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      const track = publication?.track;
      if (!track || track.kind !== Track.Kind.Audio || publication.isMuted) return;

      sampling = true;
      try {
        const current = await (track as LocalAudioTrack).getSenderStats();
        if (!active || !current) return;
        if (previous) {
          const health = evaluateAudioNetworkHealth(previous, current);
          if (health.degraded && !degradationReported) {
            degradationReported = true;
            emitMeetingEntryDiagnostic("local_audio_network_degraded", {
              code,
              reasons: health.reasons,
              packetLossRatio: health.packetLossRatio,
              jitter: health.jitter,
              roundTripTime: health.roundTripTime,
            });
          } else if (!health.degraded) {
            degradationReported = false;
          }
        }
        previous = current;
      } catch {
        // Stats are diagnostic-only and can disappear during reconnects.
      } finally {
        sampling = false;
      }
    };

    void sample();
    const interval = window.setInterval(() => void sample(), AUDIO_HEALTH_SAMPLE_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [code, isMicOn, room]);
}
