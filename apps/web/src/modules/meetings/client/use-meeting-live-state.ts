import * as React from "react";
import { RoomEvent, type Participant, type Room } from "livekit-client";
import { parseMeetingRoomState, type MeetingRoomState } from "@/modules/meetings/contract/live-state";

const DEFAULT_PARTICIPANT_EVENTS = [RoomEvent.ParticipantAttributesChanged];

const BASE_PARTICIPANT_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ConnectionStateChanged,
];

function snapshotRoomParticipants(room: Room | undefined): Participant[] {
  if (!room) return [];
  return [room.localParticipant, ...room.remoteParticipants.values()];
}

/**
 * The meeting state the coordinator keeps in room metadata. LiveKit replays
 * it on every (re)connect; a version older than the one already seen is
 * ignored, since metadata updates can arrive out of order.
 *
 * Pass `provided` to reuse a parent's subscription without attaching another
 * listener to the room.
 */
export function useMeetingRoomState(
  room: Room | undefined,
  provided?: MeetingRoomState | null,
): MeetingRoomState | null {
  const subscribe = provided === undefined;
  const [state, setState] = React.useState<MeetingRoomState | null>(() =>
    subscribe ? parseMeetingRoomState(room?.metadata) : null,
  );

  React.useEffect(() => {
    if (!subscribe) return;
    if (!room) {
      setState(null);
      return;
    }
    const update = (metadata: string | undefined) => {
      const next = parseMeetingRoomState(metadata);
      if (!next) return;
      setState((current) => (current && current.version >= next.version ? current : next));
    };
    update(room.metadata);
    room.on(RoomEvent.RoomMetadataChanged, update);
    return () => {
      room.off(RoomEvent.RoomMetadataChanged, update);
    };
  }, [room, subscribe]);

  return subscribe ? state : provided;
}

/**
 * Every participant in the room, local first, re-read whenever anyone's
 * server-written attributes change or someone arrives or leaves.
 *
 * Pass `provided` to reuse a parent's subscription without attaching another
 * listener to the room.
 */
export function useRoomParticipants(
  room: Room | undefined,
  provided?: Participant[],
  extraEvents: readonly RoomEvent[] = DEFAULT_PARTICIPANT_EVENTS,
): Participant[] {
  const subscribe = provided === undefined;
  const [participants, setParticipants] = React.useState<Participant[]>(() =>
    subscribe ? snapshotRoomParticipants(room) : [],
  );

  React.useEffect(() => {
    if (!subscribe) return;
    if (!room) {
      setParticipants([]);
      return;
    }
    const refresh = () => setParticipants(snapshotRoomParticipants(room));
    refresh();
    const events = new Set([...BASE_PARTICIPANT_EVENTS, ...extraEvents]);
    for (const event of events) room.on(event, refresh);
    return () => {
      for (const event of events) room.off(event, refresh);
    };
  }, [extraEvents, room, subscribe]);

  return subscribe ? participants : provided;
}
