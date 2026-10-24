import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import * as stylex from "@stylexjs/stylex";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";

import { banner, bannerLayer, bannerTone } from "@/modules/meetings/client/meeting-styles";

export function ParticipantPermissionBanner({
  state,
  isPreparing,
  hasPrepared,
  hasPermission,
  onCancel,
  onDismiss,
}: {
  state: "idle" | "pending" | "denied" | "approved";
  isPreparing: boolean;
  hasPrepared: boolean;
  hasPermission: boolean;
  /** Withdraw the request, or give back a grant whose share has not started. */
  onCancel: () => void;
  /** Hide a denial. Nothing is sent. */
  onDismiss: () => void;
}) {
  if (state === "idle") return null;
  // The grant lasts as long as the share it allowed. Once that share is
  // published there is nothing left to announce, and nothing on this banner
  // may end it.
  if (state === "approved" && !hasPrepared) return null;

  const tone =
    state === "denied"
      ? {
          shell: bannerTone.dangerShell,
          glyph: bannerTone.dangerGlyph,
          title: bannerTone.dangerTitle,
          body: bannerTone.dangerCopy,
        }
      : state === "approved"
        ? {
            shell: bannerTone.liveShell,
            glyph: bannerTone.liveGlyph,
            title: bannerTone.liveTitle,
            body: bannerTone.liveCopy,
          }
        : {
            shell: bannerTone.neutralShell,
            glyph: bannerTone.neutralGlyph,
            title: bannerTone.neutralTitle,
            body: bannerTone.neutralCopy,
          };

  const copy =
    state === "pending"
      ? {
          icon: Clock3,
          title: isPreparing ? "Choose what to share" : "Waiting for approval",
          body: isPreparing
            ? "Pick a window or tab. We'll send the request as soon as your selection is ready."
            : hasPrepared
              ? "Your host will review the screen-share request."
              : "Preparing your screen-share request.",
          action: "Cancel",
        }
      : state === "approved"
        ? {
            icon: CheckCircle2,
            title: "Screen share approved",
            body: hasPermission
              ? "Starting your share now."
              : "Approval arrived. Syncing permission to your browser.",
            action: "Cancel",
          }
        : {
            icon: XCircle,
            title: "Screen share denied",
            body: "The host declined this request. You can try again later.",
            action: "Dismiss",
          };

  const Icon = copy.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      {...stylex.props(banner.slot, bannerLayer.abovePip)}
    >
      <div {...stylex.props(banner.shell, tone.shell, blur.xl)}>
        <div {...stylex.props(banner.row, banner.rowTop)}>
          <div {...stylex.props(banner.glyph, tone.glyph)}>
            <Icon size={16} />
          </div>
          <div {...stylex.props(banner.body)}>
            <div {...stylex.props(banner.title, tone.title)}>{copy.title}</div>
            <div {...stylex.props(banner.copy, tone.body)}>{copy.body}</div>
          </div>
          <button
            type="button"
            onClick={state === "denied" ? onDismiss : onCancel}
            {...stylex.props(pressable.base, motion.tint, banner.action)}
          >
            {copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
