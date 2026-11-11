import { describe, expect, it } from "vitest";
import { crossesDocumentBoundary } from "./document-boundary";

describe("crossesDocumentBoundary", () => {
  it("is crossed entering a meeting from the app, and leaving one for it", () => {
    // Sign-in sending someone on to the meeting they came for.
    expect(crossesDocumentBoundary("/auth", "/abc-defg-hij")).toBe(true);
    // Leaving a meeting for Home, where the checkout lives.
    expect(crossesDocumentBoundary("/abc-defg-hij", "/home")).toBe(true);
    expect(crossesDocumentBoundary("/abc-defg-hij", "/meetings/meeting_01hzy3v9k2m4n6p8q0r2s4t6v8")).toBe(true);
  });

  it("is not crossed within either side", () => {
    expect(crossesDocumentBoundary("/home", "/meetings/meeting_01hzy3v9k2m4n6p8q0r2s4t6v8")).toBe(false);
    expect(crossesDocumentBoundary("/abc-defg-hij", "/abc-defg-hij")).toBe(false);
  });
});
