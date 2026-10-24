import * as React from "react";
import { RoomEvent, type Participant, type Room } from "livekit-client";
import { useParticipants } from "@livekit/components-react";
import { parseMeetingRoomState, type MeetingRoomState } from "@/modules/meetings/contract/live-state";

/**
 * The meeting state the coordinator keeps in room metadata. LiveKit replays
 * it on every (re)connect; a version older than the one already seen is
 * ignored, since metadata updates can arrive out of order.
 */
export function useMeetingRoomState(room: Room | undefined): MeetingRoomState | null {
  const [state, setState] = React.useState<MeetingRoomState | null>(() => parseMeetingRoomState(room?.metadata));

  React.useEffect(() => {
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
  }, [room]);

  return state;
}

/**
 * Every participant in the room, local first, re-read whenever anyone's
 * server-written attributes change or someone arrives or leaves.
 */
export function useRoomParticipants(room: Room | undefined): Participant[] {
  return useParticipants({ room, updateOnlyOn: [RoomEvent.ParticipantAttributesChanged] });
}
