import { Button, Spinner } from "@orbmeet/ui/react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useEffect, useRef } from "react";
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { getMeetingArtifactDownloadUrl } from "@/modules/meetings/server/history/output-downloads.functions";
import { recordingPlaybackQueryOptions } from "@/app/query-client/queries/artifacts";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  /** Same corner as every other card on the page. */
  card: { borderRadius: radii.card },
  playerBed: { backgroundColor: neutral.n950 },
  failure: {
    display: "flex",
    height: 192,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
  },
  failureCopy: { margin: 0, fontSize: text.sm, color: ink.muted },
  /** The one action left when playback is impossible, so it is the loudest thing in the box. */
  failureDownload: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    backgroundColor: { default: `${glass.veil}`, [env.hoverable]: { default: `${glass.veil}`, ":hover": `color-mix(in oklab, ${surface.raised} 20%, transparent)` } },
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: ink.onDark,
  },
  loading: { display: "flex", height: 192, alignItems: "center", justifyContent: "center" },
  /** The player itself must keep the camera's own shape or the poster letterboxes. */
  player: { aspectRatio: "16 / 9", width: "100%", overflow: "hidden" },
});

interface RecordingPlayerProps {
  /** meeting_artifacts.id for the recording row. */
  artifactId: string;
  filename?: string | null;
}

/** A point to play from: seconds into the recording, and a key that changes with every ask. */
export interface RecordingSeek {
  seconds: number;
  key: number;
}

/**
 * Vidstack player for a meeting recording. The signed playback URL is fetched
 * declaratively by artifact so the player can stream from R2 rather than
 * forcing a download. A download affordance requests an explicit artifact URL
 * (attachment) path.
 */
function downloadRecording(artifactId: string) {
  void getMeetingArtifactDownloadUrl({ data: { artifactId } }).then((res) => {
    // The URL is served as an attachment, so navigating to it downloads
    // without leaving the page. A popup opened after this await has lost
    // the click's user activation and is silently blocked.
    window.location.assign(res.url);
  });
}

/** The "Download" action that sits in the Recording section's header. */
export function RecordingDownloadButton({ artifactId, filename }: RecordingPlayerProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={filename ?? "Download recording"}
      onClick={() => downloadRecording(artifactId)}
    >
      <Download size={14} />
      Download
    </Button>
  );
}

/**
 * The recording itself: a card holding the player. Its heading and download
 * action belong to the page section around it, not to the player.
 */
export function RecordingPlayer({ artifactId, seek }: RecordingPlayerProps & { seek?: RecordingSeek | null }) {
  const playbackQuery = useQuery(recordingPlaybackQueryOptions(artifactId));
  const url = playbackQuery.data?.url;
  const handleDownload = () => downloadRecording(artifactId);
  const player = useRef<MediaPlayerInstance>(null);

  // A key moment picked on the page plays the recording from where it began.
  useEffect(() => {
    const instance = player.current;
    if (!seek || !instance) return;
    instance.currentTime = seek.seconds;
    void instance.play().catch(() => {});
  }, [seek]);

  return (
    // `surfaces.card`, overflow included.
    <div {...stylex.props(surfaces.card, styles.card)}>
      <div {...stylex.props(styles.playerBed)}>
        {playbackQuery.isError ? (
          <div {...stylex.props(styles.failure)}>
            <p {...stylex.props(styles.failureCopy)}>This recording couldn&apos;t be played here.</p>
            <button
              onClick={handleDownload}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.failureDownload)}
            >
              <Download size={13} />
              Download it instead
            </button>
          </div>
        ) : url ? (
          <MediaPlayer
            ref={player}
            key={url}
            title="Meeting recording"
            src={{ src: url, type: "video/mp4" }}
            playsInline
            load="visible"
            posterLoad="visible"
            {...stylex.props(styles.player)}
          >
            <MediaProvider />
            <DefaultVideoLayout icons={defaultLayoutIcons} />
          </MediaPlayer>
        ) : (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="md" brand />
          </div>
        )}
      </div>
    </div>
  );
}
