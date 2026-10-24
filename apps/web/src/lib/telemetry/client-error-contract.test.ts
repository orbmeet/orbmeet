import { describe, expect, it } from "vitest";
import { parseClientErrorReport } from "./client-error-contract";

describe("client error report contract", () => {
  it("cuts what is too long instead of losing the report", () => {
    const report = parseClientErrorReport({
      source: "boundary",
      boundary: "route",
      name: "TypeError",
      message: "m".repeat(5_000),
      stack: "s".repeat(20_000),
      route: "/join/$token",
    });
    expect(report).toMatchObject({ source: "boundary", boundary: "route", name: "TypeError", route: "/join/$token" });
    expect(report?.message).toHaveLength(1_000);
    expect(report?.stack).toHaveLength(8_000);
  });

  it("drops a field that is not text, and keeps nothing it does not know", () => {
    const report = parseClientErrorReport({ source: "error", message: { nested: true }, cookie: "x" });
    expect(report).toEqual(expect.objectContaining({ source: "error", message: undefined }));
    expect(report).not.toHaveProperty("cookie");
  });

  it("refuses a report that does not say where it came from", () => {
    expect(parseClientErrorReport({ message: "boom" })).toBeNull();
    expect(parseClientErrorReport({ source: "console", message: "boom" })).toBeNull();
  });
});
