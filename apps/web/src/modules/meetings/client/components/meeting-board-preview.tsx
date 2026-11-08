import * as stylex from "@stylexjs/stylex";
import { useState, type ReactNode } from "react";
import { meetingPreviewUrl } from "@/modules/whiteboards/contract/meeting-preview";

const styles = stylex.create({
  image: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
});

/**
 * The picture of a meeting's board, for a row in a list. Falls back to
 * `fallback` for a meeting that has none yet: pictures are drawn when someone
 * who can manage the meeting opens its recap.
 */
export function MeetingBoardPreview({ meetingId, fallback }: { meetingId: string; fallback: ReactNode }) {
  const [missing, setMissing] = useState(false);
  if (missing) return fallback;
  return (
    <img
      src={meetingPreviewUrl(meetingId)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setMissing(true)}
      {...stylex.props(styles.image)}
    />
  );
}
