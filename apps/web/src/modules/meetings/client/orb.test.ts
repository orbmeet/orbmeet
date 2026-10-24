import { describe, expect, it } from "vitest";
import { isOrbMentionPrefix, orbQuestion, recentlySaid, sharedOrbAnswer, withOrbMention } from "./orb";

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

describe("recentlySaid", () => {
  const segment = (userName: string, text: string, startedAt: number, isFinal = true) => ({ userName, text, startedAt, isFinal });

  it("gives Orb one line per turn of the last ten minutes, final words only", () => {
    const now = 20 * 60_000;
    expect(
      recentlySaid(
        [
          segment("Sam", "too long ago", now - 11 * 60_000),
          segment("Maya", "absolute value is distance", now - 60_000),
          segment("Maya", "from zero", now - 50_000),
          segment("Alex", "does 8 count?", now - 40_000),
          segment("Maya", "still saying", now - 1_000, false),
        ],
        now,
      ),
    ).toBe("Maya: absolute value is distance from zero\nAlex: does 8 count?");
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
