import { describe, expect, it } from "vitest";

import { groupTranscriptTurns } from "./transcript-turns";

const line = (id: string, who: string, at: string, text: string) => ({
  id,
  participantIdentity: who,
  participantName: who === "a" ? "Atiq" : "Lena",
  text,
  startedAt: new Date(`2026-10-12T10:${at}Z`),
});

describe("groupTranscriptTurns", () => {
  it("joins one person's consecutive lines into one turn", () => {
    const turns = groupTranscriptTurns([
      line("1", "a", "01:00", "Okay, page four."),
      line("2", "a", "01:05", "Who wants the first move?"),
      line("3", "l", "01:20", "Take away five?"),
      line("4", "a", "01:30", "Exactly."),
    ]);
    expect(turns.map((turn) => `${turn.participantName}: ${turn.text}`)).toEqual([
      "Atiq: Okay, page four. Who wants the first move?",
      "Lena: Take away five?",
      "Atiq: Exactly.",
    ]);
    expect(turns[0].key).toBe("1");
  });

  it("starts a new turn after a long pause, and skips empty lines", () => {
    const turns = groupTranscriptTurns([
      line("1", "a", "01:00", "Before the break."),
      line("2", "a", "01:10", "   "),
      line("3", "a", "05:00", "After it."),
    ]);
    expect(turns.map((turn) => turn.text)).toEqual(["Before the break.", "After it."]);
  });
});
