import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharedTimerChip } from "./shared-timer-chip";

function render(countdown: { active: boolean; done: boolean; remainingSeconds: number; endsAtMs: number | null }) {
  return renderToStaticMarkup(<SharedTimerChip countdown={countdown} />);
}

describe("SharedTimerChip", () => {
  it("shows nobody anything while no countdown runs", () => {
    expect(render({ active: false, done: false, remainingSeconds: 0, endsAtMs: null })).toBe("");
  });

  it("shows the room the time left, as a timer rather than a live region", () => {
    const markup = render({ active: true, done: false, remainingSeconds: 281, endsAtMs: 1_000 });
    expect(markup).toContain('role="timer"');
    expect(markup).toContain("4:41");
    expect(markup).toContain('aria-label="Shared timer: 4:41 left"');
    expect(markup).not.toContain("aria-live");
  });

  it("starts with a full ring", () => {
    const markup = render({ active: true, done: false, remainingSeconds: 300, endsAtMs: 1_000 });
    expect(markup).toMatch(/stroke-dashoffset="0"/);
  });

  it("says when time is up", () => {
    expect(render({ active: false, done: true, remainingSeconds: 0, endsAtMs: 1_000 })).toContain("Time’s up");
  });
});
