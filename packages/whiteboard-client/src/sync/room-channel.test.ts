import { afterEach, describe, expect, it, vi } from "vitest";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { ASSISTANT_EVENTS } from "@orbmeet/whiteboard-core/assistant";
import { createRoomChannel } from "./room-channel";

const granted = { type: WHITEBOARD_EVENTS.ACCESS_GRANTED };
const sizeLimit = { type: WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT, maxBytes: 1 };

describe("the room channel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delivers each message to the readers of its type, then to every-message readers", () => {
    const channel = createRoomChannel();
    const order: string[] = [];
    channel.onAny((message) => order.push(`any:${message.type}`));
    channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, () => order.push("granted"));
    channel.on(WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT, () => order.push("size"));

    channel.receive(granted);
    channel.receive(sizeLimit);

    expect(order).toEqual(["granted", `any:${granted.type}`, "size", `any:${sizeLimit.type}`]);
  });

  it("ignores what the room does not send", () => {
    const channel = createRoomChannel();
    const any = vi.fn();
    channel.onAny(any);

    for (const data of [null, "whiteboard.state", { type: "something.else" }, { type: 7 }, {}]) {
      channel.receive(data);
    }

    expect(any).not.toHaveBeenCalled();
  });

  it("knows the assistant's events as the room's", () => {
    const channel = createRoomChannel();
    const entry = vi.fn();
    channel.on(ASSISTANT_EVENTS.ENTRY, entry);

    channel.receive({ type: ASSISTANT_EVENTS.ENTRY, entry: { id: "e" } });

    expect(entry).toHaveBeenCalledWith({ type: ASSISTANT_EVENTS.ENTRY, entry: { id: "e" } });
  });

  it("stops delivering once unsubscribed", () => {
    const channel = createRoomChannel();
    const handler = vi.fn();
    const off = channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, handler);

    off();
    channel.receive(granted);

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to the readers subscribed when a message arrived, even if one unsubscribes another", () => {
    const channel = createRoomChannel();
    const second = vi.fn();
    let offSecond = () => {};
    channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, () => offSecond());
    offSecond = channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, second);

    channel.receive(granted);
    channel.receive(granted);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering when one reader throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = createRoomChannel();
    const after = vi.fn();
    channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, () => {
      throw new Error("reader failed");
    });
    channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, after);

    channel.receive(granted);

    expect(after).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });
});
