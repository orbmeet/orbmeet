import type { MeetingRoomStorage, StoredMeeting } from "@/modules/meetings/server/runtime/room.server";
import type { MeetingState } from "@/modules/meetings/server/runtime/model";

/** A MeetingRoom Durable Object's storage, in memory, as the room sees it. */
export class MemoryStorage implements MeetingRoomStorage {
  state: MeetingState | null = null;
  /** Absent while D1 shows the kept state; see {@link StoredMeeting}. */
  projectedFrom: MeetingState | null | undefined = undefined;
  alarm: number | null = null;
  saves = 0;

  load = async (): Promise<StoredMeeting | null> => {
    if (!this.state) return null;
    const state = structuredClone(this.state);
    return this.projectedFrom === undefined
      ? { state }
      : { state, projectedFrom: structuredClone(this.projectedFrom) };
  };

  save = async (state: MeetingState, projectedFrom: MeetingState | null) => {
    this.saves += 1;
    this.state = structuredClone(state);
    this.projectedFrom = structuredClone(projectedFrom);
  };

  projected = async () => {
    this.projectedFrom = undefined;
  };

  clear = async () => {
    this.state = null;
    this.projectedFrom = undefined;
    this.alarm = null;
  };

  setAlarm = async (at: number | null) => {
    this.alarm = at;
  };
}
