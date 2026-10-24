import { describe, expect, it } from "vitest";
import { keepLastCopyPerId } from "./infinite-pages";

describe("keepLastCopyPerId", () => {
  it("keeps a row that moved past the cursor once, where the later page put it", () => {
    const result = keepLastCopyPerId({
      pages: [
        { schedules: [{ id: "a", startsAt: "09:00" }, { id: "moved", startsAt: "10:00" }], nextCursor: "c1" },
        { schedules: [{ id: "b", startsAt: "12:00" }, { id: "moved", startsAt: "13:00" }], nextCursor: undefined },
      ],
      pageParams: [undefined, "c1"],
    }, "schedules");

    expect(result.pages.map((page) => page.schedules.map((row) => row.id))).toEqual([["a"], ["b", "moved"]]);
    expect(result.pages[1]?.schedules[1]?.startsAt).toBe("13:00");
    expect(result.pages[0]?.nextCursor).toBe("c1");
    expect(result.pageParams).toEqual([undefined, "c1"]);
  });
});
