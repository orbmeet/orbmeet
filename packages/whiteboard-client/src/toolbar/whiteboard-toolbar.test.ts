import { describe, expect, it } from "vitest";
import {
  getWhiteboardToolbarVariant,
  shouldShowInlineWhiteboardAiButton,
} from "./whiteboard-toolbar";

describe("shouldShowInlineWhiteboardAiButton", () => {
  it("keeps the compact AI action only in the More menu", () => {
    expect(shouldShowInlineWhiteboardAiButton(true, true, true)).toBe(false);
  });

  it("shows the inline AI action on regular whiteboards when available", () => {
    expect(shouldShowInlineWhiteboardAiButton(false, true, true)).toBe(true);
    expect(shouldShowInlineWhiteboardAiButton(false, false, true)).toBe(false);
    expect(shouldShowInlineWhiteboardAiButton(false, true, false)).toBe(false);
  });
});

describe("getWhiteboardToolbarVariant", () => {
  it("gives phone portrait the minimal annotate-only kit", () => {
    expect(getWhiteboardToolbarVariant(true, true)).toBe("minimal");
  });

  it("keeps the full scrollable compact toolbar on tablets", () => {
    expect(getWhiteboardToolbarVariant(true, false)).toBe("compact");
  });

  it("uses the regular toolbar on desktop even in a meeting", () => {
    expect(getWhiteboardToolbarVariant(false, false)).toBe("regular");
    // Regular chrome never minimizes, whatever the pill flag claims.
    expect(getWhiteboardToolbarVariant(false, true)).toBe("regular");
  });
});
