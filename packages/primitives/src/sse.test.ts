import { describe, expect, it } from "vitest";

import { extractSseData } from "./sse.ts";

describe("extractSseData", () => {
  it("joins data fields and removes only the optional field separator space", () => {
    expect(extractSseData("data:  first  \ndata:second")).toBe(" first  \nsecond");
  });

  it("does not reinterpret indented non-fields as data", () => {
    expect(extractSseData(" data: hidden\nevent: message")).toBeNull();
  });

  it("treats bare carriage returns as SSE line endings", () => {
    expect(extractSseData("data: first\rdata: second\r\r")).toBe("first\nsecond");
  });

  it("normalizes line endings and ignores the stream terminator", () => {
    expect(extractSseData("data: {\"ok\":true}\r\n\r\n")).toBe('{"ok":true}');
    expect(extractSseData("data: [DONE]\n\n")).toBeNull();
  });
});
