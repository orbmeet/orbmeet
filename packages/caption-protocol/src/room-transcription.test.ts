import { describe, expect, it } from "vitest";
import { roomAllowsTranscription } from "./room-transcription.ts";

describe("roomAllowsTranscription", () => {
  it("follows the meeting's switch", () => {
    expect(roomAllowsTranscription(JSON.stringify({ version: 2, transcription: true }))).toBe(true);
    expect(roomAllowsTranscription(JSON.stringify({ version: 3, transcription: false }))).toBe(false);
  });

  it("transcribes nothing before the room has metadata, or when it does not parse", () => {
    expect(roomAllowsTranscription(undefined)).toBe(false);
    expect(roomAllowsTranscription("")).toBe(false);
    expect(roomAllowsTranscription("{not json")).toBe(false);
    expect(roomAllowsTranscription("null")).toBe(false);
  });

  it("reads metadata written before the switch existed as on", () => {
    expect(roomAllowsTranscription(JSON.stringify({ version: 1, joinPolicy: "open" }))).toBe(true);
  });
});
