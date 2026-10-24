import * as stylex from "@stylexjs/stylex";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { accent } from "@orbmeet/ui/tokens/colors.stylex";
import { hasStyle } from "@/test/stylex-markup";
import type { CaptionTranscriptEntry } from "@/modules/meetings/client/captions/board";
import { MeetingTimeline, type MeetingTimelineProps } from "./meeting-timeline";

/**
 * The declarations the contracts below are about, written as the component
 * writes them so they compile to the same classes — see `test/stylex-markup.ts`.
 */
const marks = stylex.create({
  /** Your own message: on the accent, its tail on your side. */
  mine: { borderEndEndRadius: 5, backgroundColor: accent.a600 },
  /** Words still being revised as the speaker talks. */
  saying: { fontStyle: "italic" },
});

const said = (overrides: Partial<CaptionTranscriptEntry> = {}): CaptionTranscriptEntry => ({
  id: "s1",
  userId: "rafi",
  userName: "Rafi",
  text: "the discriminant is sixteen",
  isFinal: true,
  startedAt: 1_000,
  updatedAt: 1_500,
  ...overrides,
});

function render(overrides: Partial<MeetingTimelineProps> = {}) {
  return renderToStaticMarkup(
    <MeetingTimeline
      messages={[]}
      currentUserId="me"
      onSendMessage={async () => true}
      speech={{ shown: true, entries: [], onToggle: () => {} }}
      embedded
      {...overrides}
    />,
  );
}

describe("MeetingTimeline", () => {
  it("is one stream: there is no filter to choose between chat and speech", () => {
    const markup = render({
      messages: [{ id: "m1", userId: "rafi", userName: "Rafi", text: "a link", sentAt: 2_000 }],
      speech: { shown: true, entries: [said()], onToggle: () => {} },
    });

    expect(markup).toContain("the discriminant is sixteen");
    expect(markup).toContain("a link");
    expect(markup).not.toContain("Spoken");
    expect(markup).not.toContain('aria-label="Show in the timeline"');
  });

  it("turns what is said off and on with a switch that names it", () => {
    const shown = render({ embedded: false });
    expect(shown).toContain('role="switch"');
    expect(shown).toContain('aria-checked="true"');
    expect(shown).toContain("Show speech");

    const hidden = render({ embedded: false, speech: { shown: false, entries: [said()], onToggle: () => {} } });
    expect(hidden).toContain('aria-checked="false"');
    expect(hidden).not.toContain("the discriminant is sixteen");
  });

  it("leaves the switch to the side column's header when docked there", () => {
    expect(render({ embedded: true })).not.toContain('role="switch"');
  });

  it("sets your own messages apart from everyone else's", () => {
    const markup = render({
      messages: [
        { id: "mine", userId: "me", userName: "Atiq", text: "from me", sentAt: 1_000 },
      ],
    });
    expect(hasStyle(markup, marks.mine)).toBe(true);

    const theirs = render({
      messages: [{ id: "theirs", userId: "rafi", userName: "Rafi", text: "from Rafi", sentAt: 1_000 }],
    });
    expect(hasStyle(theirs, marks.mine)).toBe(false);
  });

  it("marks words that are still being said", () => {
    const markup = render({
      speech: { shown: true, entries: [said({ isFinal: false, text: "and the roo" })], onToggle: () => {} },
    });
    expect(markup).toContain("and the roo");
    expect(hasStyle(markup, marks.saying)).toBe(true);
  });
});
