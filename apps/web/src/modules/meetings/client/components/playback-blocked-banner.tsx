import { pressable, motion } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import * as stylex from "@stylexjs/stylex";
import { Video, Volume2 } from "lucide-react";

import { banner, bannerLayer, bannerTone } from "@/modules/meetings/client/meeting-styles";
import { usePlaybackUnlock } from "@/modules/meetings/client/audio/use-playback-unlock";

const COPY = {
  audio: { title: "Audio is paused", body: "Enable audio to hear everyone in this meeting.", action: "Enable audio" },
  video: { title: "Video is paused", body: "Enable video to see everyone in this meeting.", action: "Enable video" },
} as const;

/**
 * The visible fallback for meeting audio or video the browser blocks.
 *
 * `usePlaybackUnlock` owns the recovery: it retries without a gesture and
 * then arms the next tap anywhere in the meeting, so most people never see this
 * banner even when their browser starts out refusing playback. It shows only
 * when playback is still blocked and nothing has been touched yet.
 */
export function PlaybackBlockedBanner() {
  const { blocked, unlock } = usePlaybackUnlock();

  if (!blocked) return null;
  const copy = COPY[blocked];
  const Glyph = blocked === "audio" ? Volume2 : Video;

  return (
    <div role="alert" {...stylex.props(banner.slot, banner.slotFixed, bannerLayer.aboveCaptions)}>
      <div {...stylex.props(banner.shell, bannerTone.neutralShell, blur.xl)}>
        <div {...stylex.props(banner.row)}>
          <div {...stylex.props(banner.glyph, bannerTone.neutralGlyph)}>
            <Glyph size={16} />
          </div>
          <div {...stylex.props(banner.body)}>
            <div {...stylex.props(banner.title, bannerTone.neutralTitle)}>{copy.title}</div>
            <div {...stylex.props(banner.copy, bannerTone.neutralCopy)}>{copy.body}</div>
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
            {copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
