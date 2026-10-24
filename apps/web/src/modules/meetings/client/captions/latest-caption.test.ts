import { describe, expect, it } from "vitest";
import type { CaptionTranscriptEntry } from "./board";
import { CAPTION_LINGER_MS, latestCaption } from "./latest-caption";

function said(id: string, userId: string, text: string, at: number, isFinal = true): CaptionTranscriptEntry {
  return { id, userId, userName: userId === "maya" ? "Maya Kim" : "Alex Lin", text, isFinal, startedAt: at, updatedAt: at };
}

describe("latestCaption", () => {
  it("is the newest speaker's turn, settled words then those still arriving", () => {
    const caption = latestCaption(
      [said("1", "alex", "does 8 count?", 1_000), said("2", "maya", "strictly less than,", 2_000), said("3", "maya", "so eight is out", 2_500, false)],
      3_000,
    );
    expect(caption).toMatchObject({ userName: "Maya Kim", settled: "strictly less than,", saying: "so eight is out" });
  });

  it("is gone once the room has been quiet for a while", () => {
    expect(latestCaption([said("1", "maya", "hello", 1_000)], 1_000 + CAPTION_LINGER_MS + 1)).toBeNull();
    expect(latestCaption([], 0)).toBeNull();
  });

  it("keeps the newest words of a long turn, cut at a word", () => {
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const caption = latestCaption([said("1", "maya", long, 1_000)], 1_000);
    expect(caption?.settled.startsWith("…word")).toBe(true);
    expect(caption?.settled.endsWith("word59")).toBe(true);
    expect(caption!.settled.length).toBeLessThanOrEqual(161);
  });
});
