import { describe, expect, it } from "vitest";
import { isOrbMentionPrefix, orbQuestion, recentConversation, sharedOrbAnswer, withOrbMention } from "./orb";

describe("orbQuestion", () => {
  it("is what follows @Orb at the start of a message, in any case", () => {
    expect(orbQuestion("@Orb is the arithmetic correct?")).toBe("is the arithmetic correct?");
    expect(orbQuestion("  @orb, draw a number line")).toBe("draw a number line");
    expect(orbQuestion("@ORB: check page 2")).toBe("check page 2");
    expect(orbQuestion("@Orb")).toBe("");
  });

  it("is null for a message not addressed to Orb", () => {
    expect(orbQuestion("is the arithmetic correct?")).toBeNull();
    expect(orbQuestion("thanks @Orb")).toBeNull();
    expect(orbQuestion("@Orbital mechanics")).toBeNull();
    expect(orbQuestion("@Orb2 hello")).toBeNull();
  });
});

describe("the @Orb mention", () => {
  it("is offered while what is typed could still become @Orb", () => {
    expect(["@", "@o", "@Or", "@orb"].map(isOrbMentionPrefix)).toEqual([true, true, true, true]);
    expect(["", "o", "@x", "@orbs", "hello"].map(isOrbMentionPrefix)).toEqual([false, false, false, false, false]);
  });

  it("completes the mention without losing what was typed", () => {
    expect(withOrbMention("@o")).toBe("@Orb ");
    expect(withOrbMention("is this right?")).toBe("@Orb is this right?");
    expect(withOrbMention("@orb is this right?")).toBe("@Orb is this right?");
  });
});

describe("recentConversation", () => {
  const segment = (userName: string, text: string, startedAt: number, isFinal = true) => ({ userName, text, startedAt, isFinal });
  const chat = (userName: string, text: string, sentAt: number, to?: { id: string; name: string }) => ({ userName, text, sentAt, to });

  it("gives Orb one line per turn of the last ten minutes, final words only", () => {
    const now = 20 * 60_000;
    expect(
      recentConversation(
        {
          said: [
            segment("Sam", "too long ago", now - 11 * 60_000),
            segment("Maya", "absolute value is distance", now - 60_000),
            segment("Maya", "from zero", now - 50_000),
            segment("Alex", "does 8 count?", now - 40_000),
            segment("Maya", "still saying", now - 1_000, false),
          ],
          chat: [],
        },
        now,
      ),
    ).toBe("Maya: absolute value is distance from zero\nAlex: does 8 count?");
  });

  it("puts the room's chat in among what was said, and leaves private messages out", () => {
    const now = 20 * 60_000;
    expect(
      recentConversation(
        {
          said: [segment("Maya", "let's plan the launch", now - 90_000)],
          chat: [
            chat("Atiq", "the steps are", now - 60_000),
            chat("Atiq", "plan, build, test", now - 59_000),
            chat("Sam", "just between us", now - 30_000, { id: "user:a", name: "Atiq" }),
            chat("Sam", "old news", now - 11 * 60_000),
          ],
        },
        now,
      ),
    ).toBe("Maya: let's plan the launch\nAtiq (in the chat): the steps are / plan, build, test");
  });

  it("includes what the room asked Orb and its answers, not private threads", () => {
    const now = 20 * 60_000;
    expect(
      recentConversation(
        {
          said: [],
          chat: [],
          orb: [
            { id: "1", at: now - 50_000, kind: "prompt", author: "Atiq", authorId: "user:a", text: "draw a flowchart" },
            { id: "2", at: now - 40_000, audience: { kind: "room" }, kind: "reply", text: "I've drawn the flowchart.", done: true },
            { id: "3", at: now - 30_000, kind: "reply", text: "still writing", done: false },
            { id: "4", at: now - 20_000, kind: "prompt", author: "Sam", authorId: "user:s", text: "what did I miss?", audience: { kind: "private", members: ["user:s"] } },
          ],
        },
        now,
      ),
    ).toBe("Atiq (in the chat): @Orb draw a flowchart\nOrb (in the chat): I've drawn the flowchart.");
  });
});

describe("sharedOrbAnswer", () => {
  it("quotes Orb, and fits a message", () => {
    expect(sharedOrbAnswer("Yes.", 500)).toBe("Orb said: “Yes.”");
    const long = sharedOrbAnswer("x".repeat(600), 500);
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long.endsWith("…”")).toBe(true);
  });
});
