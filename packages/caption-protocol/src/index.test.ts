import { describe, expect, it } from "vitest";
import {
  CAPTION_ATTRIBUTE,
  MAX_CAPTION_ID_LENGTH,
  encodeCaptionStreamAttributes,
  parseCaptionStreamAttributes,
  type CaptionStreamAttributes,
} from "./index.ts";

const caption: CaptionStreamAttributes = {
  trackId: "TR_mic",
  segmentId: "segment-1",
  isFinal: false,
  language: "en-US",
  revision: 7,
};

describe("caption stream attributes", () => {
  it("round-trips through LiveKit's string attributes", () => {
    const attributes = encodeCaptionStreamAttributes(caption);
    expect(attributes["lk.transcribed_track_id"]).toBe("TR_mic");
    expect(attributes["lk.transcription_final"]).toBe("false");
    expect(parseCaptionStreamAttributes(attributes)).toEqual(caption);
  });

  it("leaves the language out when there is none", () => {
    const { language: _language, ...rest } = caption;
    expect(parseCaptionStreamAttributes(encodeCaptionStreamAttributes(rest))).toEqual(rest);
  });

  it("refuses a stream missing what orders it or names its segment or track", () => {
    const attributes = encodeCaptionStreamAttributes(caption);
    for (const key of [
      CAPTION_ATTRIBUTE.trackId,
      CAPTION_ATTRIBUTE.segmentId,
      CAPTION_ATTRIBUTE.isFinal,
      CAPTION_ATTRIBUTE.revision,
    ]) {
      const { [key]: _removed, ...rest } = attributes;
      expect(parseCaptionStreamAttributes(rest)).toBeNull();
    }
    expect(parseCaptionStreamAttributes(undefined)).toBeNull();
  });

  it("refuses malformed or out-of-bounds values", () => {
    const attributes = encodeCaptionStreamAttributes(caption);
    const withValue = (key: string, value: string) => parseCaptionStreamAttributes({ ...attributes, [key]: value });
    expect(withValue(CAPTION_ATTRIBUTE.isFinal, "yes")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.revision, "-1")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.revision, "1e3")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.revision, "99999999999999999")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.revision, "")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.trackId, "")).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.segmentId, "x".repeat(MAX_CAPTION_ID_LENGTH + 1))).toBeNull();
    expect(withValue(CAPTION_ATTRIBUTE.language, "x".repeat(65))).toBeNull();
  });
});
