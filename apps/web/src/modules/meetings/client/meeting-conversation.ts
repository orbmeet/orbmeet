import type { LiveKitChatMessage } from "./use-livekit-chat";

/** How much chat a participant can scroll back through. */
const MAX_CONVERSATION_MESSAGES = 100;

export interface MeetingConversationSnapshot {
  messages: readonly LiveKitChatMessage[];
  /** Messages others sent, counted across the whole stay; never goes down. */
  receivedCount: number;
  /** Per thread key, the newest time read up to. */
  readUpTo: Readonly<Record<string, number>>;
}

const EMPTY: MeetingConversationSnapshot = { messages: [], receivedCount: 0, readUpTo: {} };

/**
 * The meeting's chat for one participant's stay, and how far they have read.
 *
 * Owned by the entry session, not the meeting view: the view is rebuilt for
 * every LiveKit connection (an automatic rejoin, a removal recheck, "Reload
 * view"), and what was said before that must still be there after it.
 */
export class MeetingConversation {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MeetingConversationSnapshot => this.snapshot;

  /** False when a message with this id is already here. */
  add(message: LiveKitChatMessage): boolean {
    const { messages, receivedCount } = this.snapshot;
    if (messages.some((existing) => existing.id === message.id)) return false;
    this.set({
      messages: [...messages, message].slice(-MAX_CONVERSATION_MESSAGES),
      receivedCount: message.fromSelf ? receivedCount : receivedCount + 1,
    });
    return true;
  }

  markRead(threadKey: string, upTo: number): void {
    const { readUpTo } = this.snapshot;
    if (upTo <= (readUpTo[threadKey] ?? 0)) return;
    this.set({ readUpTo: { ...readUpTo, [threadKey]: upTo } });
  }

  /** A new stay starts from nothing. */
  clear(): void {
    if (this.snapshot !== EMPTY) this.set(EMPTY);
  }

  private set(patch: Partial<MeetingConversationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
