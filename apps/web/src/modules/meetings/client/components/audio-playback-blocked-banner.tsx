import { pressable, motion } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import * as stylex from "@stylexjs/stylex";
import { Volume2 } from "lucide-react";

import { banner, bannerLayer, bannerTone } from "@/modules/meetings/client/meeting-styles";
import { useAudioPlaybackUnlock } from "@/modules/meetings/client/audio/use-audio-playback-unlock";

/**
 * The visible fallback for browser-blocked meeting audio.
 *
 * `useAudioPlaybackUnlock` owns the recovery: it retries without a gesture and
 * then arms the next tap anywhere in the meeting, so most people never see this
 * banner even when their browser starts out refusing playback. It shows only
 * when playback is still blocked and nothing has been touched yet.
 */
export function AudioPlaybackBlockedBanner() {
  const { blocked, unlock } = useAudioPlaybackUnlock();

  if (!blocked) return null;

  return (
    <div role="alert" {...stylex.props(banner.slot, banner.slotFixed, bannerLayer.aboveCaptions)}>
      <div {...stylex.props(banner.shell, bannerTone.neutralShell, blur.xl)}>
        <div {...stylex.props(banner.row)}>
          <div {...stylex.props(banner.glyph, bannerTone.neutralGlyph)}>
            <Volume2 size={16} />
          </div>
          <div {...stylex.props(banner.body)}>
            <div {...stylex.props(banner.title, bannerTone.neutralTitle)}>Audio is paused</div>
            <div {...stylex.props(banner.copy, bannerTone.neutralCopy)}>
              Enable audio to hear everyone in this meeting.
            </div>
          </div>
          <button
            type="button"
            onClick={unlock}
            {...stylex.props(
              pressable.base,
              motion.tint,
              banner.action,
              banner.actionPrimary,
            )}
          >
            Enable audio
          </button>
        </div>
      </div>
    </div>
  );
}
