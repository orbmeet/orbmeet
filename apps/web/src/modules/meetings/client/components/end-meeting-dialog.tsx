import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@orbmeet/ui/react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { X } from "lucide-react";

const styles = stylex.create({
  body: { position: "relative", paddingTop: space.s6, paddingBottom: space.s4 },
  /** Absolutely placed so the title can use the full width when it wraps. */
  close: {
    position: "absolute",
    right: space.s4,
    top: space.s4,
    display: "flex",
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n800 } },
  },
  /** Room for the close button, so a long title never runs under it. */
  clearsClose: { paddingRight: space.s8 },
  /**
   * Stacked on a phone so "End for all" is not a thumb-width from "Leave", and
   * side by side once there is room to separate them properly.
   */
  footer: {
    display: "flex",
    flexShrink: 0,
    flexDirection: { default: "column", [bp.sm]: "row" },
    justifyContent: { default: "stretch", [bp.sm]: "flex-end" },
    gap: space.s3,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    paddingInline: space.s6,
    paddingBlock: space.s4,
  },
  button: {
    borderRadius: radii.field,
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  leave: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover:not(:disabled)": neutral.n50 } },
    color: neutral.n800,
  },
  /**
   * The destructive one, and the only place in this dialog colour appears:
   * ending a meeting takes it away from everyone still in it.
   */
  endAll: {
    backgroundColor: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover:not(:disabled)": danger.d700 } },
    color: ink.onDark,
  },
  panel: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
  },
  title: { color: ink.strong },
  description: { color: neutral.n600 },
});

interface EndMeetingDialogProps {
  show: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  onLeave?: () => void | Promise<void>;
  pending?: boolean;
  /** Everyone in the room, you included: said in the question, so ending is never a surprise. */
  peopleCount?: number;
}

export function EndMeetingDialog({
  show,
  onCancel,
  onConfirm,
  onLeave,
  pending = false,
  peopleCount,
}: EndMeetingDialogProps) {
  const hasLeaveChoice = Boolean(onLeave);
  const others = peopleCount !== undefined && peopleCount > 1;

  return (
    <Dialog open={show} onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent size="sm" sx={styles.panel}>
        <DialogBody sx={styles.body}>
          <DialogClose
            aria-label="Close"
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.close)}
          >
            <X size={16} aria-hidden="true" />
          </DialogClose>
          <DialogTitle sx={[styles.title, styles.clearsClose]}>
            {hasLeaveChoice
              ? "Leave meeting?"
              : others
                ? `End the meeting for all ${peopleCount} people?`
                : "End the meeting?"}
          </DialogTitle>
          <DialogDescription sx={[styles.description, styles.clearsClose]}>
            {hasLeaveChoice
              ? "You can leave and let others continue, or end the meeting for everyone."
              : "Everyone is disconnected. The board and what was transcribed stay in the meeting’s recap; the chat is deleted."}
          </DialogDescription>
        </DialogBody>
        <div {...stylex.props(styles.footer)}>
          {!onLeave && (
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              {...stylex.props(pressable.base, motion.tint, styles.button, styles.leave)}
            >
              Cancel
            </button>
          )}
          {onLeave && (
            <button
              onClick={() => {
                void onLeave();
              }}
              disabled={pending}
              {...stylex.props(pressable.base, motion.tint, styles.button, styles.leave)}
            >
              Leave meeting
            </button>
          )}
          <button
            onClick={() => {
              void onConfirm();
            }}
            disabled={pending}
            {...stylex.props(pressable.base, motion.tint, styles.button, styles.endAll)}
          >
            {hasLeaveChoice ? "End for all" : "End for everyone"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
