import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { describe, expect, it } from "vitest";
import { accent, danger, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { classesOf } from "@/test/stylex-markup";
import {
  dockAccessibleName,
  dockItemStyles,
} from "./meeting-control-dock";

/**
 * The declarations the contracts below are about, written as the dock writes
 * them so they compile to the same classes — see `test/stylex-markup.ts`.
 */
const marks = stylex.create({
  hoverTint: {
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n100 },
    },
  },
  dangerHoverTint: {
    backgroundColor: {
      default: danger.d50,
      [env.hoverable]: { default: danger.d50, ":hover": danger.d100 },
    },
  },
  press: { transform: { default: "none", ":active": "scale(0.96)" } },
  offFill: { backgroundColor: danger.d50, color: danger.d600 },
  activeFill: { backgroundColor: accent.a50, color: accent.a700 },
  inert: { cursor: "not-allowed", opacity: 0.4 },
  transparent: { backgroundColor: "transparent" },
});

/** Every class a composed control carries, across all of its styles. */
function classesOfControl(styles: StyleXStyles[]): string[] {
  return styles.flatMap((style) => classesOf(style));
}

function carries(all: string[], style: StyleXStyles): boolean {
  return classesOf(style).every((cls) => all.includes(cls));
}

describe("dockItemStyles", () => {
  it("drops pointer feedback when the control is disabled", () => {
    // Base UI's Toolbar.Button defaults to focusableWhenDisabled, so it renders
    // `aria-disabled` and *no* native `disabled` attribute — CSS :hover and
    // :active keep firing, and a `:not(:disabled)` gate never matches. A
    // greyed-out control that still lights up under the cursor reads as
    // pressable, so the hover tint and the press are composed out in JS.
    const disabled = classesOfControl(dockItemStyles({ disabled: true }));
    expect(carries(disabled, marks.hoverTint)).toBe(false);
    expect(carries(disabled, marks.press)).toBe(false);
    expect(carries(disabled, marks.inert)).toBe(true);
  });

  it("keeps pointer feedback when it is not", () => {
    const enabled = classesOfControl(dockItemStyles({}));
    expect(carries(enabled, marks.hoverTint)).toBe(true);
    expect(carries(enabled, marks.press)).toBe(true);
  });

  it("keeps state colour while disabled, so a muted mic still reads as muted", () => {
    const offAndDisabled = classesOfControl(dockItemStyles({ off: true, disabled: true }));
    expect(carries(offAndDisabled, marks.offFill)).toBe(true);
    expect(carries(offAndDisabled, marks.dangerHoverTint)).toBe(false);
  });

  it("states a resting background in every state", () => {
    // StyleX treats `null` as *remove this property*, so a hover style whose
    // `default` is `null`, composed over a transparent button, strips the
    // transparency instead of leaving it — and what shows through a <button>
    // then is the user agent's ButtonFace grey. The whole dock rendered as a
    // row of grey chips this way. `stylex.props` keeps only the winning class
    // per property, so "some background declaration survived" is exactly the
    // invariant that was broken, and exactly what this asserts.
    const backgroundClasses = new Set([
      ...classesOf(marks.transparent),
      ...classesOf(marks.hoverTint),
      ...classesOf(marks.dangerHoverTint),
      ...classesOf(marks.offFill),
      ...classesOf(marks.activeFill),
    ]);
    const states = [
      {},
      { active: true },
      { off: true },
      { disabled: true },
      { off: true, disabled: true },
      { active: true, disabled: true },
    ];
    for (const state of states) {
      const applied = (stylex.props(...dockItemStyles(state)).className ?? "").split(" ");
      expect(
        applied.some((cls) => backgroundClasses.has(cls)),
        `${JSON.stringify(state)} left background-color unset`,
      ).toBe(true);
    }
  });

  it("gives an active control its accent without a competing hover tint", () => {
    const active = classesOfControl(dockItemStyles({ active: true }));
    expect(carries(active, marks.activeFill)).toBe(true);
    expect(carries(active, marks.hoverTint)).toBe(false);
  });
});

describe("dockAccessibleName", () => {
  it("keeps the visible label inside the name when the tooltip differs", () => {
    // WCAG 2.5.3: saying "Share" out loud has to activate the button that reads
    // "Share", even though its tooltip is phrased as an action.
    expect(dockAccessibleName("Share", "Present your screen")).toBe(
      "Share. Present your screen",
    );
    expect(dockAccessibleName("REC 04:12", "Stop recording")).toBe(
      "REC 04:12. Stop recording",
    );
  });

  it("does not repeat a label the tooltip already contains", () => {
    expect(dockAccessibleName("Whiteboard", "Open whiteboard")).toBe("Open whiteboard");
    expect(dockAccessibleName("Record", "Start recording")).toBe("Start recording");
  });

  it("uses the description alone for icon-only controls", () => {
    expect(dockAccessibleName(null, "Open chat")).toBe("Open chat");
  });
});
