import { describe, expect, it } from "vitest";
import type { MeetingState } from "./model";
import { SlottedMeetingStore, type MeetingKeyValues } from "./meeting-store";

/** Durable Object storage in memory: values are copied in and out, as they are serialized there. */
class MemoryKeyValues implements MeetingKeyValues {
  readonly values = new Map<string, unknown>();
  /** Every key each put wrote. */
  readonly puts: string[][] = [];

  async get(keys: string[]) {
    const found = new Map<string, unknown>();
    for (const key of keys) if (this.values.has(key)) found.set(key, structuredClone(this.values.get(key)));
    return found;
  }

  async put(entries: Record<string, unknown>) {
    this.puts.push(Object.keys(entries).sort());
    for (const [key, value] of Object.entries(entries)) this.values.set(key, structuredClone(value));
  }

  async delete(keys: string[]) {
    for (const key of keys) this.values.delete(key);
  }

  async deleteAll() {
    this.values.clear();
  }
}

const stateAt = (version: number) => ({ version }) as unknown as MeetingState;
const statesWritten = (puts: string[][]) => puts.map((keys) => keys.filter((key) => key.startsWith("slot:")).length);

describe("SlottedMeetingStore", () => {
  it("keeps one copy of the state per commit, naming the slot D1 last showed", async () => {
    const storage = new MemoryKeyValues();
    const store = new SlottedMeetingStore(storage, "meeting_1");

    const first = stateAt(1);
    await store.save(first, null);
    await store.projected();
    const second = stateAt(2);
    await store.save(second, first);
    await store.projected();
    const third = stateAt(3);
    await store.save(third, second);

    expect(statesWritten(storage.puts)).toEqual([1, 0, 1, 0, 1]);
    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: third, projectedFrom: second });
  });

  it("keeps what D1 last showed across commits while D1 lags", async () => {
    const storage = new MemoryKeyValues();
    const store = new SlottedMeetingStore(storage, "meeting_1");
    const shown = stateAt(1);
    await store.save(shown, null);
    await store.projected();

    // D1 fails twice: both commits keep `shown` as what it last showed.
    await store.save(stateAt(2), shown);
    await store.save(stateAt(3), shown);

    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: stateAt(3), projectedFrom: shown });
    expect(statesWritten(storage.puts)).toEqual([1, 0, 1, 1]);
  });

  it("says D1 shows none of the meeting until its first projection", async () => {
    const storage = new MemoryKeyValues();
    await new SlottedMeetingStore(storage, "meeting_1").save(stateAt(1), null);

    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: stateAt(1), projectedFrom: null });
  });

  it("goes on from what it loaded, found by identity", async () => {
    const storage = new MemoryKeyValues();
    const writer = new SlottedMeetingStore(storage, "meeting_1");
    await writer.save(stateAt(1), null);
    await writer.projected();

    const reader = new SlottedMeetingStore(storage, "meeting_1");
    const loaded = (await reader.load())!;
    await reader.save(stateAt(2), loaded.state);

    expect(statesWritten(storage.puts)).toEqual([1, 0, 1]);
    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: stateAt(2), projectedFrom: stateAt(1) });
  });

  it("moves a meeting kept before slots into them on its next commit", async () => {
    const storage = new MemoryKeyValues();
    storage.values.set("state", stateAt(1));
    storage.values.set("meetingId", "meeting_1");
    const store = new SlottedMeetingStore(storage, "meeting_1");

    const loaded = (await store.load())!;
    expect(loaded).toEqual({ state: stateAt(1) });
    await store.save(stateAt(2), loaded.state);

    expect(storage.values.has("state")).toBe(false);
    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: stateAt(2), projectedFrom: stateAt(1) });
  });

  it("reads a meeting kept before slots that D1 was lagging", async () => {
    const storage = new MemoryKeyValues();
    storage.values.set("state", stateAt(2));
    storage.values.set("projectedFrom", stateAt(1));

    expect(await new SlottedMeetingStore(storage, "meeting_1").load()).toEqual({ state: stateAt(2), projectedFrom: stateAt(1) });
  });

  it("forgets everything when cleared", async () => {
    const storage = new MemoryKeyValues();
    const store = new SlottedMeetingStore(storage, "meeting_1");
    await store.save(stateAt(1), null);
    await store.clear();

    expect(storage.values.size).toBe(0);
    expect(await store.load()).toBeNull();
  });
});
