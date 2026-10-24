import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionState, type Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { decodeBoundedPacket, encodeBoundedPacket, parseChatPacket, useLiveKitChat } from "./use-livekit-chat";

function renderChat(publishData: (...args: unknown[]) => Promise<void>, onSendError = vi.fn(), remoteIdentities: string[] = []) {
  let chat: ReturnType<typeof useLiveKitChat> | null = null;
  const room = {
    state: ConnectionState.Connected,
    localParticipant: { identity: "me", name: "Me", publishData },
    remoteParticipants: new Map(remoteIdentities.map((identity) => [identity, { identity }])),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Room;

  function Harness() {
    chat = useLiveKitChat(room, "me", "Me", 100, onSendError);
    return null;
  }

  renderToStaticMarkup(createElement(Harness));
  if (!chat) throw new Error("Chat did not render");
  return chat as ReturnType<typeof useLiveKitChat>;
}

describe("bounded chat packets", () => {
  it("rejects oversized UTF-8 before publish or decode", () => {
    expect(encodeBoundedPacket("éé", 3)).toBeNull();
    const payload = new TextEncoder().encode("éé");
    expect(decodeBoundedPacket(payload, 3, 10)).toBeNull();
  });

  it("rejects malformed UTF-8 and decoded text beyond the character cap", () => {
    expect(decodeBoundedPacket(new Uint8Array([0xff]), 10, 10)).toBeNull();
    expect(decodeBoundedPacket(new TextEncoder().encode("abcd"), 10, 3)).toBeNull();
  });

  it("round-trips a bounded packet", () => {
    const payload = encodeBoundedPacket("hello", 10);
    expect(payload).not.toBeNull();
    expect(decodeBoundedPacket(payload!, 10, 10)).toBe("hello");
  });

  it("awaits the underlying LiveKit publish result", async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    await expect(renderChat(publishData).sendMessage("hello")).resolves.toBe(true);
    expect(publishData).toHaveBeenCalledOnce();
  });

  it("reports an asynchronous publish rejection as an unsuccessful send", async () => {
    const onSendError = vi.fn();
    const chat = renderChat(() => Promise.reject(new Error("data channel send failed")), onSendError);
    await expect(chat.sendMessage("hello")).resolves.toBe(false);
    expect(onSendError).toHaveBeenCalledOnce();
  });
});

describe("private messages", () => {
  const packet = (fields: Record<string, unknown>) => JSON.stringify({ type: "chat", id: "m1", text: "hi", ...fields });

  it("accepts a message for the room, and one addressed to this participant", () => {
    expect(parseChatPacket(packet({}), "me")).toEqual({ type: "chat", id: "m1", text: "hi" });
    expect(parseChatPacket(packet({ to: "me" }), "me")).toEqual({ type: "chat", id: "m1", text: "hi", to: "me" });
  });

  it("drops a private message addressed to someone else, rather than showing it as the room's", () => {
    expect(parseChatPacket(packet({ to: "fayaz" }), "me")).toBeNull();
    expect(parseChatPacket(packet({ to: 42 }), "me")).toBeNull();
    expect(parseChatPacket(packet({ to: "me" }), "")).toBeNull();
  });

  it("sends a private message only to its recipient, and keeps who it was for", async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    const chat = renderChat(publishData, vi.fn(), ["fayaz"]);
    await expect(chat.sendMessage("just you", { id: "fayaz", name: "Fayaz" })).resolves.toBe(true);

    const [bytes, options] = publishData.mock.calls[0] as [Uint8Array, Record<string, unknown>];
    expect(options).toMatchObject({ reliable: true, destinationIdentities: ["fayaz"] });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ text: "just you", to: "fayaz" });
  });

  it("refuses to send privately to someone who is not in the room, or to yourself", async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    const chat = renderChat(publishData, vi.fn(), ["fayaz"]);
    await expect(chat.sendMessage("hello?", { id: "gone", name: "Gone" })).resolves.toBe(false);
    await expect(chat.sendMessage("note to self", { id: "me", name: "Me" })).resolves.toBe(false);
    expect(publishData).not.toHaveBeenCalled();
  });

  it("sends a room message with no recipient list", async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    await renderChat(publishData).sendMessage("everyone");
    const [bytes, options] = publishData.mock.calls[0] as [Uint8Array, Record<string, unknown>];
    expect(options).not.toHaveProperty("destinationIdentities");
    expect(JSON.parse(new TextDecoder().decode(bytes))).not.toHaveProperty("to");
  });
});
