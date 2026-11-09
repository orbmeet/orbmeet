import { describe, expect, it } from "vitest";
import {
  guestEmailProblem,
  invalidGuestEmails,
  parseGuestEmails,
  readableScheduleError,
} from "./schedule-form";

describe("parseGuestEmails", () => {
  it("splits on commas, semicolons and lines and drops the blanks", () => {
    expect(parseGuestEmails(" a@example.com, b@example.com;\n\nc@example.com ,")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
});

describe("invalidGuestEmails", () => {
  it("returns only the addresses the server would refuse", () => {
    expect(invalidGuestEmails(["a@example.com", "sam@example", "nope"])).toEqual(["sam@example", "nope"]);
  });
});

describe("guestEmailProblem", () => {
  it("says nothing when every address is fine", () => {
    expect(guestEmailProblem([])).toBeNull();
  });

  it("names the one address that needs fixing", () => {
    expect(guestEmailProblem(["sam@example"])).toBe("“sam@example” isn’t a complete email address.");
  });

  it("names every address when several need fixing", () => {
    expect(guestEmailProblem(["a", "b"])).toBe("These aren’t complete email addresses: “a”, “b”.");
  });
});

describe("readableScheduleError", () => {
  it("drops the developer path from a validation error", () => {
    expect(readableScheduleError("attendees.0.email: Invalid email address")).toBe("Invalid email address");
  });

  it("leaves ordinary sentences alone, colons included", () => {
    const message = "Note: scheduled meetings must start at least one minute in the future";
    expect(readableScheduleError(message)).toBe(message);
  });
});
