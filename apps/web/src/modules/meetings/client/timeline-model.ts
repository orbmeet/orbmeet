import {
  audienceKey,
  describeLookedAt,
  privateAudience,
  type AssistantAudience,
  type AssistantEntry,
} from "@orbmeet/whiteboard-core/assistant";

/**
 * The meeting's timeline, as data.
 *
 * Chat and captions used to be two panels with two scrollbacks, so "what did
 * Rafi just say about the roots" and "the link Yousuf pasted after it" lived
 * in different places and had to be read against each other by hand. Here they
 * are one stream in the order they happened — and Orb's questions and answers
 * are in it too, because they are part of the same conversation.
 *
 * A private thread is the other kind of stream: two people's messages to each
 * other, and what Orb answered the two of them. What is said aloud belongs to
 * the room, so it is never in one. The Orb thread is one person's own
 * conversation with Orb. Orb answers to the same people who could see the
 * question, so each of its entries belongs to exactly one thread.
 *
 * Pure, so the merge — the part that is easy to get subtly wrong — is tested
 * without mounting a room.
 */

export interface TimelineChatInput {
  id: string;
  userId: string;
  userName: string;
  text: string;
  sentAt: number;
  /** A private message: the one other person in it besides the sender. */
  to?: { id: string; name: string };
}

/** Which stream: the room's, a private one with one other person, or your own with Orb. */
export type TimelineThread = { kind: "room" } | { kind: "private"; withId: string } | { kind: "orb" };

export const ROOM_THREAD: TimelineThread = { kind: "room" };
export const ORB_THREAD: TimelineThread = { kind: "orb" };

/** A stable key for a thread, for state kept per thread. */
export function threadKey(thread: TimelineThread): string {
  return thread.kind === "private" ? `private:${thread.withId}` : thread.kind;
}

/** Who sees what is written in a thread — and so whom Orb answers there. */
export function threadAudience(thread: TimelineThread, currentUserId: string): AssistantAudience {
  if (thread.kind === "room") return { kind: "room" };
  return privateAudience(thread.kind === "orb" ? [currentUserId] : [currentUserId, thread.withId]);
}

/** The thread an Orb entry or run belongs to, as this viewer sees it; null when it is not theirs. */
export function orbThread(audience: AssistantAudience | undefined, currentUserId: string): TimelineThread | null {
  if (!audience || audience.kind === "room") return ROOM_THREAD;
  if (!audience.members.includes(currentUserId)) return null;
  const other = audience.members.find((member) => member !== currentUserId);
  return other === undefined ? ORB_THREAD : { kind: "private", withId: other };
}

function inOrbThread(audience: AssistantAudience | undefined, thread: TimelineThread, currentUserId: string): boolean {
  return audienceKey(audience) === audienceKey(threadAudience(thread, currentUserId));
}

export interface TimelineSpeechInput {
  id: string;
  userId: string;
  userName: string;
  text: string;
  isFinal: boolean;
  startedAt: number;
  updatedAt: number;
}

interface TimelineChatItem {
  kind: "chat";
  id: string;
  at: number;
  userId: string;
  userName: string;
  text: string;
  mine: boolean;
}

interface TimelineSpeechItem {
  kind: "speech";
  /** The first segment's id: stable while the run grows, so it never remounts. */
  id: string;
  at: number;
  userId: string;
  userName: string;
  mine: boolean;
  segments: { id: string; text: string; isFinal: boolean }[];
}

/** Someone asking Orb. */
interface TimelineOrbAskItem {
  kind: "orb-ask";
  id: string;
  at: number;
  userId: string;
  userName: string;
  text: string;
  mine: boolean;
}

interface TimelineOrbReplyItem {
  kind: "orb-reply";
  id: string;
  at: number;
  text: string;
  /** False while the answer is still being written. */
  done: boolean;
  /** Who asked the question this answers, when known. */
  askedBy?: { userId: string; userName: string };
  /** What Orb was shown with the question — "Looked at page 4 of 7…" — on a run's first answer. */
  lookedAt?: string;
}

/** What Orb did on the board, one run's steps together. */
interface TimelineOrbStepsItem {
  kind: "orb-steps";
  /** The first step's id: stable while steps are added. */
  id: string;
  at: number;
  steps: { id: string; label: string; status: "running" | "done" | "failed" }[];
  /** The page it drew on, and what it made and changed there: what "Show on board" and "Undo" act on. */
  pageId?: string;
  created: string[];
  changed: string[];
  askedBy?: { userId: string; userName: string };
}

interface TimelineOrbNoticeItem {
  kind: "orb-notice";
  id: string;
  at: number;
  text: string;
}

export type TimelineItem =
  | TimelineChatItem
  | TimelineSpeechItem
  | TimelineOrbAskItem
  | TimelineOrbReplyItem
  | TimelineOrbStepsItem
  | TimelineOrbNoticeItem;

/**
 * How long a speaker may pause and still be the same run. Past it, a new run
 * starts with its own name and time, which is what lets a long meeting be
 * skimmed by who said what rather than read as one paragraph per person.
 */
export const SPEECH_RUN_GAP_MS = 45_000;

/** Whether a message belongs in a thread. */
function inThread(message: TimelineChatInput, thread: TimelineThread, currentUserId: string): boolean {
  if (thread.kind === "room") return !message.to;
  if (thread.kind === "orb" || !message.to) return false;
  const other = message.userId === currentUserId ? message.to.id : message.userId;
  return other === thread.withId;
}

const SOURCE_RANK = { speech: 0, chat: 1, orb: 2 } as const;

export function buildTimeline({
  chat,
  speech,
  orb = [],
  currentUserId,
  thread = ROOM_THREAD,
}: {
  chat: readonly TimelineChatInput[];
  /** Empty while this viewer has hidden what is said. */
  speech: readonly TimelineSpeechInput[];
  /** Orb's conversation, in the order the server recorded it. */
  orb?: readonly AssistantEntry[];
  currentUserId: string;
  thread?: TimelineThread;
}): TimelineItem[] {
  const inRoom = thread.kind === "room";
  type Entry =
    | { kind: "chat"; at: number; order: number; value: TimelineChatInput }
    | { kind: "speech"; at: number; order: number; value: TimelineSpeechInput }
    | { kind: "orb"; at: number; order: number; value: AssistantEntry };
  const entries: Entry[] = [
    ...chat
      .filter((value) => inThread(value, thread, currentUserId))
      .map((value, order): Entry => ({ kind: "chat", at: value.sentAt, order, value })),
    ...(inRoom ? speech : []).map((value, order): Entry => ({ kind: "speech", at: value.startedAt, order, value })),
    ...orbEntries(orb.filter((entry) => inOrbThread(entry.audience, thread, currentUserId))),
  ];
  // Stable on ties: within one source the arrival order is the truth, and a
  // chat line typed in the same millisecond as speech began reads after it.
  entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.order - b.order : SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind]));

  const items: TimelineItem[] = [];
  let lastSpeechEnd = 0;
  let asker: { userId: string; userName: string } | undefined;
  // What the latest question showed Orb, until its first answer says so.
  let lookedAt: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "orb") {
      if (entry.value.kind === "prompt") {
        asker = { userId: entry.value.authorId, userName: entry.value.author };
        lookedAt = entry.value.lookedAt && describeLookedAt(entry.value.lookedAt);
      }
      appendOrb(items, entry.value, entry.at, currentUserId, asker, lookedAt);
      if (entry.value.kind === "reply") lookedAt = undefined;
      continue;
    }
    if (entry.kind === "chat") {
      const message = entry.value;
      items.push({
        kind: "chat",
        id: message.id,
        at: message.sentAt,
        userId: message.userId,
        userName: message.userName,
        text: message.text,
        mine: message.userId === currentUserId,
      });
      continue;
    }

    const segment = entry.value;
    const previous = items[items.length - 1];
    const continues =
      previous?.kind === "speech" &&
      previous.userId === segment.userId &&
      segment.startedAt - lastSpeechEnd <= SPEECH_RUN_GAP_MS;
    if (continues) {
      previous.segments.push({ id: segment.id, text: segment.text, isFinal: segment.isFinal });
    } else {
      items.push({
        kind: "speech",
        id: segment.id,
        at: segment.startedAt,
        userId: segment.userId,
        userName: segment.userName,
        mine: segment.userId === currentUserId,
        segments: [{ id: segment.id, text: segment.text, isFinal: segment.isFinal }],
      });
    }
    lastSpeechEnd = Math.max(segment.updatedAt, segment.startedAt);
  }
  return items;
}

/**
 * Orb's entries with a time each. The server stamps every entry; one that
 * arrives without a time keeps its place after the entry before it.
 */
function orbEntries(orb: readonly AssistantEntry[]) {
  let previousAt = 0;
  return orb.map((value, order) => {
    const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : previousAt;
    previousAt = at;
    return { kind: "orb" as const, at, order, value };
  });
}

function appendOrb(
  items: TimelineItem[],
  entry: AssistantEntry,
  at: number,
  currentUserId: string,
  askedBy: { userId: string; userName: string } | undefined,
  lookedAt?: string,
): void {
  switch (entry.kind) {
    case "prompt":
      items.push({
        kind: "orb-ask",
        id: entry.id,
        at,
        userId: entry.authorId,
        userName: entry.author,
        text: entry.text,
        mine: entry.authorId === currentUserId,
      });
      return;
    case "reply":
      items.push({ kind: "orb-reply", id: entry.id, at, text: entry.text, done: entry.done, askedBy, ...(lookedAt ? { lookedAt } : {}) });
      return;
    case "notice":
      items.push({ kind: "orb-notice", id: entry.id, at, text: entry.text });
      return;
    case "tool": {
      const step = { id: entry.id, label: entry.label, status: entry.status };
      const previous = items[items.length - 1];
      let steps: TimelineOrbStepsItem;
      if (previous?.kind === "orb-steps") steps = previous;
      else {
        steps = { kind: "orb-steps", id: entry.id, at, steps: [], created: [], changed: [], askedBy };
        items.push(steps);
      }
      steps.steps.push(step);
      if (entry.pageId) steps.pageId = entry.pageId;
      steps.created.push(...(entry.created ?? []));
      steps.changed.push(...(entry.changed ?? []));
      return;
    }
  }
}

/** A private thread, named for the other person in it. */
export interface PrivateThread {
  withId: string;
  withName: string;
  /** When its first message was sent: threads keep the order they began in. */
  startedAt: number;
}

/**
 * This viewer's private threads, in the order they began: from messages, and
 * from questions Orb was asked for two people. `nameOf` names someone a thread
 * has no message from yet.
 */
export function privateThreads(
  chat: readonly TimelineChatInput[],
  currentUserId: string,
  orb: readonly AssistantEntry[] = [],
  nameOf: (userId: string) => string | undefined = () => undefined,
): PrivateThread[] {
  const threads = new Map<string, PrivateThread>();
  for (const entry of orb) {
    if (entry.kind !== "prompt") continue;
    const thread = orbThread(entry.audience, currentUserId);
    if (thread?.kind !== "private" || threads.has(thread.withId)) continue;
    const withName = entry.authorId === thread.withId ? entry.author : (nameOf(thread.withId) ?? "Someone");
    threads.set(thread.withId, { withId: thread.withId, withName, startedAt: entry.at });
  }
  for (const message of chat) {
    if (!message.to) continue;
    const mine = message.userId === currentUserId;
    const withId = mine ? message.to.id : message.userId;
    const withName = mine ? message.to.name : message.userName;
    const existing = threads.get(withId);
    if (!existing) threads.set(withId, { withId, withName, startedAt: message.sentAt });
    else {
      existing.startedAt = Math.min(existing.startedAt, message.sentAt);
      if (!mine) existing.withName = withName;
    }
  }
  return [...threads.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Other people's messages, and Orb's finished answers, in each thread since
 * it was last read, by thread key. A thread never read counts from the start.
 */
export function unreadByThread(
  chat: readonly TimelineChatInput[],
  currentUserId: string,
  readUpTo: Readonly<Record<string, number>>,
  orb: readonly AssistantEntry[] = [],
): Map<string, number> {
  const unread = new Map<string, number>();
  const count = (key: string, at: number) => {
    if (at <= (readUpTo[key] ?? 0)) return;
    unread.set(key, (unread.get(key) ?? 0) + 1);
  };
  for (const message of chat) {
    if (message.userId === currentUserId) continue;
    count(threadKey(message.to ? { kind: "private", withId: message.userId } : ROOM_THREAD), message.sentAt);
  }
  for (const entry of orb) {
    if (entry.kind !== "reply" || !entry.done) continue;
    const thread = orbThread(entry.audience, currentUserId);
    if (thread) count(threadKey(thread), entry.at);
  }
  return unread;
}

/** When a thread last had something in it, for marking it read up to there. */
export function newestInThread(
  chat: readonly TimelineChatInput[],
  orb: readonly AssistantEntry[],
  thread: TimelineThread,
  currentUserId: string,
): number {
  let newest = 0;
  for (const message of chat) {
    if (inThread(message, thread, currentUserId)) newest = Math.max(newest, message.sentAt);
  }
  for (const entry of orb) {
    if (inOrbThread(entry.audience, thread, currentUserId)) newest = Math.max(newest, entry.at);
  }
  return newest;
}
