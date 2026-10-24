// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAssistant } from "@/modules/meetings/client/orb";
import type { TimelineThreadsProps } from "./timeline-threads";
import { MeetingTimeline, type MeetingTimelineProps } from "./meeting-timeline";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLElement;
let root: Root;

// Node's own `localStorage` shadows jsdom's and has no file behind it here:
// an in-memory one, so what the tips remember carries from one mount to the next.
const stored = new Map<string, string>();
beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
      clear: () => stored.clear(),
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stored.clear();
});

async function mount(overrides: Partial<MeetingTimelineProps> = {}) {
  const props: MeetingTimelineProps = {
    messages: [],
    currentUserId: "me",
    onSendMessage: vi.fn(async () => true),
    speech: { shown: true, entries: [], onToggle: () => {} },
    embedded: true,
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MeetingTimeline {...props} />));
  return props;
}

function input(): HTMLInputElement {
  const element = container.querySelector("form input");
  if (!(element instanceof HTMLInputElement)) throw new Error("No message box");
  return element;
}

async function type(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send() {
  await act(async () => {
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function orb(overrides: Partial<MeetingAssistant> = {}): MeetingAssistant {
  return {
    available: true,
    live: true,
    canDraw: true,
    entries: [],
    runs: [],
    prompt: vi.fn(async () => null),
    cancel: vi.fn(),
    mayCancel: () => false,
    showShapes: vi.fn(),
    removeShapes: vi.fn(() => null),
    ...overrides,
  };
}

function privateWithFayaz(present = true): TimelineThreadsProps {
  return {
    active: { kind: "private", withId: "fayaz" },
    threads: [{ withId: "fayaz", withName: "Fayaz", unread: 0, present }],
    roomUnread: 0,
    people: [{ id: "fayaz", name: "Fayaz" }],
    onSelect: () => {},
    onStart: () => {},
  };
}

describe("asking Orb from the Timeline", () => {
  it("sends '@Orb …' in the room to Orb, not to the chat", async () => {
    const assistant = orb();
    const props = await mount({ orb: assistant });
    await type("@Orb is the arithmetic correct?");
    await send();

    expect(assistant.prompt).toHaveBeenCalledWith("is the arithmetic correct?", { audience: { kind: "room" }, said: "" });
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(input().value).toBe("");
  });

  it("says Orb lives on the board when the board is closed, and keeps the question", async () => {
    const props = await mount({ orb: null });
    await type("@Orb is the arithmetic correct?");
    await send();

    expect(container.textContent).toContain("Open the board, then ask again");
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(input().value).toBe("@Orb is the arithmetic correct?");
  });

  it("keeps the question and says why when Orb is busy with someone else", async () => {
    const assistant = orb({ runs: [{ id: "r1", requesterUserId: "sam", requesterName: "Sam" }] });
    await mount({ orb: assistant });
    await type("@Orb and this one?");
    await send();

    expect(assistant.prompt).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Orb is answering Sam. Ask again in a moment.");
  });

  it("offers @Orb while it is being typed, and completes it", async () => {
    await mount({ orb: orb() });
    await type("@o");
    const offer = [...container.querySelectorAll("form button")].find((button) => button.textContent?.includes("@Orb"));
    expect(offer).toBeDefined();

    await act(async () => (offer as HTMLButtonElement).click());
    expect(input().value).toBe("@Orb ");
  });

  it("treats '@Orb' as plain text where Orb has no part in the room", async () => {
    const props = await mount({ orb: undefined });
    await type("@Orb hello");
    await send();
    expect(props.onSendMessage).toHaveBeenCalledWith("@Orb hello", undefined);
  });
});

describe("private threads in the Timeline", () => {
  it("sends a private message only to its one person, and says so above the box", async () => {
    const props = await mount({ threads: privateWithFayaz() });
    expect(container.textContent).toContain("Private to Fayaz");
    expect(container.textContent).toContain("Only you and Fayaz see this");

    await type("did you save the board?");
    await send();
    expect(props.onSendMessage).toHaveBeenCalledWith("did you save the board?", { id: "fayaz", name: "Fayaz" });
  });

  it("asks Orb from a private thread for the two people in it alone", async () => {
    const assistant = orb();
    const props = await mount({ orb: assistant, threads: privateWithFayaz() });
    expect(container.textContent).toContain("@Orb answers just you two");
    await type("@Orb is this right?");
    await send();

    expect(assistant.prompt).toHaveBeenCalledWith("is this right?", {
      audience: { kind: "private", with: "fayaz" },
      said: "",
    });
    expect(props.onSendMessage).not.toHaveBeenCalled();
  });

  it("shows Orb's answer to the two of them in their thread, and not in the room", async () => {
    const audience = { kind: "private" as const, members: ["fayaz", "me"] };
    const entries = [
      { id: "ask", at: 1_000, kind: "prompt" as const, author: "You", authorId: "me", text: "send the recap?", audience },
      { id: "answer", at: 1_100, kind: "reply" as const, text: "Sent.", done: true, audience },
    ];
    await mount({ orb: orb({ entries }), threads: privateWithFayaz() });
    expect(container.querySelector('article[aria-label="Orb said"]')?.textContent).toContain("just you two");
    expect(container.textContent).toContain("Share with room");

    act(() => root.unmount());
    container.remove();
    await mount({ orb: orb({ entries }) });
    expect(container.textContent).not.toContain("Sent.");
  });

  it("shows only the two people's messages", async () => {
    await mount({
      threads: privateWithFayaz(),
      messages: [
        { id: "room", userId: "sam", userName: "Sam", text: "for everyone", sentAt: 1_000 },
        { id: "dm", userId: "fayaz", userName: "Fayaz", text: "just for you", sentAt: 2_000, to: { id: "me", name: "Atiq" } },
      ],
    });
    expect(container.textContent).toContain("just for you");
    expect(container.textContent).not.toContain("for everyone");
  });

  it("closes the box once the other person has left", async () => {
    await mount({ threads: privateWithFayaz(false) });
    expect(input().disabled).toBe(true);
    expect(container.textContent).toContain("Fayaz has left the meeting");
  });

  it("says a room message goes to everyone, once, in the box", async () => {
    await mount();
    expect(input().placeholder).toBe("Message everyone");
    expect(container.textContent).not.toContain("To everyone");
  });
});

describe("Orb's side of the conversation", () => {
  it("keeps what Orb said in the room after the board closes", async () => {
    await mount({
      orb: null,
      orbHistory: [
        { id: "ask", at: 1_000, kind: "prompt", author: "Sam", authorId: "sam", text: "is page 2 right?" },
        { id: "answer", at: 1_100, kind: "reply", text: "Yes, it checks out.", done: true },
      ],
    });
    expect(container.querySelector('article[aria-label="Orb said"]')?.textContent).toContain("Yes, it checks out.");
  });

  it("shows Orb's answer under its name, and who it is answering while it works", async () => {
    await mount({
      orb: orb({
        mayCancel: () => true,
        runs: [{ id: "r1", requesterUserId: "sam", requesterName: "Sam" }],
        entries: [
          { id: "ask", at: 1_000, kind: "prompt", author: "Sam", authorId: "sam", text: "is page 2 right?" },
          { id: "answer", at: 1_100, kind: "reply", text: "Yes, it checks out.", done: false },
        ],
      }),
    });
    expect(container.textContent).toContain("@Orb is page 2 right?");
    expect(container.querySelector('article[aria-label="Orb said"]')?.textContent).toContain("Yes, it checks out.");
    expect(container.textContent).toContain("Orb is answering Sam…");
    expect(container.textContent).toContain("replying to Sam");
    expect(container.textContent).toContain("Stop");
  });
});

describe("your own thread with Orb", () => {
  function withOrb(): TimelineThreadsProps {
    return { ...privateWithFayaz(), active: { kind: "orb" }, orb: { unread: 0 } };
  }

  it("asks Orb everything written there, privately, with what was said lately", async () => {
    const assistant = orb();
    const props = await mount({
      orb: assistant,
      threads: withOrb(),
      speech: {
        shown: false,
        onToggle: () => {},
        entries: [
          { id: "s1", userId: "maya", userName: "Maya", text: "so we split it", isFinal: true, startedAt: Date.now(), updatedAt: Date.now() },
        ],
      },
    });
    expect(container.textContent).toContain("Only you see this");

    await type("what did I miss?");
    await send();
    expect(assistant.prompt).toHaveBeenCalledWith("what did I miss?", {
      audience: { kind: "private" },
      said: "Maya: so we split it",
    });
    expect(props.onSendMessage).not.toHaveBeenCalled();
  });

  it("shows only what Orb answered you alone", async () => {
    await mount({
      orb: orb({
        entries: [
          { id: "room", at: 1_000, kind: "reply", text: "For the room.", done: true },
          { id: "mine", at: 1_100, kind: "reply", text: "Just for you.", done: true, audience: { kind: "private", members: ["me"] } },
        ],
      }),
      threads: withOrb(),
    });
    expect(container.textContent).toContain("Just for you.");
    expect(container.textContent).not.toContain("For the room.");
  });
});

describe("what Orb drew", () => {
  const entries = [
    { id: "ask", at: 1_000, kind: "prompt" as const, author: "You", authorId: "me", text: "draw a box" },
    {
      id: "step",
      at: 1_100,
      kind: "tool" as const,
      tool: "create_shapes" as const,
      label: "Drawing 1 shape",
      status: "done" as const,
      pageId: "shape:page-1",
      created: ["box"],
    },
  ];

  it("can be shown on the board by anyone, and taken back once by whoever asked", async () => {
    const assistant = orb({ entries });
    await mount({ orb: assistant });
    const button = (name: string) =>
      [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

    await act(async () => button("Show on board")?.click());
    expect(assistant.showShapes).toHaveBeenCalledWith("shape:page-1", ["box"]);

    await act(async () => button("Undo")?.click());
    expect(assistant.removeShapes).toHaveBeenCalledWith(["box"]);
    expect(button("Undo")).toBeUndefined();
  });

  it("offers no Undo to someone who did not ask", async () => {
    await mount({ orb: orb({ entries: entries.map((entry) => (entry.kind === "prompt" ? { ...entry, authorId: "sam" } : entry)) }) });
    expect(container.textContent).toContain("Show on board");
    expect(container.textContent).not.toContain("Undo");
  });
});

describe("teaching Orb", () => {
  const teaching = { transcribing: true, paletteShortcut: "⌘K" };
  const tipLine = () => container.querySelector('button[aria-label="Turn off tips"]')?.parentElement;

  it("starts with drawing for someone who can draw, and puts its example in the box", async () => {
    await mount({ orb: orb(), orbTeaching: teaching });
    expect(tipLine()?.textContent).toContain("Orb can draw on the board");
    const example = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("@Orb draw"));
    await act(async () => example?.click());
    expect(input().value).toBe("@Orb draw a flowchart: sign up, verify email, first meeting");
  });

  it("tells someone who can only watch how to get the pen first", async () => {
    await mount({ orb: orb({ canDraw: false }), orbTeaching: teaching });
    expect(tipLine()?.textContent).toContain("Ask to edit on the board");
  });

  it("changes the tip after a message is sent, and on the next opening", async () => {
    await mount({ orb: orb(), orbTeaching: teaching });
    const first = tipLine()?.textContent;
    await type("hello");
    await send();
    const second = tipLine()?.textContent;
    expect(second).not.toBe(first);
    act(() => root.unmount());
    container.remove();
    await mount({ orb: orb(), orbTeaching: teaching });
    expect(tipLine()?.textContent).not.toBe(second);
  });

  it("stays off once turned off", async () => {
    await mount({ orb: orb(), orbTeaching: teaching });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Turn off tips"]')?.click());
    expect(tipLine()).toBeFalsy();
    act(() => root.unmount());
    container.remove();
    await mount({ orb: orb(), orbTeaching: teaching });
    expect(tipLine()).toBeFalsy();
  });

  it("shows no tip without Orb, outside the room's stream, or when nothing asks for one", async () => {
    await mount({ orb: null, orbTeaching: teaching });
    expect(tipLine()).toBeFalsy();
    act(() => root.unmount());
    container.remove();
    await mount({ orb: orb() });
    expect(tipLine()).toBeFalsy();
  });

  it("offers a handful of questions in your thread with Orb, and others on asking", async () => {
    await mount({
      orb: orb(),
      orbTeaching: teaching,
      threads: { ...privateWithFayaz(), active: { kind: "orb" }, orb: { unread: 0 } },
    });
    const ideas = () =>
      [...container.querySelectorAll('[aria-label="Questions to try"] button')]
        .map((button) => button.textContent)
        .filter((text) => text !== "Other ideas");
    const first = ideas();
    expect(first).toHaveLength(4);
    const other = [...container.querySelectorAll("button")].find((button) => button.textContent === "Other ideas");
    await act(async () => other?.click());
    expect(ideas()).not.toEqual(first);
    const pick = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Questions to try"] button')].at(-1);
    await act(async () => pick?.click());
    expect(input().value).toBe(pick?.textContent);
    expect(container.textContent).toContain("To have it draw, ask with @Orb in Everyone");
  });
});
