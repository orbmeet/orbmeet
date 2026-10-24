import * as React from "react";
import { RoomEvent, Track, type RemoteParticipant, type Room } from "livekit-client";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import { logWarn } from "@/lib/logger";
import type { useToast } from "@orbmeet/ui/react";

/**
 * Surfaces and best-effort recovers from remote-track subscription failures.
 *
 * When the SFU can't bind a remote track (audio or video) within its timeout —
 * seen in production as server-side `track not bound after timeout` warnings —
 * livekit-client emits `RoomEvent.TrackSubscriptionFailed`. Previously nothing
 * in the app listened, so a participant whose mic/video track failed to
 * subscribe was met with silent audio (or an invisible tile) and no indication,
 * with recovery only on a full reconnect.
 *
 * Runtime payload (livekit-client 2.x): `(trackSid, participant, error)` — note
 * `participant` precedes `error`, which differs from the order the .d.ts doc
 * comment states.
 *
 * For each failure this hook:
 *   - emits a diagnostic for observability,
 *   - attempts one best-effort re-subscribe via `publication.setSubscribed(true)`,
 *   - and, de-duped per (participant, trackSid) within a cooldown window, shows
 *     a toast so the listener knows they may be missing audio/video. A burst of
 *     failures for one speaker produces one toast, not spam.
 *
 * It deliberately does not retry in a loop: a persistent bind failure usually
 * means the publisher's track itself is unhealthy, which resolves when they
 * mute/unmute or rejoin — not when we hammer re-subscribe.
 */
export const SUBSCRIPTION_FAILURE_TOAST_COOLDOWN_MS = 15_000;

/** Best-effort classify a failed track as "audio"/"video"/"unknown". */
export function describeSubscriptionFailureKind(
  participant: RemoteParticipant,
  trackSid: string,
): "audio" | "video" | "unknown" {
  const publication = participant.getTrackPublicationBySid(trackSid);
  const trackKind = publication?.kind;
  if (trackKind === Track.Kind.Audio) return "audio";
  if (trackKind === Track.Kind.Video) return "video";
  return "unknown";
}

/**
 * Decide whether a toast should be shown for this failure, given the per-key
 * last-shown timestamps. Pure: returns the updated timestamp map and whether to
 * toast. The cooldown prevents a single failing track from toasting on repeat.
 */
export function decideSubscriptionFailureToast(
  lastToastedAt: Map<string, number>,
  dedupeKey: string,
  now: number,
  cooldownMs: number = SUBSCRIPTION_FAILURE_TOAST_COOLDOWN_MS,
): { toast: boolean; nextLastToastedAt: Map<string, number> } {
  const last = lastToastedAt.get(dedupeKey);
  if (last !== undefined && now - last < cooldownMs) {
    return { toast: false, nextLastToastedAt: lastToastedAt };
  }
  const next = new Map(lastToastedAt);
  next.set(dedupeKey, now);
  return { toast: true, nextLastToastedAt: next };
}

export function useTrackSubscriptionFailures({
  roomInstance,
  addToast,
  code,
}: {
  roomInstance: Room | undefined;
  addToast: ReturnType<typeof useToast>["add"];
  code: string;
}): void {
  const lastToastedAtRef = React.useRef<Map<string, number>>(new Map());

  React.useEffect(() => {
    if (!roomInstance) return;

    const handleSubscriptionFailed = (
      trackSid: string,
      participant: RemoteParticipant,
      error: unknown,
    ) => {
      const kind = describeSubscriptionFailureKind(participant, trackSid);
      const errorMessage = error instanceof Error ? error.message : String(error);

      emitMeetingEntryDiagnostic("remote_track_subscription_failed", {
        code,
        trackSid,
        kind,
        participantIdentity: participant.identity,
        errorMessage,
      });

      // Best-effort single re-subscribe. If the publication exists and isn't
      // subscribed, ask for it again; if it lands, great, otherwise the toast
      // tells the user what to expect. Never a retry loop.
      const publication = participant.getTrackPublicationBySid(trackSid);
      if (publication && !publication.isSubscribed) {
        try {
          publication.setSubscribed(true);
        } catch (err) {
          logWarn("[Meeting] Re-subscribe attempt failed:", err);
        }
      }

      const dedupeKey = `${participant.identity}:${trackSid}`;
      const decision = decideSubscriptionFailureToast(
        lastToastedAtRef.current,
        dedupeKey,
        Date.now(),
      );
      lastToastedAtRef.current = decision.nextLastToastedAt;
      if (!decision.toast) return;

      const displayName = participant.name?.trim() || "A participant";
      const what = kind === "video" ? "video" : "audio";
      addToast({
        title: `${displayName}'s ${what} is unavailable`,
        description: `Couldn't receive their ${what}. They may need to turn it back on, or try rejoining.`,
        data: { variant: "info" },
      });
    };

    roomInstance.on(RoomEvent.TrackSubscriptionFailed, handleSubscriptionFailed);
    return () => {
      roomInstance.off(RoomEvent.TrackSubscriptionFailed, handleSubscriptionFailed);
    };
  }, [addToast, code, roomInstance]);
}
