import { describe, expect, it } from "vitest";
import { currentTimeZoneName, isValidTimeZone } from "./time-zone.ts";

function offsetsIn2026(zone: string): string[] {
  return [0, 6].map((month) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(Date.UTC(2026, month, 1))
      .find((part) => part.type === "timeZoneName")!.value,
  );
}

describe("currentTimeZoneName", () => {
  it("renames V8's legacy spellings", () => {
    expect(currentTimeZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(currentTimeZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
  });

  it("leaves a current name, and anything unknown, as it is", () => {
    expect(currentTimeZoneName("Asia/Dhaka")).toBe("Asia/Dhaka");
    expect(currentTimeZoneName("Indian/Cocos")).toBe("Indian/Cocos");
    expect(currentTimeZoneName("toString")).toBe("toString");
  });

  it("only ever swaps one spelling of a zone for another", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const current = currentTimeZoneName(zone);
      if (current === zone) continue;
      expect({ zone, current, valid: isValidTimeZone(current) }).toEqual({ zone, current, valid: true });
      expect({ zone, offsets: offsetsIn2026(current) }).toEqual({ zone, offsets: offsetsIn2026(zone) });
      expect(currentTimeZoneName(current)).toBe(current);
    }
  });
});
