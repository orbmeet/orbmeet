import type { MeetingState } from "./model";
import type { StoredMeeting } from "./room.server";

/** The calls of Durable Object storage a meeting's state is kept with. */
export interface MeetingKeyValues {
  get(keys: string[]): Promise<Map<string, unknown>>;
  /** Writes every entry or none. */
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
  deleteAll(): Promise<void>;
}

type Slot = "a" | "b";

/**
 * Which slot holds the kept state, and which holds the state D1 last showed
 * while D1 may lag it: absent once D1 shows the kept state, null while D1
 * shows none of it.
 */
interface Head {
  current: Slot;
  projectedFrom?: Slot | null;
}

const HEAD_KEY = "head";
const MEETING_ID_KEY = "meetingId";
const slotKey = (slot: Slot) => `slot:${slot}`;
const otherSlot = (slot: Slot): Slot => (slot === "a" ? "b" : "a");
/** The layout before slots: the kept state and a second copy of what D1 last showed. */
const LEGACY_STATE_KEY = "state";
const LEGACY_PROJECTED_FROM_KEY = "projectedFrom";

/**
 * A meeting's kept state, in two slots.
 *
 * A commit keeps the new state together with the state D1 last showed (see
 * `MeetingRoomStorage.save`). That earlier state is almost always the one
 * kept by the commit before, so it is already in storage: the new state goes
 * into the other slot, and the head names which slot is which. A commit writes
 * one copy of the meeting's state rather than two, and the head and the new
 * state are written together, so the two are never out of step.
 *
 * Which slot a state is in is known by the object itself: `load` and `save`
 * remember the objects they hand over and take, and a `projectedFrom` the
 * room passes back is found by identity. A state this store does not hold
 * (only after a load of the layout before slots) is written into the other
 * slot alongside.
 */
export class SlottedMeetingStore {
  private head: Head | null = null;
  private readonly held: Record<Slot, MeetingState | null> = { a: null, b: null };

  constructor(
    private readonly storage: MeetingKeyValues,
    private readonly meetingId: string,
  ) {}

  async load(): Promise<StoredMeeting | null> {
    const stored = await this.storage.get([
      HEAD_KEY,
      slotKey("a"),
      slotKey("b"),
      LEGACY_STATE_KEY,
      LEGACY_PROJECTED_FROM_KEY,
    ]);
    const head = stored.get(HEAD_KEY) as Head | undefined;
    if (head) {
      this.head = head;
      this.held.a = (stored.get(slotKey("a")) as MeetingState | undefined) ?? null;
      this.held.b = (stored.get(slotKey("b")) as MeetingState | undefined) ?? null;
      const state = this.held[head.current];
      if (!state) return null;
      if (head.projectedFrom === undefined) return { state };
      return { state, projectedFrom: head.projectedFrom === null ? null : this.held[head.projectedFrom] };
    }
    const legacy = stored.get(LEGACY_STATE_KEY) as MeetingState | undefined;
    if (!legacy) return null;
    return stored.has(LEGACY_PROJECTED_FROM_KEY)
      ? { state: legacy, projectedFrom: stored.get(LEGACY_PROJECTED_FROM_KEY) as MeetingState | null }
      : { state: legacy };
  }

  async save(state: MeetingState, projectedFrom: MeetingState | null): Promise<void> {
    const entries: Record<string, unknown> = { [MEETING_ID_KEY]: this.meetingId };
    let projectedSlot: Slot | null = null;
    let target: Slot;
    if (projectedFrom === null) {
      target = this.head ? otherSlot(this.head.current) : "a";
    } else {
      const holding = (["a", "b"] as const).find((slot) => this.held[slot] === projectedFrom);
      if (holding) {
        projectedSlot = holding;
      } else {
        projectedSlot = this.head ? this.head.current : "a";
        entries[slotKey(projectedSlot)] = projectedFrom;
      }
      target = otherSlot(projectedSlot);
    }
    const head: Head = { current: target, projectedFrom: projectedSlot };
    entries[slotKey(target)] = state;
    entries[HEAD_KEY] = head;
    await this.storage.put(entries);
    if (!this.head) await this.storage.delete([LEGACY_STATE_KEY, LEGACY_PROJECTED_FROM_KEY]);
    this.head = head;
    this.held[target] = state;
    if (projectedSlot) this.held[projectedSlot] = projectedFrom;
  }

  /** D1 shows the kept state. */
  async projected(): Promise<void> {
    if (!this.head || this.head.projectedFrom === undefined) return;
    const head: Head = { current: this.head.current };
    await this.storage.put({ [HEAD_KEY]: head });
    this.head = head;
  }

  async clear(): Promise<void> {
    await this.storage.deleteAll();
    this.head = null;
    this.held.a = null;
    this.held.b = null;
  }
}
