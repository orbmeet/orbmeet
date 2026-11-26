import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { MeetingVideoTrack } from "../meeting-video-track";
import {
  byLabel,
  chainComparators,
  isLocalParticipant,
  participantLabel,
  preferFlag,
} from "../participant-order";
import { type Participant } from "livekit-client";
import { MicOff } from "lucide-react";
import { layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { Avatar } from "@orbmeet/ui/react";
import { type ParticipantConnection } from "@/modules/meetings/client";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { type VideoTrackRef } from "./tracks";


const styles = stylex.create({
  /** A windowed strip of pin-able participants. */
  railStripVertical: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    gap: space.s2,
    overflowY: "auto",
    padding: space.s2,
  },
  railStripHorizontal: {
    display: "flex",
    width: "100%",
    gap: space.s2,
    overflowX: "auto",
    padding: space.s2,
  },
  stripTile: {
    position: "relative",
    flexShrink: 0,
    overflow: "hidden",
    backgroundColor: neutral.n900,
    boxShadow: `0 0 0 1px ${scrim.edge}`,
    transitionProperty: "box-shadow, transform, opacity, border-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  stripTileVertical: { aspectRatio: "16 / 9", width: "100%" },
  stripTileSquare: { aspectRatio: "1 / 1", height: 80 },
  stripTileFull: { borderRadius: radii.card },
  stripTilePinned: { boxShadow: `0 0 0 1px ${accent.a500}` },
  stripTileHover: {
    boxShadow: { default: null, [env.hoverable]: { default: null, ":hover": `0 0 0 1px color-mix(in oklab, ${accent.a400} 60%, transparent)` } },
  },
  stripAvatarBed: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundImage: `linear-gradient(to bottom right, ${neutral.n100}, ${neutral.n200})`,
  },
  stripAvatar: { boxShadow: `0 0 0 2px color-mix(in oklab, ${surface.raised} 70%, transparent)` },
  stripNameBand: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    backgroundImage: `linear-gradient(to top, ${scrim.heavy}, transparent)`,
    paddingInline: space.s1_5,
    paddingBlock: space.s1,
  },
  stripName: { fontSize: text.xs, fontWeight: weight.medium, color: ink.onDark },
  stripOverflow: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: neutral.n100,
    fontWeight: weight.semibold,
    color: neutral.n600,
    boxShadow: `0 0 0 1px ${scrim.edge}`,
  },
  stripOverflowFull: { borderRadius: radii.card, fontSize: text.sm },
});

// Stable rail/stage ordering: pinned first, then hosts, then the local user,
// then alphabetical. Deliberately NOT score-ordered — the rail must not
// reshuffle every time someone speaks (the stage already follows the speaker).
export function orderParticipants(
  participants: Participant[],
  connectionsById: Map<string, ParticipantConnection>,
  pinnedId: string | null,
): Participant[] {
  // Pinned first, then host, then the local user, then alphabetical.
  return [...participants].sort(
    chainComparators<Participant>(
      preferFlag((p) => p.identity === pinnedId),
      preferFlag((p) => connectionsById.get(p.identity)?.role === "host"),
      preferFlag(isLocalParticipant),
      byLabel(participantLabel),
    ),
  );
}

interface ParticipantRailProps {
  orientation: "vertical" | "horizontal";
  participants: Participant[];
  cameraByIdentity: Map<string, VideoTrackRef>;
  connectionsById: Map<string, ParticipantConnection>;
  /** Already-excluded list is windowed to this many tiles; the rest collapse to "+N". */
  maxTiles: number;
  pinnedId: string | null;
  onTileClick: (identity: string) => void;
}

/**
 * A bounded, windowed strip of participants. Renders at most `maxTiles` and
 * collapses the remainder to a "+N" chip, so it costs the same whether the room
 * has six people or six hundred — the windowing IS the scale story.
 */
export function ParticipantRail({
  orientation,
  participants,
  cameraByIdentity,
  connectionsById,
  maxTiles,
  pinnedId,
  onTileClick,
}: ParticipantRailProps) {
  const ordered = useMemo(
    () => orderParticipants(participants, connectionsById, pinnedId),
    [participants, connectionsById, pinnedId],
  );
  const shown = ordered.slice(0, maxTiles);
  const overflow = ordered.length - shown.length;
  const isVertical = orientation === "vertical";

  if (ordered.length === 0) return null;

  return (
    <div
      {...stylex.props(
        layout.hideScrollbar,
        isVertical ? styles.railStripVertical : styles.railStripHorizontal,
      )}
    >
      {shown.map((p) => {
        const track = cameraByIdentity.get(p.identity);
        const name = p.name || p.identity;
        const pinned = p.identity === pinnedId;
        return (
          <button
            key={p.identity}
            type="button"
            onClick={() => onTileClick(p.identity)}
            title={pinned ? "Unpin" : "Pin to stage"}
            {...stylex.props(
              pressable.base,
              motion.tint,
              styles.stripTile,
              styles.stripTileFull,
              pinned ? styles.stripTilePinned : styles.stripTileHover,
              isVertical ? styles.stripTileVertical : styles.stripTileSquare,
            )}
          >
            {track ? (
              <MeetingVideoTrack
                trackRef={track}
                {...stylex.props(videoTrack.fill, p.isLocal && videoTrack.mirrored)}
              />
            ) : (
              <div {...stylex.props(styles.stripAvatarBed)}>
                <Avatar name={name} size="md" sx={styles.stripAvatar} />
              </div>
            )}
            <div {...stylex.props(styles.stripNameBand)}>
              {!p.isMicrophoneEnabled && (
                <MicOff size={10} strokeWidth={2} color={danger.d300} />
              )}
              <span {...stylex.props(layout.minZero, styles.stripName, layout.truncate)}>
                {name}
                {p.isLocal && " (You)"}
              </span>
            </div>
          </button>
        );
      })}
      {overflow > 0 && (
        <div
          {...stylex.props(
            styles.stripOverflow,
            styles.stripOverflowFull,
            isVertical ? styles.stripTileVertical : styles.stripTileSquare,
          )}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
