import { describe, expect, it } from "vitest";
import { parseRecorderHashParams } from "./recorder-url-params";

describe("parseRecorderHashParams", () => {
  it("reads regular fragment params", () => {
    const params = parseRecorderHashParams("#wb_recorder_token=whiteboard-token&url=wss%3A%2F%2Flivekit.example.com&token=lk-token");

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });

  it("recovers params appended after an existing fragment", () => {
    const params = parseRecorderHashParams(
      "#wb_recorder_token=whiteboard-token?url=wss%3A%2F%2Flivekit.example.com&token=lk-token",
    );

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });

  it("merges LiveKit params from the real query string", () => {
    const params = parseRecorderHashParams(
      "#wb_recorder_token=whiteboard-token&egress_mode=streaming",
      "?url=wss%3A%2F%2Flivekit.example.com&token=lk-token&layout=",
    );

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("egress_mode")).toBe("streaming");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });
});
