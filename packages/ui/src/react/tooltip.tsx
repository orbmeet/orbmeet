import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement, ReactNode } from "react";

import { ink, neutral } from "../tokens/colors.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { scrim } from "../tokens/wash.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

const styles = stylex.create({
  positioner: { zIndex: zIndex.tooltip },
  popup: {
    pointerEvents: "none",
    maxWidth: 192,
    borderRadius: radii.field,
    backgroundColor: neutral.n900,
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
    textAlign: "center",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: ink.onDark,
    boxShadow: `0 10px 15px -3px ${scrim.edge}, 0 4px 6px -4px ${scrim.edge}`,
    // Base UI publishes the anchor-relative origin so the tooltip grows out of
    // the control it describes rather than out of its own centre.
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.9, [ENDING]: 0.9 },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: duration.fast,
      // `data-instant` marks a tooltip re-opening within the group's delay
      // window; it should appear immediately rather than replay the entrance.
      ":is([data-instant])": "0s",
      [env.reducedMotion]: "0s",
    },
    transitionTimingFunction: easing.gentle,
  },
});

interface TooltipProps {
  content: string;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider>{children}</BaseTooltip.Provider>;
}

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      {/* No styles of its own: whatever `children` is keeps its own display and
          layout. A hardcoded `inline-flex` here landed alongside the child's own
          `flex` on every dock button, leaving which one applied up to emit order. */}
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side={side}
          sideOffset={10}
          positionMethod="fixed"
          collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          {...stylex.props(styles.positioner)}
        >
          <BaseTooltip.Popup {...stylex.props(styles.popup)}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
