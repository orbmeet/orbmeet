import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from "react";
import type { Room } from "livekit-client";
import { ConnectionState, DataPacket_Kind, RoomEvent } from "livekit-client";
import { logError, logInfo } from "@/lib/logger";
import { MESSAGE_LIMITS, LIVEKIT_TOPICS } from "@/modules/meetings/contract/constants";
import { isExpectedClosedPublishError } from "@/modules/meetings/contract/livekit-helpers";
import { participantKeyOfAttributes } from "@/modules/meetings/contract/live-state";
import { ReceiverRateLimiter } from "@/platform/realtime/receiver-rate-limiter";
import { useTokenBucket } from "./use-token-bucket";
import type { MeetingConversation } from "./meeting-conversation";

// Chat rate limit: 5 tokens, 1 token/sec refill
const CHAT_BUCKET_CAPACITY = 5;
const CHAT_BUCKET_REFILL_RATE = 1;

export interface LiveKitChatMessage {
  type: "chat";
  id: string;
  /** The sender's participant key (`participantKeyOf`), not their connection's identity. */
  participant: string;
  userName: string;
  text: string;
  /** This browser's clock: when it was sent from here or arrived here. */
  sentAt: number;
  /** Sent from this browser. */
  fromSelf: boolean;
  /**
   * A private message: the one other person it was for, by participant key.
   * On a message you sent that is the recipient; on one you received, it is you.
   */
  to?: { id: string; name: string };
}

interface ChatPacket {
  type: "chat";
  id: string;
  text: string;
  /**
   * Present on a private message: the participant key it was written to. Keys
   * outlive connections, so a thread survives either side reconnecting.
   */
  to?: string;
}

const MAX_CHAT_PACKET_LENGTH = MESSAGE_LIMITS.MAX_TEXT_LENGTH + 128;
const MAX_CHAT_PACKET_BYTES = 2 * 1024;

export function encodeBoundedPacket(text: string, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= maxBytes ? bytes : null;
}

export function decodeBoundedPacket(payload: Uint8Array, maxBytes: number, maxLength: number): string | null {
  if (payload.byteLength > maxBytes) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return text.length > 0 && text.length <= maxLength ? text : null;
  } catch {
    return null;
  }
}

/**
 * A received chat packet, or null when it is malformed or was not meant for
 * this participant.
 *
 * A private packet names its recipient, and LiveKit delivers it only there.
 * The name is checked anyway: a sender who addressed someone else but sent it
 * to the whole room must not have it shown to everyone as if it were private.
 */
export function parseChatPacket(text: string, localKey: string): ChatPacket | null {
  let packet: unknown;
  try {
    packet = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof packet !== "object" || packet === null) return null;
  const { type, id, text: body, to } = packet as Record<string, unknown>;
  if (
    type !== "chat" ||
    typeof id !== "string" ||
    !id ||
    id.length > 100 ||
    typeof body !== "string" ||
    !body.trim() ||
    body.length > MESSAGE_LIMITS.MAX_TEXT_LENGTH
  ) {
    return null;
  }
  if (to === undefined) return { type, id, text: body };
  if (typeof to !== "string" || !localKey || to !== localKey) return null;
  return { type, id, text: body, to };
}

/**
 * Chat as bounded reliable data packets, not LiveKit text streams: a text
 * stream has no size limit, so any sender could make every receiver buffer
 * arbitrary amounts before the message is validated. Each packet is capped in
 * bytes before it is decoded.
 *
 * - Sender-side token bucket rate limiting
 * - Receiver-side per-identity rate limiting
 * - Sender-generated message IDs, namespaced by the sender's LiveKit identity
 * - Sender and name from LiveKit (the key the coordinator set on their grant),
 *   never from the payload
 * - Local receive time (not sender timestamp)
 * - Private messages addressed to one participant and delivered only to their
 *   connections, so nobody else in the room — the recorder included — ever
 *   receives them
 *
 * Messages are kept in the stay's `conversation`, so a new connection picks
 * up where the last one left off. One sent while this participant was
 * disconnected is gone: LiveKit does not replay data packets.
 */
export function useLiveKitChat(
  room: Room | undefined,
  conversation: MeetingConversation,
  onSendError?: () => void,
) {
  const { messages, receivedCount, readUpTo } = useSyncExternalStore(
    conversation.subscribe,
    conversation.getSnapshot,
    conversation.getSnapshot,
  );
  const { consume } = useTokenBucket(CHAT_BUCKET_CAPACITY, CHAT_BUCKET_REFILL_RATE);
  const receiverLimiter = useMemo(() => new ReceiverRateLimiter(), []);

  const receive = useEffectEvent((senderIdentity: string, text: string) => {
    const local = room?.localParticipant;
    const sender = room?.remoteParticipants.get(senderIdentity);
    // Only people the coordinator admitted carry a key; agents do not chat.
    const senderKey = participantKeyOfAttributes(sender?.attributes);
    if (!senderKey) return;
    const packet = parseChatPacket(text, participantKeyOfAttributes(local?.attributes) ?? "");
    if (!packet) return;
    conversation.add({
      type: "chat",
      id: `${senderIdentity}:${packet.id}`,
      participant: senderKey,
      // Never the raw identity, which encodes internal ids.
      userName: sender?.name?.trim() || "Participant",
      text: packet.text.trim(),
      sentAt: Date.now(), // local receive time, not sender timestamp
      fromSelf: false,
      ...(packet.to ? { to: { id: packet.to, name: local?.name?.trim() || "You" } } : {}),
    });
  });

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      participant?: { identity?: string },
      kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      if (topic !== LIVEKIT_TOPICS.CHAT || kind !== DataPacket_Kind.RELIABLE) return;
      const senderIdentity = participant?.identity ?? "";
      if (!senderIdentity || !receiverLimiter.shouldAllow(senderIdentity)) return;
      const text = decodeBoundedPacket(payload, MAX_CHAT_PACKET_BYTES, MAX_CHAT_PACKET_LENGTH);
      if (text !== null) receive(senderIdentity, text);
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [receiverLimiter, room]);

  /** Sends to everyone, or privately to one person in the room when `to` is given. */
  const sendMessage = useCallback(
    async (text: string, to?: { id: string; name: string }): Promise<boolean> => {
      if (!room || room.state !== ConnectionState.Connected) return false;

      const lp = room.localParticipant;
      const localKey = participantKeyOfAttributes(lp.attributes);
      if (!lp.identity || !localKey) {
        logInfo("[LiveKitChat] Cannot send: identity not available yet");
        return false;
      }

      const trimmedText = text.trim();
      if (!trimmedText || trimmedText.length > MESSAGE_LIMITS.MAX_TEXT_LENGTH) {
        return false;
      }

      // Someone who has left cannot be written to; a private message must
      // never fall back to the room. It goes to every connection the
      // recipient has here, which is one but for the moment a rejoin overlaps.
      const recipients = to
        ? [...room.remoteParticipants.values()]
          .filter((participant) => participantKeyOfAttributes(participant.attributes) === to.id)
          .map((participant) => participant.identity)
        : [];
      if (to && (to.id === localKey || recipients.length === 0)) {
        return false;
      }

      if (!consume()) {
        return false;
      }

      const id = crypto.randomUUID();
      const packet: ChatPacket = { type: "chat", id, text: trimmedText, ...(to ? { to: to.id } : {}) };
      const bytes = encodeBoundedPacket(JSON.stringify(packet), MAX_CHAT_PACKET_BYTES);
      if (!bytes) return false;
      try {
        await lp.publishData(bytes, {
          reliable: true,
          topic: LIVEKIT_TOPICS.CHAT,
          ...(to ? { destinationIdentities: recipients } : {}),
        });
      } catch (error) {
        if (!isExpectedClosedPublishError(error)) {
          logError("[LiveKitChat] send failed:", error);
          onSendError?.();
        }
        return false;
      }
      conversation.add({
        type: "chat",
        id: `local:${id}`,
        participant: localKey,
        userName: lp.name || lp.identity,
        text: trimmedText,
        sentAt: Date.now(),
        fromSelf: true,
        ...(to ? { to } : {}),
      });
      return true;
    },
    [room, consume, conversation, onSendError],
  );

  const markRead = useCallback(
    (threadKey: string, upTo: number) => conversation.markRead(threadKey, upTo),
    [conversation],
  );

  return {
    messages,
    remoteMessageCount: receivedCount,
    readUpTo,
    markRead,
    sendMessage,
  };
}
