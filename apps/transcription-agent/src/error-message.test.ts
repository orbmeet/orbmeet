import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message.js";

describe("errorMessage", () => {
  it("preserves messages from websocket-style error objects", () => {
    expect(errorMessage({ message: "socket failed", code: "ECONNRESET" }))
      .toBe("socket failed");
  });

  it("serializes non-Error diagnostic values", () => {
    expect(errorMessage({ code: "UNAVAILABLE" })).toBe('{"code":"UNAVAILABLE"}');
  });

  it("never throws while formatting an opaque object", () => {
    expect(errorMessage(Object.create(null))).toBe("Unknown error");
  });
});
