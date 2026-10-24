import { describe, expect, it } from "vitest";
import { bucketParticipantNames } from "./meeting-list-enrichment";

describe("bucketParticipantNames", () => {
  it("names each person once per meeting, in the order they arrived", () => {
    const names = bucketParticipantNames([
      { meetingId: "m1", displayName: "Atiq Rahman" },
      { meetingId: "m1", displayName: "Hindol Chowdhury" },
      { meetingId: "m1", displayName: "Hindol Chowdhury" },
      { meetingId: "m2", displayName: "Orion Ray" },
    ]);
    expect(names.get("m1")).toEqual(["Atiq Rahman", "Hindol Chowdhury"]);
    expect(names.get("m2")).toEqual(["Orion Ray"]);
  });

  it("stops at the limit, counting distinct names", () => {
    const names = bucketParticipantNames(
      ["A", "A", "B", "C"].map((displayName) => ({ meetingId: "m", displayName })),
      2,
    );
    expect(names.get("m")).toEqual(["A", "B"]);
  });
});
