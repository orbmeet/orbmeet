import { describe, expect, it } from "vitest";
import type { AssistantEntry } from "@orbmeet/whiteboard-core/assistant";
import { newRoomQuestions } from "./use-open-on-room-question";

const NOW = 1_000_000;

function prompt(id: string, overrides: Partial<Extract<AssistantEntry, { kind: "prompt" }>> = {}): AssistantEntry {
  return { id, at: NOW - 1_000, kind: "prompt", author: "Sam", authorId: "sam", text: "is this right?", ...overrides };
}

describe("newRoomQuestions", () => {
  it("finds a question someone else just asked Orb in the room", () => {
    expect(newRoomQuestions([prompt("a")], new Set(), "me", NOW).map((entry) => entry.id)).toEqual(["a"]);
    expect(newRoomQuestions([prompt("a", { audience: { kind: "room" } })], new Set(), "me", NOW)).toHaveLength(1);
  });

  it("leaves out your own questions, private ones, and Orb's answers", () => {
    const entries: AssistantEntry[] = [
      prompt("mine", { authorId: "me" }),
      prompt("private", { audience: { kind: "private", members: ["me", "sam"] } }),
      { id: "reply", at: NOW, kind: "reply", text: "Yes.", done: true },
    ];
    expect(newRoomQuestions(entries, new Set(), "me", NOW)).toEqual([]);
  });

  it("leaves out a question already seen, or one asked before you could have seen it", () => {
    expect(newRoomQuestions([prompt("a")], new Set(["a"]), "me", NOW)).toEqual([]);
    expect(newRoomQuestions([prompt("old", { at: NOW - 5 * 60_000 })], new Set(), "me", NOW)).toEqual([]);
  });
});
