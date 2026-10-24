import { PopoverContent, PopoverRoot, PopoverTrigger } from "@orbmeet/ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";

/**
 * Which side of its trigger a toolbar panel opens on. A horizontal toolbar
 * opens panels below it; the vertical palette opens them beside it, so a panel
 * never covers the tools it was opened from.
 */
export const WhiteboardToolbarPopoverSide = createContext<"bottom" | "right">("bottom");

const styles = stylex.create({
  panel: {
    // Base UI measures the room actually left after collision handling, so the
    // panel scrolls at exactly the point it would overflow.
    maxHeight: "var(--available-height)",
    overflowY: "auto",
  },
  /** Each panel declares how wide it wants to be. */
  width: (px: number) => ({ width: px }),
});

/**
 * The anchored surface behind every whiteboard toolbar control that opens a
 * panel — insert menu, style properties, page background, compact "more tools".
 *
 * This was a hand-rolled portal for a long time, and the four things it got
 * wrong are the four things Base UI's Popover exists to get right:
 *
 *   - it clamped to the viewport instead of flipping, so a tall panel opened
 *     near the bottom of a short window rode up over its own trigger;
 *   - it recomputed position on window resize but not on scroll of anything
 *     between the trigger and the viewport;
 *   - Escape returned focus to the trigger but an outside click did not, and
 *     nothing stopped Tab walking out of an open panel into the page behind it;
 *   - every instance announced as the same "Whiteboard tools" dialog.
 *
 * The surface itself is `PopoverContent` from the design system rather than a
 * second copy of it. That copy had drifted into an almost-identical positioner
 * — same `positionMethod`, same `collisionAvoidance`, same transition off the
 * same three Base UI state attributes — while missing the one thing the shared
 * component does that this context actually needs: stopping pointer and click
 * events from reaching the meeting canvas underneath, which runs global drag
 * handlers at that layer. All this file owns now is the controlled open state
 * the toolbar arbitrates, and the panel's own size.
 */
interface WhiteboardToolbarPopoverProps {
  /**
   * Accessible name for the panel. `Popover.Popup` is a `role="dialog"`, so
   * without one a screen reader announces nothing but "dialog" — and these
   * panels are told apart only by what is inside them.
   */
  label: string;
  /**
   * The control that opens the panel. Rendered *as* the trigger rather than
   * beside it, which is what lets Base UI anchor to it and label it.
   * Its own `onClick` is not needed — `onToggle` below is the open path.
   */
  trigger: ReactElement;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  width: number;
  /** The panel surface. `boardPanel.surface` plus, usually, an inset. */
  sx?: StyleXStyles;
  children: ReactNode;
}

/** Breathing room between the trigger and the panel, and from the viewport edge. */
const POPOVER_GAP = 10;
const VIEWPORT_MARGIN = 8;

export function WhiteboardToolbarPopover({
  label,
  trigger,
  isOpen,
  onToggle,
  onClose,
  width,
  sx,
  children,
}: WhiteboardToolbarPopoverProps) {
  const side = useContext(WhiteboardToolbarPopoverSide);
  return (
    <PopoverRoot
      open={isOpen}
      // The toolbar owns "which panel is open" (opening one closes the others
      // and dismisses the AI panel), so opening routes through the existing
      // toggle rather than being answered locally.
      onOpenChange={(open) => {
        if (open) onToggle();
        else onClose();
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent
        title={label}
        side={side}
        align={side === "right" ? "start" : "center"}
        sideOffset={POPOVER_GAP}
        collisionPadding={VIEWPORT_MARGIN}
        sx={[styles.panel, styles.width(width), sx]}
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
  );
}
