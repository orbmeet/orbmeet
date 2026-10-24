import { useMemo } from "react";
import type { Participant, Room } from "livekit-client";
import { ParticipantKind, RoomEvent } from "livekit-client";
import { useParticipants } from "@livekit/components-react";
import { isGuestIdentity, type MeetingRole } from "@/modules/meetings/contract/constants";
import { PARTICIPANT_ATTRIBUTE, parseParticipantRole } from "@/modules/meetings/contract/live-state";

/**
 * Connections state for a participant. `role` is the privilege axis
 * (host|moderator|attendee); `isGuest` is the orthogonal auth axis.
 */
export interface ParticipantConnection {
  identity: string;
  userId: string;
  userName: string;
  role: MeetingRole;
  isGuest: boolean;
  joinedAt: number;
  isActive: boolean;
  isCameraEnabled?: boolean;
  isMicrophoneEnabled?: boolean;
}

/** What a connection shows: who is here, their role, and their camera and microphone. */
const CONNECTION_EVENTS = [
  RoomEvent.ParticipantActive,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
];

function toConnection(participant: Participant): ParticipantConnection {
  const identity = participant.identity || "";
  const name = participant.name?.trim() || "";
  return {
    identity,
    userId: identity,
    userName: name || identity || "Unknown",
    role: parseParticipantRole(participant.attributes[PARTICIPANT_ATTRIBUTE.role]) ?? "attendee",
    isGuest: isGuestIdentity(identity),
    joinedAt: participant.joinedAt?.getTime() || Date.now(),
    isActive: participant.isActive,
    isCameraEnabled: participant.isCameraEnabled,
    isMicrophoneEnabled: participant.isMicrophoneEnabled,
  };
}

/** The meeting's people, local first; agents and recorders are left out. */
export function useLiveKitConnections(room: Room | undefined): ParticipantConnection[] {
  const participants = useParticipants({ room, updateOnlyOn: CONNECTION_EVENTS });
  return useMemo(
    () => participants.filter((p) => p.kind === ParticipantKind.STANDARD).map(toConnection),
    [participants],
  );
}
