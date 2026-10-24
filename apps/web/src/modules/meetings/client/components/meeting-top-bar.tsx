import { BrandMark } from "@orbmeet/ui/react";
import { surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  /**
   * The page itself, not a band laid over it: each zone is its own white
   * pill floating on the room's ground, so the bar reads as a few objects
   * rather than as a strip of chrome.
   *
   * Three zones: who this is, what is on stage, and what you and the room
   * do. The stage switch is centred on the window, not pushed to an edge,
   * because it is the one choice that changes the whole room.
   *
   * The trailing column is `minmax(max-content, 1fr)`, the leading one
   * `minmax(0, 1fr)`: with room to spare both take an equal share and the
   * controls sit dead centre; on a narrow tablet the room's actions keep
   * their full width and the title gives way, so the bar shifts its centre
   * rather than letting two zones overlap.
   */
  bar: {
    // DESKTOP_TOP_BAR_HEIGHT_PX in chrome.ts — the band the stage reserves.
    // StyleX compiles this file statically, so the number is spelled out here
    // and pinned to that constant by meeting-top-bar.test.ts.
    height: 60,
    boxSizing: "border-box",
    paddingTop: space.s2,
    paddingInline: space.s3,
    backgroundColor: surface.canvas,
  },
  /**
   * The bar itself: a white card floating in that band, like every other
   * region of the room, rather than controls printed on the canvas.
   */
  card: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(max-content, 1fr)",
    height: "100%",
    boxSizing: "border-box",
    alignItems: "center",
    columnGap: space.s4,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s2,
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    boxShadow: shadows.card,
  },
  lead: {
    display: "flex",
    minWidth: 0,
    overflow: "hidden",
    alignItems: "center",
    gap: space.s2_5,
  },
  centre: { display: "flex", alignItems: "center" },
  trail: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: space.s2 },
});

/**
 * The Meeting's top bar on tablets and desktops: who and what this meeting is
 * on the left, what is on stage in the middle, your controls and the room's
 * on the right.
 *
 * All of the room's pressable chrome lives in this one band. The bottom of the
 * screen — where the hand holding a tablet rests, and where a palm lands while
 * writing on the board — carries nothing that can be pressed.
 */
export function MeetingTopBar({
  identity,
  controls,
  actions,
}: {
  identity: ReactNode;
  /** What is on stage: Talk, Board or Screen. Omitted for egress/recorder renders. */
  controls?: ReactNode;
  /** Yours — mic, camera, hand — then the room's: timeline, more, leave. Omitted for egress/recorder renders. */
  actions?: ReactNode;
}) {
  return (
    <header {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.lead)}>
          {/* The shared mark, drawn inline: the same one every other surface shows. */}
          <BrandMark size={32} />
          {identity}
        </div>
        <div {...stylex.props(styles.centre)}>{controls}</div>
        <div {...stylex.props(styles.trail)}>{actions}</div>
      </div>
    </header>
  );
}
