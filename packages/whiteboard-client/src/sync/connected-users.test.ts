import { describe, expect, it } from "vitest";
import { normalizeConnectedWhiteboardUsers } from "./connected-users";

describe("normalizeConnectedWhiteboardUsers", () => {
  it("reconstructs valid records and removes duplicates", () => {
    expect(normalizeConnectedWhiteboardUsers([
      { userId: "user-1", userName: "Ada", privileged: true },
      { userId: "user-1", userName: "Duplicate" },
      { userId: "user-2", userName: "" },
    ])).toEqual([
      { userId: "user-1", userName: "Ada" },
      { userId: "user-2", userName: "" },
    ]);
  });

  it("drops malformed list entries", () => {
    expect(normalizeConnectedWhiteboardUsers([
      null,
      "user-1",
      { userId: "", userName: "Nobody" },
      { userId: "user-2", userName: 42 },
      { userId: "bad\nuser", userName: "Bad" },
    ])).toEqual([]);
    expect(normalizeConnectedWhiteboardUsers({})).toEqual([]);
  });

  it("keeps whether someone can write, and the principal that grants it, when the room sends them", () => {
    expect(normalizeConnectedWhiteboardUsers([
      { userId: "user-1", userName: "Ada", principalKey: "user:user-1", canEdit: false },
      { userId: "user-2", userName: "Bo", principalKey: 7, canEdit: "yes" },
    ])).toEqual([
      { userId: "user-1", userName: "Ada", principalKey: "user:user-1", canEdit: false },
      { userId: "user-2", userName: "Bo" },
    ]);
  });
});
