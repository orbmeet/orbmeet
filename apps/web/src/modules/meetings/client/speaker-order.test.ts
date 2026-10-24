import { describe, expect, it } from "vitest";
import { nextSpeakerOrder, SUSTAINED_SPEECH_MS, SWAP_COOLDOWN_MS, type SpeakerOrderInput } from "./speaker-order";

const NOW = 100_000;

function input(overrides: Partial<SpeakerOrderInput> = {}): SpeakerOrderInput {
  const order = ["nathan", "me", "maya", "priya", "sara", "omar", "lena"];
  return {
    order,
    present: order,
    speakingSince: new Map(),
    lastSpokeAt: new Map(),
    inView: 4,
    fixed: new Set(["me"]),
    now: NOW,
    lastSwapAt: 0,
    ...overrides,
  };
}

const talking = (id: string, forMs = SUSTAINED_SPEECH_MS) => new Map([[id, NOW - forMs]]);

describe("nextSpeakerOrder", () => {
  it("leaves someone already in view where they are", () => {
    const result = nextSpeakerOrder(input({ speakingSince: talking("priya") }));
    expect(result).toEqual({ order: ["nathan", "me", "maya", "priya", "sara", "omar", "lena"], swappedIn: null });
  });

  it("brings someone talking out of view in, in place of the longest quiet, and moves nobody else", () => {
    const result = nextSpeakerOrder(
      input({
        speakingSince: talking("lena"),
        lastSpokeAt: new Map([["nathan", NOW - 2_000], ["priya", NOW - 9_000]]),
      }),
    );
    // Maya has never spoken: she is the quietest in view, and swaps with Lena.
    expect(result).toEqual({ order: ["nathan", "me", "lena", "priya", "sara", "omar", "maya"], swappedIn: "lena" });
  });

  it("never moves you to make room", () => {
    const result = nextSpeakerOrder(
      input({
        order: ["me", "nathan", "priya", "maya", "sara"],
        present: ["me", "nathan", "priya", "maya", "sara"],
        inView: 2,
        speakingSince: talking("sara"),
        lastSpokeAt: new Map([["nathan", NOW - 1_000]]),
      }),
    );
    expect(result.order[0]).toBe("me");
    expect(result.order[1]).toBe("sara");
  });

  it("does not bring in a cough", () => {
    const result = nextSpeakerOrder(input({ speakingSince: talking("lena", SUSTAINED_SPEECH_MS - 1) }));
    expect(result.swappedIn).toBeNull();
  });

  it("swaps at most once per cooldown", () => {
    const soon = nextSpeakerOrder(input({ speakingSince: talking("lena"), lastSwapAt: NOW - SWAP_COOLDOWN_MS + 1 }));
    expect(soon.swappedIn).toBeNull();
    const later = nextSpeakerOrder(input({ speakingSince: talking("lena"), lastSwapAt: NOW - SWAP_COOLDOWN_MS }));
    expect(later.swappedIn).toBe("lena");
  });

  it("does not push out someone who is talking too", () => {
    const result = nextSpeakerOrder(
      input({
        order: ["me", "nathan", "lena"],
        present: ["me", "nathan", "lena"],
        inView: 2,
        speakingSince: new Map([["nathan", NOW - 5_000], ["lena", NOW - 5_000]]),
      }),
    );
    expect(result).toEqual({ order: ["me", "nathan", "lena"], swappedIn: null });
  });

  it("keeps the people still here in their places and adds newcomers at the end", () => {
    const result = nextSpeakerOrder(
      input({ order: ["priya", "me", "nathan"], present: ["me", "kai", "nathan"], inView: 10 }),
    );
    expect(result.order).toEqual(["me", "nathan", "kai"]);
  });
});
