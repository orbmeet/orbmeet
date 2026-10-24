import { describe, expect, it, vi } from "vitest";
import { logError, setLogContext } from "@/lib/logger";
import { addLogContext, currentLogContext, withLogContext } from "./log-context";

setLogContext(currentLogContext);

/** The line `fn` logs. */
function logged(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    fn();
    return JSON.parse(spy.mock.calls[0][0]);
  } finally {
    spy.mockRestore();
  }
}

describe("log context", () => {
  it("puts the invocation's fields on every line logged inside it, and none outside", async () => {
    await withLogContext({ requestId: "req-1", path: "/api/x" }, async () => {
      await Promise.resolve();
      expect(logged(() => logError("inside"))).toMatchObject({ requestId: "req-1", path: "/api/x" });
    });
    expect(logged(() => logError("outside"))).not.toHaveProperty("requestId");
  });

  it("adds what becomes known partway, such as the user, and lets an inner context add to the outer", () => {
    withLogContext({ requestId: "req-1" }, () => {
      addLogContext({ userId: "user_1" });
      withLogContext({ meetingId: "meeting_1" }, () => {
        expect(logged(() => logError("inner"))).toMatchObject({
          requestId: "req-1", userId: "user_1", meetingId: "meeting_1",
        });
      });
      expect(logged(() => logError("outer"))).not.toHaveProperty("meetingId");
    });
  });

  it("lets a line's own fields win over the context's", () => {
    withLogContext({ meetingId: "meeting_1" }, () => {
      expect(logged(() => logError("own", { meetingId: "meeting_2" }))).toMatchObject({ meetingId: "meeting_2" });
    });
  });
});
