import { describe, expect, it } from "vitest";
import { planFollowUps } from "./follow-up-plan";

const draft = (text: string, ownerName: string | null = null) => ({ text, ownerName });

describe("planFollowUps", () => {
  it("keeps a reworded follow-up under its id, so a tick and an open page both survive", () => {
    const plan = planFollowUps(
      [{ id: "f1", text: "Send Orion the practice set", done: true }],
      [draft("Send the practice set to Orion", "Atiq")],
    );
    expect(plan).toEqual({
      keep: [{ id: "f1", text: "Send the practice set to Orion", ownerName: "Atiq", position: 0, rewritten: true }],
      add: [],
      remove: [],
    });
  });

  it("adds what is new and drops open items nobody repeated", () => {
    const plan = planFollowUps(
      [{ id: "f1", text: "Review Bayes’ rule", done: false }],
      [draft("Book the next session")],
    );
    expect(plan.add).toEqual([{ text: "Book the next session", ownerName: null, position: 0 }]);
    expect(plan.remove).toEqual(["f1"]);
    expect(plan.keep).toEqual([]);
  });

  it("keeps done work the new list forgot, after the new list", () => {
    const plan = planFollowUps(
      [{ id: "f1", text: "Email the worksheet", done: true }],
      [draft("Book the next session")],
    );
    expect(plan.keep).toEqual([{ id: "f1", text: "Email the worksheet", ownerName: null, position: 1, rewritten: false }]);
    expect(plan.remove).toEqual([]);
  });

  it("gives each stored row to one new item at most", () => {
    const plan = planFollowUps(
      [{ id: "f1", text: "Send the practice set", done: false }],
      [draft("Send the practice set"), draft("Send the practice set again")],
    );
    expect(plan.keep.map((row) => row.id)).toEqual(["f1"]);
    expect(plan.add.map((row) => row.position)).toEqual([1]);
  });
});
