import {
  readRoomMessage,
  type RoomMessage,
  type RoomMessageOf,
  type RoomMessageType,
} from "@orbmeet/whiteboard-core/room-messages";

type Handler<M> = (message: M) => void;

/**
 * The room's messages to this board, for whoever needs them.
 *
 * tldraw hands a board one callback for everything the room sends outside its
 * sync protocol. Before this, that callback was a hand-written dispatcher that
 * reached each reader through a ref filled in later, so every new reader meant
 * another ref and another effect in the board component. Now the sync layer
 * feeds `receive`, and each reader subscribes to the types it reads, from
 * wherever it lives.
 *
 * Handlers run in subscription order. One that throws is reported and the rest
 * still run: each is an independent projection of the same message.
 */
export interface RoomChannel {
  /** Feed one message from the socket; anything the room does not send is ignored. */
  receive(data: unknown): void;
  /** Read one type of message. Returns the unsubscribe. */
  on<T extends RoomMessageType>(type: T, handler: Handler<RoomMessageOf<T>>): () => void;
  /** Read every message, after the typed readers have. Returns the unsubscribe. */
  onAny(handler: Handler<RoomMessage>): () => void;
}

export function createRoomChannel(): RoomChannel {
  const byType = new Map<RoomMessageType, Set<Handler<RoomMessage>>>();
  const any = new Set<Handler<RoomMessage>>();

  const run = (handler: Handler<RoomMessage>, message: RoomMessage) => {
    try {
      handler(message);
    } catch (error) {
      console.error(`[WB] Room message handler failed for ${message.type}:`, error);
    }
  };

  return {
    receive(data) {
      const message = readRoomMessage(data);
      if (!message) return;
      // Copies, so a handler that unsubscribes (or subscribes) mid-delivery
      // neither skips nor adds a reader of this message.
      for (const handler of Array.from(byType.get(message.type) ?? [])) run(handler, message);
      for (const handler of Array.from(any)) run(handler, message);
    },
    on(type, handler) {
      let handlers = byType.get(type);
      if (!handlers) {
        handlers = new Set();
        byType.set(type, handlers);
      }
      const entry = handler as Handler<RoomMessage>;
      handlers.add(entry);
      return () => {
        handlers.delete(entry);
      };
    },
    onAny(handler) {
      any.add(handler);
      return () => {
        any.delete(handler);
      };
    },
  };
}
