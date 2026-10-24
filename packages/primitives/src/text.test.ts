import { describe, expect, it } from "vitest";
import { codePointBoundary, truncateCodeUnits, truncateUtf8 } from "./text.ts";

const FACE = "\u{1F600}"; // two UTF-16 code units, four UTF-8 bytes

describe("codePointBoundary", () => {
  it("steps back off the middle of a surrogate pair", () => {
    expect(codePointBoundary(`a${FACE}b`, 2)).toBe(1);
    expect(codePointBoundary(`a${FACE}b`, 3)).toBe(3);
  });

  it("clamps to the text", () => {
    expect(codePointBoundary("abc", -1)).toBe(0);
    expect(codePointBoundary("abc", 9)).toBe(3);
  });
});

describe("truncateCodeUnits", () => {
  it("leaves text that fits alone", () => {
    expect(truncateCodeUnits("abc", 3)).toBe("abc");
  });

  it("never keeps half a character", () => {
    expect(truncateCodeUnits(`ab${FACE}`, 3)).toBe("ab");
    expect(truncateCodeUnits(`ab${FACE}`, 4)).toBe(`ab${FACE}`);
  });
});

describe("truncateUtf8", () => {
  it("cuts by encoded bytes, at a character boundary", () => {
    expect(truncateUtf8(`ab${FACE}`, 5)).toBe("ab");
    expect(truncateUtf8(`ab${FACE}`, 6)).toBe(`ab${FACE}`);
    expect(truncateUtf8("ééé", 5)).toBe("éé");
  });

  it("keeps a replacement character the text really ends with", () => {
    expect(truncateUtf8("ab�", 5)).toBe("ab�");
  });
});
