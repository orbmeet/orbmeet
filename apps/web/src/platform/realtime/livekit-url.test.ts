import { describe, expect, it } from "vitest";
import { livekitHttpUrl } from "./livekit-url";

describe("livekitHttpUrl", () => {
  it.each([
    ["ws://lk.example.com", "http://lk.example.com"],
    ["wss://lk.example.com", "https://lk.example.com"],
    ["wss://lk.example.com/", "https://lk.example.com"],
    ["ws://localhost:7880", "http://localhost:7880"],
    ["wss://lk.example.com/signal", "https://lk.example.com/signal"],
  ])("maps %s to %s", (input, expected) => {
    expect(livekitHttpUrl(input)).toBe(expected);
  });
});
