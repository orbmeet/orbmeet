import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import * as stylex from "@stylexjs/stylex";
import { MicOff } from "lucide-react";

import { banner, bannerLayer, bannerTone } from "@/modules/meetings/client/meeting-styles";
import type { MicrophoneInterruptionCause } from "@/modules/meetings/client/audio/microphone-interruption";

/**
 * Says that the microphone the user has on is not reaching anyone.
 *
 * `MicrophoneInterruption` owns the recovery — it restarts the microphone when
 * the system lets go of it and on the next tap anywhere — so this is the
 * explanation, with the restart in reach. Without it the mute control says
 * "on" while nobody hears a word.
 */
export function MicrophoneInterruptedBanner({
  cause,
  onResume,
}: {
  cause: MicrophoneInterruptionCause | null;
  onResume: () => void;
}) {
  if (!cause) return null;

  const body =
    cause === "silent"
      ? "Your microphone stopped sending sound, so nobody can hear you."
      : "Your device paused it, often for a call, so nobody can hear you.";

  return (
    <div role="alert" {...stylex.props(banner.slot, bannerLayer.abovePip)}>
      <div {...stylex.props(banner.shell, bannerTone.dangerShell, blur.xl)}>
        <div {...stylex.props(banner.row)}>
          <div {...stylex.props(banner.glyph, bannerTone.dangerGlyph)}>
            <MicOff size={16} />
          </div>
          <div {...stylex.props(banner.body)}>
            <div {...stylex.props(banner.title, bannerTone.dangerTitle)}>Your microphone stopped</div>
            <div {...stylex.props(banner.copy, bannerTone.dangerCopy)}>{body}</div>
          </div>
          <button
            type="button"
            onClick={onResume}
            {...stylex.props(pressable.base, motion.tint, banner.action, banner.actionPrimary)}
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  );
}
