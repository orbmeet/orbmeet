import { describe, expect, it } from "vitest";
import { decodeTupleCursor, encodeTupleCursor } from "./keyset-cursor";

describe("tuple cursors", () => {
  it("round-trips the values it was given", () => {
    const cursor = encodeTupleCursor([1, "Ada Lovelace", "member_1"]);
    expect(decodeTupleCursor(cursor, ["number", "string", "string"])).toEqual([1, "Ada Lovelace", "member_1"]);
  });

  it("refuses a cursor of another shape, or one it did not write", () => {
    const cursor = encodeTupleCursor([1, "member_1"]);
    expect(decodeTupleCursor(cursor, ["number", "string", "string"])).toBeNull();
    expect(decodeTupleCursor(cursor, ["string", "string"])).toBeNull();
    expect(decodeTupleCursor("member_1", ["number", "string"])).toBeNull();
    expect(decodeTupleCursor(encodeTupleCursor([Number.NaN, "x"]), ["number", "string"])).toBeNull();
  });
});
