import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { useParticipants } from "@livekit/components-react";
import { MeetingVideoTrack } from "../meeting-video-track";
import { Mic, MicOff, Monitor } from "lucide-react";
import { ambient } from "@orbmeet/ui/styles/animations";
import { layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { blur, surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { stage } from "@orbmeet/ui/tokens/stage.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { Avatar } from "@orbmeet/ui/react";
import { type ParticipantConnection } from "@/modules/meetings/client";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import { useActiveSpeakerStage } from "@/modules/meetings/client/use-active-speaker-stage";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { scrim, scrimBase } from "@orbmeet/ui/tokens/wash.stylex";
import { type VideoTrackRef, useActiveScreenShareTracks, useActiveVideoTracks } from "./tracks";
import { CameraSwitchButton } from "./camera-switch-button";
import { VIDEO_TILE_BASE_SHADOW, useVoiceGlow, voiceHaloBoxShadow } from "./tiles";
import { VideoGrid } from "./video-grid";
import { ParticipantRail, orderParticipants } from "./video-sidebar";
import { shared } from "./shared-styles";

const styles = stylex.create({
  voiceHalo: (boxShadow: string) => ({ boxShadow }),
  /** The spotlight stage: the stage holder plus its rail, either way round. */
  speakerRow: {
    display: "flex",
    height: "100%",
    width: "100%",
    gap: space.s2,
    padding: space.s2,
  },
  /** A phone's stage is full-bleed: the row keeps clear of its header and controls itself. */
  speakerRowPhone: {
    paddingTop: `calc(${stage.top} + 0.5rem)`,
    paddingBottom: `calc(${stage.bottom} + 0.5rem)`,
    paddingLeft: `calc(${stage.left} + 0.5rem)`,
  },
  speakerRowVertical: { flexDirection: "row" },
  speakerRowHorizontal: { flexDirection: "column" },
  speakerStage: {
    position: "relative",
    minHeight: 0,
    minWidth: 0,
    flexGrow: 1,
    overflow: "hidden",
    borderRadius: radii.card,
    backgroundColor: neutral.n900,
  },
  speakerAvatarBed: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundImage: `linear-gradient(to bottom right, ${neutral.n100}, ${neutral.n200})`,
  },
  speakerAvatar: {
    height: 96,
    width: 96,
    boxShadow: `0 0 0 4px ${neutral.n100}, 0 4px 6px -1px ${scrim.edge}, 0 2px 4px -2px ${scrim.edge}`,
  },
  speakerNameChip: {
    position: "absolute",
    bottom: space.s3,
    left: space.s3,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 55%, transparent)`,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
  },
  speakerName: { fontSize: text.sm, fontWeight: weight.medium, color: ink.onDark },
  pinnedChip: {
    position: "absolute",
    left: space.s3,
    top: space.s3,
    borderRadius: radii.control,
    backgroundColor: { default: `color-mix(in oklab, ${neutral.n950} 55%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${neutral.n950} 55%, transparent)`, ":hover": `color-mix(in oklab, ${neutral.n950} 75%, transparent)` } },
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.xs2,
    fontWeight: weight.medium,
    color: ink.onDark,
  },
  speakerRailVertical: { flexShrink: 0, width: { default: 200, [bp.lg]: 240 } },
  speakerRailHorizontal: { flexShrink: 0, height: 96, width: "100%" },
  /**
   * Screen share: a slate stage — the room's darkest neutral, not pure black,
   * so a pillarboxed window does not punch a hole in the light room — with
   * whose screen it is in a bar above it, never over it. The stage already
   * sits inside the room's safe rect: it adds no insets of its own.
   */
  shareStage: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    backgroundColor: neutral.n900,
  },
  sharePresenter: {
    display: "flex",
    minHeight: 44,
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
    fontSize: text.sm,
    color: ink.onDark,
  },
  sharePresenterGlyph: { flexShrink: 0, color: accent.a300 },
  sharePresenterName: { minWidth: 0, flexGrow: 1 },
  sharePresenterSub: { color: neutral.n400 },
  /** Your own screen: the way to stop, where you are looking, not a second press of a tab. */
  shareStop: {
    flexShrink: 0,
    height: 32,
    borderWidth: 0,
    borderRadius: radii.pill,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.onDark,
    backgroundColor: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover": danger.d700 } },
    cursor: "pointer",
  },
  shareArea: {
    display: "flex",
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s2,
    paddingBottom: space.s2,
  },
  shareAreaDesktop: { paddingInline: space.s4, paddingBottom: space.s4 },
  shareContain: { height: "100%", width: "100%", maxWidth: 1800, objectFit: "contain", borderRadius: radii.control },
  /** No screen share yet: the same waiting card, with the share glyph. */
  shareEmptyGlow: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  shareEmptyGlowRing: {
    height: 128,
    width: 128,
    borderRadius: "50%",
    backgroundColor: `color-mix(in oklab, ${accent.a500} 10%, transparent)`,
    filter: "blur(48px)",
  },
  shareEmptyCard: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    borderRadius: radii.card,
    paddingInline: space.s8,
    paddingBlock: space.s12,
    textAlign: "center",
    boxShadow: `0 24px 48px color-mix(in oklab, ${scrimBase.black} 12%, transparent), inset 0 1px 0 color-mix(in oklab, ${surface.raised} 6%, transparent)`,
  },
  shareEmptyGlyph: {
    marginBottom: space.s4,
    display: "flex",
    height: 64,
    width: 64,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.card,
    backgroundImage: `linear-gradient(to bottom right, color-mix(in oklab, ${accent.a500} 20%, transparent), color-mix(in oklab, ${accent.a600} 20%, transparent))`,
    color: accent.a500,
  },
  shareEmptyTitle: { margin: 0, fontSize: text.lg, fontWeight: weight.semibold, color: neutral.n800 },
  shareEmptyBody: { margin: 0, marginTop: space.s2, maxWidth: 320, fontSize: text.sm, color: neutral.n500 },
});

export interface SpeakerStageProps {
  connections?: ParticipantConnection[];
  excludeLocalParticipant?: boolean;
  railOrientation?: "vertical" | "horizontal";
  videoDevices?: MediaDeviceInfo[];
  currentVideoDeviceId?: string;
  onSelectVideoDevice?: (deviceId: string | undefined) => void;
  onRefreshVideoDevices?: () => void;
}

/**
 * Spotlight composition for large meetings: one active-speaker stage plus a
 * windowed rail of everyone else. The stage holder is chosen by the stable
 * {@link useActiveSpeakerStage} engine; tapping any tile pins/unpins it.
 */
export function SpeakerStage({
  connections = [],
  excludeLocalParticipant = false,
  railOrientation = "vertical",
  videoDevices = [],
  currentVideoDeviceId,
  onSelectVideoDevice,
  onRefreshVideoDevices,
}: SpeakerStageProps) {
  const { isPhone } = useResponsive();
  const allParticipants = useParticipants();
  const participants = useMemo(
    () =>
      excludeLocalParticipant
        ? allParticipants.filter((p) => !p.isLocal)
        : allParticipants,
    [allParticipants, excludeLocalParticipant],
  );

  const { stageId, pinnedId, togglePin } = useActiveSpeakerStage(allParticipants);
  const registerVoiceTile = useVoiceGlow(allParticipants, !isPhone);

  const cameraTracks = useActiveVideoTracks({ includeScreenShare: false });
  const cameraByIdentity = useMemo(() => {
    const map = new Map<string, VideoTrackRef>();
    for (const t of cameraTracks) map.set(t.participant.identity, t);
    return map;
  }, [cameraTracks]);

  const connectionsById = useMemo(
    () => new Map(connections.map((p) => [p.identity, p])),
    [connections],
  );

  // Resolve the stage holder to a present participant; fall back to the first
  // in stable order so the stage is never empty before anyone has spoken.
  const ordered = useMemo(
    () => orderParticipants(participants, connectionsById, pinnedId),
    [participants, connectionsById, pinnedId],
  );
  const stageParticipant =
    participants.find((p) => p.identity === stageId) ?? ordered[0] ?? null;
  const railParticipants = useMemo(
    () => participants.filter((p) => p.identity !== stageParticipant?.identity),
    [participants, stageParticipant?.identity],
  );

  if (!stageParticipant) {
    return <VideoGrid connections={connections} excludeLocalParticipant={excludeLocalParticipant} />;
  }

  const stageTrack = cameraByIdentity.get(stageParticipant.identity);
  const stageName = stageParticipant.name || stageParticipant.identity;
  const isVertical = railOrientation === "vertical";
  const railTileCount = isVertical ? 8 : 5;
  const setStageRoot = (el: HTMLDivElement | null) =>
    registerVoiceTile(stageParticipant.identity, el);

  return (
    <div
      {...stylex.props(
        styles.speakerRow,
        isPhone && styles.speakerRowPhone,
        isVertical ? styles.speakerRowVertical : styles.speakerRowHorizontal,
      )}
    >
      <div
        ref={setStageRoot}
        {...stylex.props(
          styles.speakerStage,
          shared.haloTransition,
          styles.voiceHalo(voiceHaloBoxShadow(VIDEO_TILE_BASE_SHADOW)),
        )}
      >
        {stageTrack ? (
          <MeetingVideoTrack
            trackRef={stageTrack}
            {...stylex.props(
              videoTrack.fill,
              stageParticipant.isLocal && videoTrack.mirrored,
            )}
          />
        ) : (
          <div {...stylex.props(styles.speakerAvatarBed)}>
            <Avatar name={stageName} size="xl" sx={styles.speakerAvatar} />
          </div>
        )}

        {stageParticipant.isLocal &&
          stageTrack &&
          onSelectVideoDevice &&
          videoDevices.length > 0 && (
            <div {...stylex.props(shared.cameraCorner)}>
              <CameraSwitchButton
                videoDevices={videoDevices}
                currentDeviceId={currentVideoDeviceId}
                onSelectDevice={onSelectVideoDevice}
                onRefreshDevices={onRefreshVideoDevices}
              />
            </div>
          )}

        <div {...stylex.props(styles.speakerNameChip, blur.sm)}>
          {stageParticipant.isMicrophoneEnabled ? (
            <Mic size={14} color={live.l400} />
          ) : (
            <MicOff size={14} color={danger.d300} />
          )}
          <span {...stylex.props(styles.speakerName)}>
            {stageName}
            {stageParticipant.isLocal && " (You)"}
          </span>
        </div>

        {pinnedId === stageParticipant.identity && (
          <button
            type="button"
            onClick={() => togglePin(stageParticipant.identity)}
            {...stylex.props(pressable.base, motion.tint, styles.pinnedChip, blur.sm)}
          >
            Pinned · tap to unpin
          </button>
        )}
      </div>

      <div
        {...stylex.props(
          isVertical ? styles.speakerRailVertical : styles.speakerRailHorizontal,
        )}
      >
        <ParticipantRail
          orientation={railOrientation}
          participants={railParticipants}
          cameraByIdentity={cameraByIdentity}
          connectionsById={connectionsById}
          maxTiles={isPhone ? railTileCount : 12}
          pinnedId={pinnedId}
          onTileClick={togglePin}
        />
      </div>
    </div>
  );
}

/**
 * A shared screen on the stage, whole, with whose it is in a bar above it.
 * The people are beside it or under it, placed by the room like any content's.
 */
export function ScreenShareStage({
  onStopPresenting,
}: {
  /** Stops presenting; only while the screen on stage is this viewer's own. */
  onStopPresenting?: () => void;
}) {
  const { isPhone } = useResponsive();
  const screenShareTracks = useActiveScreenShareTracks();
  const primaryTrack = screenShareTracks[0];

  if (!primaryTrack) {
    return (
      <div {...stylex.props(shared.emptyStage)}>
        <div>
          <div {...stylex.props(styles.shareEmptyGlow)}>
            <div {...stylex.props(styles.shareEmptyGlowRing, ambient.pulseGlow)} />
          </div>

          <div {...stylex.props(surfaces.glassSolid, styles.shareEmptyCard, blur.xl)}>
            <div {...stylex.props(styles.shareEmptyGlyph)}>
              <Monitor size={32} />
            </div>
            <p {...stylex.props(styles.shareEmptyTitle)}>
              No screen share active
            </p>
            <p {...stylex.props(styles.shareEmptyBody)}>
              Waiting for someone to share their screen.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const presenter = primaryTrack.participant;
  return (
    <div {...stylex.props(styles.shareStage)}>
      <div {...stylex.props(layout.minZero, styles.sharePresenter)}>
        <Monitor size={16} aria-hidden="true" {...stylex.props(styles.sharePresenterGlyph)} />
        <p {...stylex.props(layout.truncate, styles.sharePresenterName)}>
          <b>{presenter.isLocal ? "You" : presenter.name || presenter.identity}</b>{" "}
          <span {...stylex.props(styles.sharePresenterSub)}>{presenter.isLocal ? "are presenting" : "is presenting"}</span>
        </p>
        {presenter.isLocal && onStopPresenting && (
          <button
            type="button"
            onClick={onStopPresenting}
            {...stylex.props(pressable.base, motion.tint, styles.shareStop)}
          >
            Stop presenting
          </button>
        )}
      </div>

      <div {...stylex.props(styles.shareArea, !isPhone && styles.shareAreaDesktop)}>
        <MeetingVideoTrack trackRef={primaryTrack} {...stylex.props(styles.shareContain)} />
      </div>
    </div>
  );
}
