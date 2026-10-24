import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "./logger.ts";

function capture(minLevel: LogLevel, context?: () => Record<string, unknown> | undefined) {
  const lines: Array<{ level: LogLevel; entry: Record<string, unknown> }> = [];
  const logger = createLogger({
    minLevel,
    context,
    write: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("merges a first object into the line and keeps the rest under args", () => {
    const { logger, lines } = capture("info");
    logger.info("joined", { roomId: "meet-a" }, 3);
    expect(lines[0].entry).toMatchObject({ level: "info", msg: "joined", roomId: "meet-a", args: [3] });
  });

  it("redacts sensitive keys at any depth", () => {
    const { logger, lines } = capture("info");
    logger.error("refused", { request: { headers: { authorization: "Bearer x" }, token: "t" } });
    expect(lines[0].entry).toMatchObject({ request: { headers: { authorization: "[REDACTED]" }, token: "[REDACTED]" } });
  });

  it("keeps an error's stack and cuts cycles rather than throwing", () => {
    const { logger, lines } = capture("info");
    const cyclic: Record<string, unknown> = { name: "room" };
    cyclic.self = cyclic;
    logger.error("boom", cyclic, new Error("bad"));
    expect(lines[0].entry).toMatchObject({ self: "[Circular]", args: [{ name: "Error", message: "bad" }] });
  });

  it("keeps an error's code and the cause it wraps", () => {
    const { logger, lines } = capture("info");
    const cause = Object.assign(new Error("D1_ERROR: database is locked"), { code: "SQLITE_BUSY" });
    logger.error("failed", new Error("Failed query: update meetings", { cause }));
    expect(lines[0].entry.args).toMatchObject([{
      message: "Failed query: update meetings",
      cause: { message: "D1_ERROR: database is locked", code: "SQLITE_BUSY" },
    }]);
  });

  it("keeps every error an AggregateError holds", () => {
    const { logger, lines } = capture("info");
    logger.error("cleanup", new AggregateError([new Error("r2"), "plain"], "Cleanup failed: two"));
    expect(lines[0].entry.args).toMatchObject([{
      name: "AggregateError",
      errors: [{ name: "Error", message: "r2" }, "plain"],
    }]);
  });

  it("cuts an error that is its own cause", () => {
    const { logger, lines } = capture("info");
    const error = new Error("loop");
    error.cause = error;
    logger.error("boom", error);
    expect(lines[0].entry.args).toMatchObject([{ message: "loop", cause: "[Circular]" }]);
  });

  it("adds the context to every line, under the call's own fields", () => {
    const { logger, lines } = capture("info", () => ({ requestId: "r-1", route: "/a", authorization: "x" }));
    logger.info("one", { route: "/b" });
    expect(lines[0].entry).toMatchObject({ requestId: "r-1", route: "/b", authorization: "[REDACTED]" });
  });

  it("logs what JSON cannot hold as unserializable instead of failing", () => {
    const { logger, lines } = capture("info");
    logger.warn("odd", { size: 1n });
    expect(lines[0].entry).toMatchObject({ msg: "odd", args: "[Unserializable]" });
  });

  it("writes nothing below its level, and errors always", () => {
    const { logger, lines } = capture("warn");
    logger.info("quiet");
    logger.error("loud");
    expect(lines.map((line) => line.entry.msg)).toEqual(["loud"]);
  });
});
