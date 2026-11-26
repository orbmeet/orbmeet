import { mergeProps } from "@base-ui/react/merge-props";
import { Popover as BasePopover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type React from "react";
import type { ComponentProps, ReactNode } from "react";

import { motion } from "../styles/atoms";
import { zIndex } from "../tokens/layers.stylex";

const styles = stylex.create({
  positioner: { zIndex: zIndex.popover },
  popup: {
    pointerEvents: "auto",
  },
});

export const PopoverRoot = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

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
   * Required. `Popover.Popup` is a `role="dialog"`, so every popover needs an
   * accessible name rather than announcing as an unnamed dialog. A caller's
   * own `aria-label` wins over this default.
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
          {...stylex.props(motion.popup, motion.popupAnchored, styles.popup, sx)}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
