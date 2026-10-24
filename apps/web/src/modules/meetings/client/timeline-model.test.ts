import { describe, expect, it } from "vitest";
import type { AssistantEntry } from "@orbmeet/whiteboard-core/assistant";
import {
  buildTimeline,
  ORB_THREAD,
  orbThread,
  privateThreads,
  ROOM_THREAD,
  SPEECH_RUN_GAP_MS,
  threadAudience,
  unreadByThread,
  type TimelineChatInput,
  type TimelineSpeechInput,
  type TimelineThread,
} from "./timeline-model";

function chat(id: string, sentAt: number, userId = "rafi", text = id): TimelineChatInput {
  return { id, userId, userName: userId === "me" ? "Atiq" : "Rafi", text, sentAt };
}

function said(id: string, startedAt: number, userId = "rafi", updatedAt = startedAt + 2_000): TimelineSpeechInput {
  return {
    id,
    userId,
    userName: userId === "me" ? "Atiq" : userId === "rafi" ? "Rafi" : "Yousuf",
    text: id,
    isFinal: true,
    startedAt,
    updatedAt,
  };
}

describe("buildTimeline", () => {
  it("interleaves chat and speech in the order they happened", () => {
    const items = buildTimeline({
      chat: [chat("link", 5_000, "yousuf")],
      speech: [said("roots", 1_000), said("after", 9_000, "yousuf")],
      currentUserId: "me",
    });
    expect(items.map((item) => item.id)).toEqual(["roots", "link", "after"]);
  });

  it("joins one speaker's consecutive segments into a run", () => {
    const items = buildTimeline({
      chat: [],
      speech: [said("a", 1_000), said("b", 4_000), said("c", 8_000)],
      currentUserId: "me",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "speech", id: "a", at: 1_000 });
    expect(items[0].kind === "speech" && items[0].segments.map((segment) => segment.id)).toEqual(["a", "b", "c"]);
  });

  it("starts a new run when someone else speaks, a message lands, or the speaker pauses long", () => {
    const items = buildTimeline({
      chat: [chat("msg", 10_000, "yousuf")],
      speech: [
        said("rafi-1", 1_000),
        said("yousuf-1", 4_000, "yousuf"),
        said("rafi-2", 7_000),
        said("rafi-3", 12_000),
        said("rafi-4", 12_000 + 2_000 + SPEECH_RUN_GAP_MS + 1),
      ],
      currentUserId: "me",
    });
    expect(items.map((item) => item.id)).toEqual(["rafi-1", "yousuf-1", "rafi-2", "msg", "rafi-3", "rafi-4"]);
  });

  it("measures a pause from when the speaker stopped, not when they started", () => {
    // A 60s utterance followed 10s later by the next is one run.
    const items = buildTimeline({
      chat: [],
      speech: [said("long", 0, "rafi", 60_000), said("next", 70_000)],
      currentUserId: "me",
    });
    expect(items).toHaveLength(1);
  });

  it("marks what you said and wrote", () => {
    const items = buildTimeline({
      chat: [chat("mine", 2_000, "me")],
      speech: [said("spoken", 1_000, "me")],
      currentUserId: "me",
    });
    expect(items.every((item) => "mine" in item && item.mine)).toBe(true);
  });

  it("keeps arrival order on ties", () => {
    const items = buildTimeline({
      chat: [chat("first", 1_000), chat("second", 1_000)],
      speech: [said("spoken", 1_000, "yousuf")],
      currentUserId: "me",
    });
    expect(items.map((item) => item.id)).toEqual(["spoken", "first", "second"]);
  });
});

function whisper(id: string, sentAt: number, from: string, to: string): TimelineChatInput {
  const names: Record<string, string> = { me: "Atiq", fayaz: "Fayaz", rafi: "Rafi" };
  return { id, userId: from, userName: names[from], text: id, sentAt, to: { id: to, name: names[to] } };
}

describe("private threads", () => {
  const messages = [
    chat("to-room", 1_000),
    whisper("fayaz-asks", 2_000, "fayaz", "me"),
    whisper("i-answer", 3_000, "me", "fayaz"),
    whisper("rafi-asks", 4_000, "rafi", "me"),
  ];

  it("keeps private messages out of the room", () => {
    const items = buildTimeline({ chat: messages, speech: [said("spoken", 500)], currentUserId: "me" });
    expect(items.map((item) => item.id)).toEqual(["spoken", "to-room"]);
  });

  it("shows a private thread as the two people's messages and nothing else", () => {
    const items = buildTimeline({
      chat: messages,
      speech: [said("spoken", 2_500)],
      orb: [{ id: "ask", at: 2_600, kind: "prompt", author: "Rafi", authorId: "rafi", text: "?" }],
      currentUserId: "me",
      thread: { kind: "private", withId: "fayaz" },
    });
    expect(items.map((item) => item.id)).toEqual(["fayaz-asks", "i-answer"]);
  });

  it("names each thread for the other person, in the order the threads began", () => {
    expect(privateThreads(messages, "me")).toEqual([
      { withId: "fayaz", withName: "Fayaz", startedAt: 2_000 },
      { withId: "rafi", withName: "Rafi", startedAt: 4_000 },
    ]);
  });

  it("counts other people's messages since each thread was last read", () => {
    const unread = unreadByThread(messages, "me", { room: 1_000, "private:fayaz": 0 });
    expect(Object.fromEntries(unread)).toEqual({ "private:fayaz": 1, "private:rafi": 1 });
  });
});

describe("Orb in the timeline", () => {
  const orb: AssistantEntry[] = [
    { id: "ask", at: 2_000, kind: "prompt", author: "Atiq", authorId: "me", text: "is the arithmetic right?" },
    { id: "look", at: 2_100, kind: "tool", tool: "view_page", label: "Looking at the page", status: "done" },
    { id: "draw", at: 2_200, kind: "tool", tool: "create_shapes", label: "Drawing 2 shapes", status: "running" },
    { id: "answer", at: 2_300, kind: "reply", text: "Yes.", done: false },
  ];

  it("places Orb's conversation among what was said and written", () => {
    const items = buildTimeline({
      chat: [chat("before", 1_000), chat("after", 3_000)],
      speech: [],
      orb,
      currentUserId: "me",
    });
    expect(items.map((item) => item.kind)).toEqual(["chat", "orb-ask", "orb-steps", "orb-reply", "chat"]);
    expect(items[1]).toMatchObject({ kind: "orb-ask", userName: "Atiq", mine: true, text: "is the arithmetic right?" });
  });

  it("gathers one run's steps on the board into one entry", () => {
    const items = buildTimeline({ chat: [], speech: [], orb, currentUserId: "me" });
    const steps = items.find((item) => item.kind === "orb-steps");
    expect(steps?.kind === "orb-steps" && steps.steps.map((step) => step.status)).toEqual(["done", "running"]);
  });

  it("keeps an entry with no time after the one before it", () => {
    const untimed = { id: "late", kind: "notice", text: "Stopped." } as unknown as AssistantEntry;
    const items = buildTimeline({ chat: [chat("between", 2_050)], speech: [], orb: [orb[0], untimed], currentUserId: "me" });
    expect(items.map((item) => item.id)).toEqual(["ask", "late", "between"]);
  });
});

describe("Orb's entries by audience", () => {
  const pair = { kind: "private" as const, members: ["fayaz", "me"] };
  const mine = { kind: "private" as const, members: ["me"] };
  const orb = [
    { id: "r1", at: 1_000, kind: "prompt" as const, author: "Sam", authorId: "sam", text: "room question" },
    { id: "r2", at: 1_100, kind: "reply" as const, text: "room answer", done: true },
    { id: "p1", at: 2_000, kind: "prompt" as const, author: "Fayaz", authorId: "fayaz", text: "pair question", audience: pair },
    { id: "p2", at: 2_100, kind: "reply" as const, text: "pair answer", done: true, audience: pair },
    { id: "o1", at: 3_000, kind: "prompt" as const, author: "Me", authorId: "me", text: "my question", audience: mine },
    { id: "o2", at: 3_100, kind: "reply" as const, text: "my answer", done: true, audience: mine },
  ];
  const texts = (thread: TimelineThread) =>
    buildTimeline({ chat: [], speech: [], orb, currentUserId: "me", thread }).map((item) =>
      "text" in item ? item.text : item.kind,
    );

  it("puts each answer in the thread of the people who could see the question", () => {
    expect(texts(ROOM_THREAD)).toEqual(["room question", "room answer"]);
    expect(texts({ kind: "private", withId: "fayaz" })).toEqual(["pair question", "pair answer"]);
    expect(texts(ORB_THREAD)).toEqual(["my question", "my answer"]);
  });

  it("says whom an answer is for", () => {
    const [, reply] = buildTimeline({ chat: [], speech: [], orb, currentUserId: "me" });
    expect(reply).toMatchObject({ kind: "orb-reply", askedBy: { userId: "sam", userName: "Sam" } });
  });

  it("says what Orb looked at under the question's first answer only", () => {
    const items = buildTimeline({
      chat: [],
      speech: [],
      orb: [
        {
          id: "q",
          at: 1_000,
          kind: "prompt",
          author: "Sam",
          authorId: "sam",
          text: "where are we?",
          lookedAt: { pageNumber: 4, pageCount: 7, following: "Atiq" },
        },
        { id: "a1", at: 1_100, kind: "reply", text: "On the second case.", done: true },
        { id: "a2", at: 1_200, kind: "reply", text: "And the board shows it.", done: true },
      ],
      currentUserId: "me",
    });
    expect(items.map((item) => ("lookedAt" in item ? item.lookedAt : undefined))).toEqual([
      undefined,
      "Looked at page 4 of 7 (Atiq’s page).",
      undefined,
    ]);
  });

  it("opens a private thread for a question Orb was asked for two people", () => {
    expect(privateThreads([], "me", orb)).toEqual([{ withId: "fayaz", withName: "Fayaz", startedAt: 2_000 }]);
  });

  it("counts Orb's finished answers as unread in their own thread", () => {
    const unread = unreadByThread([], "me", {}, orb);
    expect(Object.fromEntries(unread)).toEqual({ room: 1, "private:fayaz": 1, orb: 1 });
  });

  it("knows a thread's audience, and an audience's thread", () => {
    expect(threadAudience(ORB_THREAD, "me")).toEqual(mine);
    expect(threadAudience({ kind: "private", withId: "fayaz" }, "me")).toEqual(pair);
    expect(orbThread(pair, "me")).toEqual({ kind: "private", withId: "fayaz" });
    expect(orbThread(pair, "sam")).toBeNull();
    expect(orbThread(undefined, "sam")).toEqual(ROOM_THREAD);
  });
});
