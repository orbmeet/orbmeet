import { describe, expect, it } from "vitest";
import { findMeetingCode, formatCode, readCodeInput } from "./format-code";

describe("formatCode", () => {
  it("auto-inserts dashes for bare letters", () => {
    expect(formatCode("abc")).toBe("abc");
    expect(formatCode("abcd")).toBe("abc-d");
    expect(formatCode("abcdefg")).toBe("abc-defg");
    expect(formatCode("abcdefghij")).toBe("abc-defg-hij");
  });

  it("rebuilds dashes from the canonical group sizes", () => {
    expect(formatCode("abc-defg-hij")).toBe("abc-defg-hij");
    expect(formatCode("abc-")).toBe("abc");
    expect(formatCode("abc-d")).toBe("abc-d");
    expect(formatCode("ab-cdefghij")).toBe("abc-defg-hij");
    expect(formatCode("abcd-efgh-ij")).toBe("abc-defg-hij");
  });

  it("strips non-letter characters", () => {
    // Spaces and digits are removed; letters merge → auto-format kicks back in.
    expect(formatCode("abc defg hij")).toBe("abc-defg-hij");
    expect(formatCode("abc1defg2hij")).toBe("abc-defg-hij");
  });

  it("lowercases input", () => {
    expect(formatCode("ABC-DEFG-HIJ")).toBe("abc-defg-hij");
    expect(formatCode("ABCDEFGHij")).toBe("abc-defg-hij");
  });

  it("caps the formatted length at 12 characters", () => {
    expect(formatCode("abcdefghijklm")).toBe("abc-defg-hij");
    expect(formatCode("abc-defg-hijkl")).toBe("abc-defg-hij");
  });

  it("returns empty string for blank input", () => {
    expect(formatCode("")).toBe("");
  });

  it("survives caps lock turning on mid-stream (controlled input flow)", () => {
    // Simulate the real onChange handler: formatCode(e.target.value.toLowerCase()).
    // The browser appends each keystroke to the last-rendered state, then we
    // lowercase + format. Caps lock flips on after "abc".
    const keystrokes = ["a", "b", "c", "D", "E", "F", "G", "-", "H", "I", "J"];
    let state = "";
    for (const key of keystrokes) {
      state = formatCode(state + key); // .toLowerCase() happens inside formatCode
    }
    expect(state).toBe("abc-defg-hij");
  });
});

describe("readCodeInput", () => {
  it("takes the code out of a pasted link or invite", () => {
    expect(readCodeInput("https://orbmeet.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(readCodeInput("orbmeet.com/ABC-DEFG-HIJ?from=mail")).toBe("abc-defg-hij");
    expect(readCodeInput("Join me: https://orbmeet.com/abc-defg-hij, see you")).toBe("abc-defg-hij");
  });

  it("never reads a link's own letters as a code", () => {
    expect(readCodeInput("https://orbmeet.com/")).toBe("https://orbmeet.com/");
    expect(readCodeInput("https://orbmeet.com/abc-defg-hijk")).toBe("https://orbmeet.com/abc-defg-hijk");
  });

  it("shapes typed letters as before", () => {
    expect(readCodeInput("abcdefg")).toBe("abc-defg");
    expect(readCodeInput("ABC DEFG HIJ")).toBe("abc-defg-hij");
  });
});

describe("findMeetingCode", () => {
  it("finds only a whole code", () => {
    expect(findMeetingCode("/abc-defg-hij")).toBe("abc-defg-hij");
    expect(findMeetingCode("xabc-defg-hij")).toBeNull();
    expect(findMeetingCode("abcdefghij")).toBeNull();
  });
});
