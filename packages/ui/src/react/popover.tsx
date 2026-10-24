import { mergeProps } from "@base-ui/react/merge-props";
import { Popover as BasePopover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type React from "react";
import type { ComponentProps, ReactNode } from "react";

import { zIndex } from "../tokens/layers.stylex";
import { env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

const styles = stylex.create({
  positioner: { zIndex: zIndex.popover },
  popup: {
    pointerEvents: "auto",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.95, [ENDING]: 0.95 },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: duration.fast,
      ":is([data-instant])": "0s",
      [env.reducedMotion]: "0s",
    },
    transitionTimingFunction: easing.gentle,
  },
});

export const PopoverRoot = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverTitle = BasePopover.Title;

type PopupProps = Omit<
  ComponentProps<typeof BasePopover.Popup>,
  "children" | "title" | "className" | "style"
>;

export function PopoverContent({
  children,
  sx,
  side = "bottom",
  sideOffset = 8,
  align = "center",
  collisionPadding = 12,
  anchor,
  title,
  ...props
}: PopupProps & {
  children: ReactNode;
  sx?: StyleXStyles;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  align?: "start" | "center" | "end";
  /** Clearance kept from the viewport edge when the panel is repositioned. */
  collisionPadding?: number;
  anchor?: React.RefObject<Element | null>;
  /**
   * Required. `Popover.Popup` is a `role="dialog"`, and Base UI names it from a
   * `Popover.Title` that no call site renders — without this every popover
   * announces as an unnamed dialog. Rendering `PopoverTitle` inside the content
   * still wins, since `aria-labelledby` outranks `aria-label`. A caller's own
   * `aria-label` also wins: it is merged over this default, not under it.
   */
  title: string;
}) {
  // mergeProps rather than a plain spread: the two handlers below have to run
  // for every popover, but a caller passing its own `onClick`/`onPointerDown`
  // must not be silently dropped (nor drop these). mergeProps chains them.
  const { onClick, onPointerDown, "aria-label": ariaLabel, ...popupProps } = props;
  const interactionProps = mergeProps<"div">(
    {
      // Prevent pointer/click events from reaching the WebRTC meeting canvas,
      // which has global drag and interaction handlers at that layer.
      onPointerDown: (event) => event.stopPropagation(),
      onClick: (event) => event.stopPropagation(),
    },
    { onClick, onPointerDown },
  );

  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        anchor={anchor}
        positionMethod="fixed"
        collisionPadding={collisionPadding}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        {...stylex.props(styles.positioner)}
      >
        <BasePopover.Popup
          {...popupProps}
          {...interactionProps}
          aria-label={ariaLabel ?? title}
          {...stylex.props(styles.popup, sx)}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
