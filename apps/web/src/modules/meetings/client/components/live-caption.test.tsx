import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionTranscriptEntry } from "@/modules/meetings/client/captions/board";
import { LiveCaption } from "./live-caption";

const NOW = 1_000_000;

function said(text: string, isFinal = true, at = NOW - 1_000): CaptionTranscriptEntry {
  return { id: text, userId: "maya", userName: "Maya Kim", text, isFinal, startedAt: at, updatedAt: at };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("LiveCaption", () => {
  it("folds the Conversation to who is talking and what they say, with what is new", () => {
    const markup = renderToStaticMarkup(
      <LiveCaption variant="stage" entries={[said("so eight is out,"), said("and the overlap", false)]} newCount={3} onOpen={() => {}} />,
    );
    expect(markup).toContain(">Maya<");
    expect(markup).toContain("so eight is out,");
    expect(markup).toContain("and the overlap");
    expect(markup).toContain("3 new");
    expect(markup).toContain('aria-label="Maya Kim: so eight is out, and the overlap. Open the conversation, 3 new"');
  });

  it("leaves a quiet room's stage clear", () => {
    expect(
      renderToStaticMarkup(<LiveCaption variant="board" entries={[said("hello", true, NOW - 60_000)]} newCount={2} onOpen={() => {}} />),
    ).toBe("");
  });
});
