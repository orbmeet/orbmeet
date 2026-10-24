import { safe } from "@orbmeet/ui/styles/atoms";
import { onBoard, stageChrome } from "@orbmeet/ui/styles/stage";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import * as React from "react";

import { selectMeetingChromeInsets } from "@/modules/meetings/client/chrome";

const styles = stylex.create({
  shell: { position: "relative", height: "100dvh", overflow: "hidden" },
  /** Header band. The band itself is inert; only the header inside it is not. */
  headerBand: {
    position: "absolute",
    insetInline: 0,
    top: 0,
    zIndex: zIndex.meetingBar,
    pointerEvents: "none",
  },
  interactive: { pointerEvents: "auto" },
  inert: { pointerEvents: "none" },
  /**
   * The dock band spans the *board*, not the window: the dock centres itself
   * inside this box, so a docked participant rail moves the box rather than
   * leaving the dock off-centre beside it.
   */
  dockBand: {
    position: "absolute",
    bottom: 0,
    zIndex: zIndex.meetingDock,
    pointerEvents: "none",
    transitionProperty: "opacity, translate",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
  },
  /** A phone on its side: the controls rail down the right edge, in the width reserved for a panel. */
  railBand: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: zIndex.meetingDock,
  },
  railWidth: (width: string) => ({ width }),
  dockShown: { translate: "0 0", opacity: 1 },
  dockHidden: { translate: "0 1rem", opacity: 0 },
});

/** The phone's dock or landscape rail, for a sheet that stands beside it and must not take its presses. */
export const MEETING_DOCK_SELECTOR = "[data-meeting-dock]";

export interface MeetingShellProps {
  /** Phone chrome: slim header, bottom dock. Otherwise the desktop top bar. */
  isPhone: boolean;
  /** Top chrome. Omitted for egress/recorder renders. */
  header?: React.ReactNode;
  /**
   * Bottom chrome. Phones only — larger viewports put controls in the header.
   * Pass `undefined` while a bottom sheet owns the screen so the stage reclaims
   * the band instead of holding a gap nothing is covering.
   */
  dock?: React.ReactNode;
  /**
   * Keeps the dock mounted for state/animation while allowing a landscape call
   * to reclaim its stage inset when controls auto-hide.
   */
  dockVisible?: boolean;
  /** A phone header with its Talk | Board row: the stage starts under both. */
  hasModeSwitch?: boolean;
  /**
   * A phone on its side: its controls as a rail down the right edge, in
   * place of a header and a dock. It stands in `panelWidth`, which the stage
   * already stops short of.
   */
  rail?: React.ReactNode;
  /**
   * Width reserved on the right for a docked side panel (chat, participants,
   * hand raises, search), gutters included, as a CSS length. Published as
   * `stage.panel`, so the gallery and the control dock both stop at the panel
   * instead of being covered by it. `"0px"` when none is open — which is
   * always the case on a phone, where these are bottom sheets.
   */
  panelWidth?: string;
  /** The stage: video, screen share, or an extension surface. */
  children: React.ReactNode;
  sx?: StyleXStyles;
  /** The Meeting's media scope — camera/mic permission prompts anchor to it. */
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * The Meeting's layout frame.
 *
 * The Meeting is one full-bleed stage with chrome floating over it. Two ideas keep
 * it honest on a notched phone:
 *
 * 1. **Pixels may bleed; affordances may not.** Video fills the screen corner
 *    to corner — letterboxing a phone to dodge the notch wastes the screen. But
 *    everything that carries meaning (names, mute badges, buttons)
 *    lives inside the safe rect. That rect is published as four CSS variables:
 *
 *      stage.top     safe-area top    + mounted header
 *      stage.right   safe-area right
 *      stage.bottom  safe-area bottom + mounted dock
 *      stage.left    safe-area left
 *
 *    plus `board.right` / `board.left`, the same rect minus a docked
 *    participant column, for chrome that must read as centred on the board.
 *    See `@orbmeet/ui/tokens/stage.stylex`.
 *
 * 2. **The geometry is computed once, here.** Nothing below this component
 *    calls `env(safe-area-inset-*)` or hardcodes a chrome height. Surfaces
 *    position against the `inStage` / `onBoard` style helpers,
 *    so a tile label and the dock covering it can no longer disagree about
 *    where the bottom of the screen is. That disagreement is what put names
 *    under the Dynamic Island and controls off the edge of the display.
 *
 * The variables are CSS, not React state, so rotation and browser-chrome
 * changes reflow without a re-render.
 */
export function MeetingShell({
  isPhone,
  header,
  dock,
  dockVisible = true,
  hasModeSwitch = false,
  rail,
  panelWidth = "0px",
  children,
  sx,
  ref,
}: MeetingShellProps) {
  const chrome = selectMeetingChromeInsets({
    isPhone,
    hasDock: Boolean(dock) && dockVisible,
    hasHeader: Boolean(header),
    hasModeSwitch,
  });

  return (
    <div
      ref={ref}
      {...stylex.props(
        styles.shell,
        stageChrome.publish(
          `${chrome.top}px`,
          `${chrome.bottom}px`,
          // Nothing docks against the stage's right any more: a panel is
          // reserved through `panelWidth`, the faces beside content with it.
          "0px",
          panelWidth,
        ),
        sx,
      )}
    >
      {/* Stage — deliberately full-bleed. Its contents inset themselves. */}
      {children}

      {header && (
        <div {...stylex.props(styles.headerBand, safe.padTop, safe.padX)}>
          <div {...stylex.props(styles.interactive)}>{header}</div>
        </div>
      )}

      {rail && (
        <div
          // A sheet beside the rail leaves it usable, as one on the dock does.
          data-meeting-dock=""
          {...stylex.props(
            styles.railBand,
            styles.railWidth(`calc(${panelWidth} + env(safe-area-inset-right, 0px))`),
            safe.padTop,
            safe.padBottom,
            safe.padRight,
          )}
        >
          {rail}
        </div>
      )}

      {dock && (
        <div
          aria-hidden={!dockVisible}
          // A sheet that stands on the dock leaves it usable: see MEETING_DOCK_SELECTOR.
          data-meeting-dock=""
          {...stylex.props(
            styles.dockBand,
            onBoard.spanX,
            safe.padBottom,
            dockVisible ? styles.dockShown : styles.dockHidden,
          )}
        >
          <div {...stylex.props(dockVisible ? styles.interactive : styles.inert)}>{dock}</div>
        </div>
      )}
    </div>
  );
}
