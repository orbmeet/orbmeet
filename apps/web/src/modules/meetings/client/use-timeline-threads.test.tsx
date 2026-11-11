// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MeetingConversation } from "./meeting-conversation";
import type { TimelineChatInput } from "./timeline-model";
import { useTimelineThreads } from "./use-timeline-threads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const people = [
  { id: "me", name: "Atiq" },
  { id: "fayaz", name: "Fayaz" },
  { id: "sam", name: "Sam" },
];

const fromFayaz: TimelineChatInput = {
  id: "dm",
  userId: "fayaz",
  userName: "Fayaz",
  text: "saved?",
  sentAt: 2_000,
  fromSelf: false,
  to: { id: "me", name: "Atiq" },
};
const toRoom: TimelineChatInput = { id: "room", userId: "sam", userName: "Sam", text: "hi all", sentAt: 1_000, fromSelf: false };

/** `conversation`: the stay's, which outlives any one view of it. */
function harness(
  initial: { messages: TimelineChatInput[]; timelineOpen: boolean },
  conversation = new MeetingConversation(),
) {
  let latest: ReturnType<typeof useTimelineThreads> | null = null;
  function Probe(props: { messages: TimelineChatInput[]; timelineOpen: boolean }) {
    const { readUpTo } = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
    latest = useTimelineThreads({
      ...props,
      orb: undefined,
      currentUserId: "me",
      participants: people,
      readUpTo,
      markRead: (key, upTo) => conversation.markRead(key, upTo),
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (props: { messages: TimelineChatInput[]; timelineOpen: boolean }) =>
    act(() => root.render(<Probe {...props} />));
  render(initial);
  return {
    get current() {
      if (!latest) throw new Error("not rendered");
      return latest;
    },
    render,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useTimelineThreads", () => {
  it("counts a private message as unread until its thread is on screen", () => {
    const threads = harness({ messages: [toRoom, fromFayaz], timelineOpen: true });
    // Open on the room: the room is read, Fayaz's message is not.
    expect(threads.current.props.threads).toEqual([{ withId: "fayaz", withName: "Fayaz", unread: 1, present: true }]);
    expect(threads.current.props.roomUnread).toBe(0);

    act(() => threads.current.props.onSelect({ kind: "private", withId: "fayaz" }));
    expect(threads.current.props.threads[0].unread).toBe(0);
    threads.unmount();
  });

  it("keeps what was read when the view is rebuilt, as on a rejoin", () => {
    const conversation = new MeetingConversation();
    const first = harness({ messages: [toRoom, fromFayaz], timelineOpen: true }, conversation);
    act(() => first.current.props.onSelect({ kind: "private", withId: "fayaz" }));
    first.unmount();

    const again = harness({ messages: [toRoom, fromFayaz], timelineOpen: false }, conversation);
    expect(again.current.props.roomUnread).toBe(0);
    expect(again.current.props.threads[0].unread).toBe(0);
    again.unmount();
  });

  it("reads nothing while the Timeline is closed", () => {
    const threads = harness({ messages: [toRoom], timelineOpen: false });
    expect(threads.current.props.roomUnread).toBe(1);
    threads.render({ messages: [toRoom], timelineOpen: true });
    expect(threads.current.props.roomUnread).toBe(0);
    threads.unmount();
  });

  it("starts a private thread before anything is written in it, and opens it", () => {
    const threads = harness({ messages: [], timelineOpen: true });
    act(() => threads.current.openPrivate({ id: "sam", name: "Sam" }));
    expect(threads.current.props.active).toEqual({ kind: "private", withId: "sam" });
    expect(threads.current.props.threads.map((thread) => thread.withName)).toEqual(["Sam"]);
    threads.unmount();
  });

  it("offers everyone but you to write to privately, and never starts a thread with yourself", () => {
    const threads = harness({ messages: [], timelineOpen: true });
    expect(threads.current.props.people.map((person) => person.id)).toEqual(["fayaz", "sam"]);
    act(() => threads.current.openPrivate({ id: "me", name: "Atiq" }));
    expect(threads.current.props.active).toEqual({ kind: "room" });
    threads.unmount();
  });
});
