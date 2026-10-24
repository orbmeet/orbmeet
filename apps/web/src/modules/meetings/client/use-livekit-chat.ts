import { useCallback, useEffect, useEffectEvent, useMemo, useState, useRef } from "react";
import type { Room } from "livekit-client";
import { ConnectionState, DataPacket_Kind, RoomEvent } from "livekit-client";
import { logError, logInfo } from "@/lib/logger";
import { MESSAGE_LIMITS, LIVEKIT_TOPICS } from "@/modules/meetings/contract/constants";
import { isExpectedClosedPublishError } from "@/modules/meetings/contract/livekit-helpers";
import { ReceiverRateLimiter } from "@/platform/realtime/receiver-rate-limiter";
import { useTokenBucket } from "./use-token-bucket";

// Chat rate limit: 5 tokens, 1 token/sec refill
const CHAT_BUCKET_CAPACITY = 5;
const CHAT_BUCKET_REFILL_RATE = 1;

/**
 * Chat message — kept compatible with UI consumers.
 */
export interface LiveKitChatMessage {
  type: "chat";
  id: string;
  userId: string;
  userName: string;
  text: string;
  sentAt: number;
  /**
   * A private message: the one other person it was for. On a message you sent
   * that is the recipient; on one you received, it is you.
   */
  to?: { id: string; name: string };
}

interface ChatPacket {
  type: "chat";
  id: string;
  text: string;
  /** Present on a private message: the one identity it was sent to. */
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
export function parseChatPacket(text: string, localIdentity: string): ChatPacket | null {
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
  if (typeof to !== "string" || !localIdentity || to !== localIdentity) return null;
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
 * - Sender identity and name from LiveKit, never from the payload
 * - Local receive time (not sender timestamp)
 * - Private messages addressed to one identity and delivered only to it, so
 *   nobody else in the room — the recorder included — ever receives them
 *
 * Chat is a stream of messages, not shared state; one missed during a
 * disconnect is gone, as LiveKit does not replay data packets.
 */
export function useLiveKitChat(
  room: Room | undefined,
  userId?: string,
  userName?: string,
  maxMessages = 100,
  onSendError?: () => void
) {
  const [messages, setMessages] = useState<LiveKitChatMessage[]>([]);
  const [remoteMessageCount, setRemoteMessageCount] = useState(0);
  const messageIdsRef = useRef<Set<string>>(new Set());
  const { consume } = useTokenBucket(
    CHAT_BUCKET_CAPACITY,
    CHAT_BUCKET_REFILL_RATE
  );
  const receiverLimiter = useMemo(() => new ReceiverRateLimiter(), []);

  const addMessage = useCallback(
    (message: LiveKitChatMessage) => {
      if (messageIdsRef.current.has(message.id)) {
        return false;
      }
      messageIdsRef.current.add(message.id);

      setMessages((prev) => {
        const updated = [...prev, message];
        if (updated.length > maxMessages) {
          const overflow = updated.length - maxMessages;
          for (let i = 0; i < overflow; i++) {
            messageIdsRef.current.delete(updated[i].id);
          }
          return updated.slice(overflow);
        }
        return updated;
      });
      return true;
    },
    [maxMessages]
  );

  const receive = useEffectEvent((senderIdentity: string, text: string) => {
    const local = room?.localParticipant;
    const packet = parseChatPacket(text, local?.identity ?? "");
    if (!packet) return;
    const added = addMessage({
      type: "chat",
      id: `${senderIdentity}:${packet.id}`,
      userId: senderIdentity,
      // Never the raw identity, which encodes internal ids.
      userName: room?.remoteParticipants.get(senderIdentity)?.name?.trim() || "Participant",
      text: packet.text.trim(),
      sentAt: Date.now(), // local receive time, not sender timestamp
      ...(packet.to ? { to: { id: packet.to, name: local?.name?.trim() || "You" } } : {}),
    });
    if (added) setRemoteMessageCount((count) => count + 1);
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
      const resolvedUserId = lp.identity || userId;
      const resolvedUserName = lp.name || lp.identity || userName;

      if (!resolvedUserId || !resolvedUserName) {
        logInfo("[LiveKitChat] Cannot send: identity not available yet");
        return false;
      }

      const trimmedText = text.trim();
      if (!trimmedText || trimmedText.length > MESSAGE_LIMITS.MAX_TEXT_LENGTH) {
        return false;
      }

      // Someone who has left cannot be written to; a private message must
      // never fall back to the room.
      if (to && (to.id === resolvedUserId || !room.remoteParticipants.has(to.id))) {
        return false;
      }

      if (!consume()) {
        return false;
      }

      const message: LiveKitChatMessage = {
        type: "chat",
        id: `local:${crypto.randomUUID()}`,
        userId: resolvedUserId,
        userName: resolvedUserName,
        text: trimmedText,
        sentAt: Date.now(),
        ...(to ? { to } : {}),
      };

      const packet: ChatPacket = {
        type: "chat",
        id: message.id.slice("local:".length),
        text: trimmedText,
        ...(to ? { to: to.id } : {}),
      };
      const bytes = encodeBoundedPacket(JSON.stringify(packet), MAX_CHAT_PACKET_BYTES);
      if (!bytes) return false;
      try {
        await lp.publishData(bytes, {
          reliable: true,
          topic: LIVEKIT_TOPICS.CHAT,
          ...(to ? { destinationIdentities: [to.id] } : {}),
        });
      } catch (error) {
        if (!isExpectedClosedPublishError(error)) {
          logError("[LiveKitChat] send failed:", error);
          onSendError?.();
        }
        return false;
      }
      addMessage(message);
      return true;
    },
    [room, userId, userName, consume, addMessage, onSendError]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    messageIdsRef.current.clear();
  }, []);

  return {
    messages,
    remoteMessageCount,
    sendMessage,
    clearMessages,
  };
}
