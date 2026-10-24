import * as React from "react";
import type { TimelineThreadsProps } from "@/modules/meetings/client/components/timeline-threads";
import type { AssistantEntry } from "@orbmeet/whiteboard-core/assistant";
import {
  newestInThread,
  privateThreads,
  ORB_THREAD,
  ROOM_THREAD,
  threadKey,
  unreadByThread,
  type PrivateThread,
  type TimelineChatInput,
  type TimelineThread,
} from "@/modules/meetings/client/timeline-model";

const NO_ENTRIES: readonly AssistantEntry[] = [];

interface Person {
  id: string;
  name: string;
}

/**
 * The Timeline's threads for one viewer: which one is open, the private ones
 * — including one just started that has no message yet — their own with Orb,
 * and what in each has not been read.
 *
 * A thread counts as read up to its newest message while it is on screen in
 * an open Timeline. Kept here, above the Timeline, so closing the panel keeps
 * your place.
 */
export function useTimelineThreads({
  messages,
  orb,
  currentUserId,
  participants,
  timelineOpen,
}: {
  messages: readonly TimelineChatInput[];
  /** Orb's entries this viewer can see; undefined where Orb has no part in the room. */
  orb: readonly AssistantEntry[] | undefined;
  currentUserId: string;
  participants: readonly Person[];
  timelineOpen: boolean;
}) {
  const [active, setActive] = React.useState<TimelineThread>(ROOM_THREAD);
  const [started, setStarted] = React.useState<readonly PrivateThread[]>([]);
  const [readUpTo, setReadUpTo] = React.useState<Readonly<Record<string, number>>>({});

  const orbEntries = orb ?? NO_ENTRIES;
  const threads = React.useMemo(() => {
    const nameOf = (userId: string) => participants.find((person) => person.id === userId)?.name;
    const fromMessages = privateThreads(messages, currentUserId, orbEntries, nameOf);
    const known = new Set(fromMessages.map((thread) => thread.withId));
    return [...fromMessages, ...started.filter((thread) => !known.has(thread.withId))];
  }, [currentUserId, messages, orbEntries, participants, started]);

  const unread = React.useMemo(
    () => unreadByThread(messages, currentUserId, readUpTo, orbEntries),
    [currentUserId, messages, orbEntries, readUpTo],
  );

  // What is on screen is read.
  const activeKey = threadKey(active);
  React.useEffect(() => {
    if (!timelineOpen) return;
    const newest = newestInThread(messages, orbEntries, active, currentUserId);
    setReadUpTo((current) => (newest > (current[activeKey] ?? 0) ? { ...current, [activeKey]: newest } : current));
  }, [active, activeKey, currentUserId, messages, orbEntries, timelineOpen]);

  const presentIds = React.useMemo(() => new Set(participants.map((person) => person.id)), [participants]);
  const others = React.useMemo(
    () => participants.filter((person) => person.id !== currentUserId),
    [currentUserId, participants],
  );

  const openPrivate = React.useCallback(
    (person: Person) => {
      if (person.id === currentUserId) return;
      setStarted((current) =>
        current.some((thread) => thread.withId === person.id)
          ? current
          : [...current, { withId: person.id, withName: person.name, startedAt: Date.now() }],
      );
      setActive({ kind: "private", withId: person.id });
    },
    [currentUserId],
  );
  const showRoom = React.useCallback(() => setActive(ROOM_THREAD), []);
  const showOrb = React.useCallback(() => setActive(ORB_THREAD), []);

  const props: TimelineThreadsProps = {
    active,
    threads: threads.map((thread) => ({
      withId: thread.withId,
      withName: thread.withName,
      unread: unread.get(threadKey({ kind: "private", withId: thread.withId })) ?? 0,
      present: presentIds.has(thread.withId),
    })),
    roomUnread: unread.get(threadKey(ROOM_THREAD)) ?? 0,
    orb: orb === undefined ? undefined : { unread: unread.get(threadKey(ORB_THREAD)) ?? 0 },
    people: others,
    onSelect: setActive,
    onStart: openPrivate,
  };

  return { props, openPrivate, showRoom, showOrb };
}
