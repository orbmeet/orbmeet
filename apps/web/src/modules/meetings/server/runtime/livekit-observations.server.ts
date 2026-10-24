import "@tanstack/react-start/server-only";
import type { WebhookEvent } from "livekit-server-sdk";
import { meetingIdFromLiveKitRoom } from "@/modules/meetings/contract/livekit-room";
import { liveKitWebhookCreatedAt } from "@/modules/meetings/server/webhook/event-time";
import { observeEgressInfo, sessionJoinedAt } from "./effects.server";
import type { Observation } from "./protocol";

/**
 * What a LiveKit webhook tells a meeting's room. The room's observations are
 * its own protocol (./protocol.ts); this is where the provider's events become
 * them, so nothing outside the runtime has to speak it.
 */
/** The observation an event carries for a meeting's coordinator, if any. */
export function observationFor(event: WebhookEvent): { meetingId: string; observation: Observation } | null {
  const createdAt = liveKitWebhookCreatedAt(event)?.getTime() ?? null;
  const at = createdAt ?? Date.now();
  const participant = event.participant;
  // Agents, recorders and ingress are not app participants.
  const standard = participant?.kind === undefined || participant.kind === 0;

  switch (event.event) {
    case "participant_joined":
    case "participant_left":
    case "participant_connection_aborted": {
      const meetingId = meetingIdFromLiveKitRoom(event.room?.name);
      if (!meetingId || !participant?.identity || !standard) return null;
      const sid = participant.sid || null;
      return {
        meetingId,
        observation: event.event === "participant_joined"
          // The event is the session's join, so when LiveKit leaves out the
          // join time its own time stands in, on the same clock.
          ? { kind: "participantJoined", identity: participant.identity, sid, joinedAt: sessionJoinedAt(participant) ?? createdAt, at }
          : { kind: "participantLeft", identity: participant.identity, sid, at },
      };
    }
    case "room_started":
    case "room_finished": {
      const meetingId = meetingIdFromLiveKitRoom(event.room?.name);
      if (!meetingId) return null;
      return { meetingId, observation: { kind: event.event === "room_started" ? "roomStarted" : "roomFinished" } };
    }
    case "egress_started":
    case "egress_updated":
    case "egress_ended": {
      const info = event.egressInfo;
      const meetingId = meetingIdFromLiveKitRoom(info?.roomName);
      if (!meetingId || !info) return null;
      return {
        meetingId,
        observation: { kind: "egressObserved", complete: false, egresses: [observeEgressInfo(info)] },
      };
    }
    default:
      return null;
  }
}

