import { describe, expect, it } from "vitest";
import { whiteboardTLSchema } from "./room-schema.ts";

describe("whiteboardTLSchema", () => {
  it("serializes the canonical whiteboard schema", () => {
    expect(whiteboardTLSchema.serialize()).toEqual(expect.any(Object));
  });
});
