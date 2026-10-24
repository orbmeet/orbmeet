import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type TrackReference, useParticipants } from "@livekit/components-react";
import {
  byLabel,
  chainComparators,
  deferFlag,
  isLocalParticipant,
  isLocalTrack,
  isScreenShareTrack,
  participantLabel,
  preferFlag,
  trackLabel,
} from "../participant-order";
import { type Participant } from "livekit-client";
import { Users } from "lucide-react";
import { blur, glow } from "@orbmeet/ui/styles/surfaces";
import { accent, decor, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { stage } from "@orbmeet/ui/tokens/stage.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { type ParticipantConnection } from "@/modules/meetings/client";
import { fitGallery, getPhoneGridLayout } from "@/modules/meetings/client/gallery-fit";
import { useResponsive } from "@/lib/hooks/use-responsive";
import {
  ALONE_STRIP_GAP_PX,
  ALONE_STRIP_HEIGHT_PX,
  MeetingAloneStrip,
} from "@/modules/meetings/client/components/meeting-alone-strip";
import { glass, scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { getTrackRenderKey, useActiveVideoTracks } from "./tracks";
import { GridAvatarTile, ParticipantVideoTile, useVoiceGlow } from "./tiles";
import { TileHandBadge } from "./hand-badge";
import { shared } from "./shared-styles";

const styles = stylex.create({
  /** The phone gallery lives inside the shell's stage rect, never edge to edge. */
  phoneStage: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.canvas,
    paddingTop: `calc(${stage.top} + 0.25rem)`,
    paddingBottom: `calc(${stage.bottom} + 0.25rem)`,
    paddingLeft: `calc(${stage.left} + 0.25rem)`,
    paddingRight: `calc(${stage.right} + 0.25rem)`,
  },
  /** Desktop tiles clear the identity band and the control dock the same way. */
  desktopStage: {
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s6,
    paddingTop: `calc(${stage.top} + 0.75rem)`,
    paddingBottom: `calc(${stage.bottom} + 0.75rem)`,
  },
  /** Under an upright board: the box is already clear of the room's chrome. */
  embeddedStage: { alignItems: "center", justifyContent: "center", padding: space.s3 },
  stageHolder: { display: "flex", height: "100%" },
  /** Alone: your tile and the line under it, centred as one group. */
  // 12 is ALONE_STRIP_GAP_PX; StyleX compiles this statically, so it is
  // spelled out here, and the fit below subtracts the same constant.
  aloneColumn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12 },
  /** The measured box: no padding of its own, so the fit divides real space. */
  measureBox: {
    display: "flex",
    height: "100%",
    width: "100%",
    minHeight: 0,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  fitted: {
    display: "flex",
    flexWrap: "wrap",
    alignContent: "center",
    alignItems: "center",
    justifyContent: "center",
    transitionProperty: "opacity",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  grid: {
    display: "grid",
    width: "100%",
    transitionProperty: "opacity, transform, box-shadow, border-color",
    transitionDuration: { default: "300ms", [env.reducedMotion]: "0s" },
  },
  // minmax(0, …): a bare 1fr row will not shrink below its tile's content, so
  // two people on a phone got unequal rows and the lower one ran under the dock.
  gridPhone: { height: "100%", gridAutoRows: "minmax(0, 1fr)" },
  phoneGrid: (columns: number, gap: number) => ({
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap,
  }),
  fittedSize: (gap: number, maxWidth: number) => ({ gap, maxWidth }),
  /** The observer reports after the first paint; fade in over that one frame. */
  awaitingMeasurement: { opacity: 0 },
  tileSlot: { position: "relative", height: "100%" },
  tileSize: (width: number, height: number) => ({ width, height }),
  tileSlotWide: { gridColumn: "span 2" },
  /**
   * Your own picture over the other person's, in the corner a calling app puts
   * it: two people on an upright phone used to be two equal halves, half the
   * screen spent on your own face.
   */
  selfPip: {
    position: "absolute",
    right: `calc(${stage.right} + 0.75rem)`,
    bottom: `calc(${stage.bottom} + 0.75rem)`,
    zIndex: zIndex.meetingPanel,
    width: "30%",
    maxWidth: 132,
    aspectRatio: "3 / 4",
    borderRadius: radii.card,
    boxShadow: shadows.lift3,
  },
  emptyCard: {
    position: "relative",
    overflow: "hidden",
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: glass.sheer,
    backgroundImage:
      `linear-gradient(135deg, color-mix(in oklab, ${surface.raised} 82%, transparent) 0%, color-mix(in oklab, ${decor.paperWarm} 75%, transparent) 100%)`,
    paddingInline: space.s10,
    paddingBlock: space.s12,
    textAlign: "center",
    boxShadow: `0 25px 50px -12px ${scrim.soft}`,
  },
  emptyOrb: {
    top: `calc(-1 * ${space.s8})`,
    right: `calc(-1 * ${space.s8})`,
    width: space.s32,
    height: space.s32,
  },
  emptyGlyph: {
    marginBottom: space.s5,
    display: "flex",
    height: 64,
    width: 64,
    marginInline: "auto",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.card,
    backgroundImage:
      `linear-gradient(135deg, color-mix(in oklab, ${accent.a500} 15%, transparent) 0%, color-mix(in oklab, ${accent.a600} 8%, transparent) 100%)`,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    boxShadow: `0 4px 20px -4px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    color: accent.a600,
  },
  emptyTitle: { margin: 0, fontSize: text.base, fontWeight: weight.semibold, color: neutral.n800 },
  emptyBody: { margin: 0, marginTop: space.s2, maxWidth: 320, fontSize: text.sm, color: neutral.n500 },
});

export interface VideoGridProps {
  connections?: ParticipantConnection[];
  includeScreenShare?: boolean;
  excludeLocalParticipant?: boolean;
  videoDevices?: MediaDeviceInfo[];
  currentVideoDeviceId?: string;
  onSelectVideoDevice?: (deviceId: string | undefined) => void;
  onRefreshVideoDevices?: () => void;
  /**
   * The room's join code. Supplying it lets the gallery offer an invitation
   * while the viewer is the only person here; without it the grid simply shows
   * whoever is present.
   */
  meetingCode?: string;
  /**
   * In a box of its own — the people under an upright board — rather than
   * filling the stage: plain padding instead of the stage's chrome insets.
   */
  embedded?: boolean;
  /** A moderator's actions on someone else's tile, by their identity. */
  renderTileActions?: (identity: string) => ReactNode;
}

export function VideoGrid({
  connections = [],
  includeScreenShare = true,
  excludeLocalParticipant = false,
  videoDevices = [],
  currentVideoDeviceId,
  onSelectVideoDevice,
  onRefreshVideoDevices,
  meetingCode,
  embedded = false,
  renderTileActions,
}: VideoGridProps) {
  // Tablets fit their tiles the same way desktops do — the measurement makes
  // the distinction moot, which is why `isTablet` is no longer consulted here.
  const { isPhone, isLandscape } = useResponsive();
  const rawActiveTracks = useActiveVideoTracks({ includeScreenShare });
  const allParticipants = useParticipants();
  const activeTracks = useMemo(
    () =>
      excludeLocalParticipant
        ? rawActiveTracks.filter((track) => !track.participant.isLocal)
        : rawActiveTracks,
    [excludeLocalParticipant, rawActiveTracks],
  );

  const videoIdentities = useMemo(
    () => new Set(activeTracks.map((t) => t.participant.identity)),
    [activeTracks],
  );

  const connectionsById = useMemo(
    () => new Map(connections.map((p) => [p.identity, p])),
    [connections],
  );

  const avatarParticipants = useMemo(
    () =>
      allParticipants
        .filter((p) => !excludeLocalParticipant || !p.isLocal)
        .filter((p) => !videoIdentities.has(p.identity))
        // Host first, then the local user, then alphabetical.
        .sort(
          chainComparators<Participant>(
            preferFlag((p) => connectionsById.get(p.identity)?.role === "host"),
            preferFlag(isLocalParticipant),
            byLabel(participantLabel),
          ),
        ),
    [allParticipants, excludeLocalParticipant, videoIdentities, connectionsById],
  );

  // On phone with many remotes, show a deterministic window + ourselves.
  // Speaking state decorates tiles, but never reorders or replaces them.
  const mobileVisibleIds = useMemo(() => {
    if (!isPhone) return null;

    const remotes = allParticipants.filter((p) => !p.isLocal);
    const maxTotal = isLandscape ? 6 : 4;
    const maxRemotes = excludeLocalParticipant ? maxTotal : maxTotal - 1;
    const totalGridCount = excludeLocalParticipant ? remotes.length : allParticipants.length;

    if (totalGridCount <= maxTotal) return null;

    // Host first, then alphabetical (local user is appended separately below).
    const sorted = [...remotes].sort(
      chainComparators<Participant>(
        preferFlag((p) => connectionsById.get(p.identity)?.role === "host"),
        byLabel(participantLabel),
      ),
    );

    const newIds = sorted.slice(0, maxRemotes).map((p) => p.identity);
    if (!excludeLocalParticipant) {
      const localUser = allParticipants.find((p) => p.isLocal);
      if (localUser) {
        newIds.push(localUser.identity);
      }
    }

    return new Set(newIds);
  }, [isPhone, excludeLocalParticipant, allParticipants, connectionsById, isLandscape]);

  const rawGridTracks = useMemo(() => {
    let tracks = activeTracks;
    if (mobileVisibleIds) {
      tracks = tracks.filter((t) => mobileVisibleIds.has(t.participant.identity));
    }
    return tracks;
  }, [activeTracks, mobileVisibleIds]);

  const gridTracks = useMemo(() => {
    if (!isPhone) return rawGridTracks;
    // Sort on mobile: screen share first, then stable remotes (host-first),
    // then the local user last.
    return [...rawGridTracks].sort(
      chainComparators<TrackReference>(
        preferFlag(isScreenShareTrack),
        deferFlag(isLocalTrack),
        preferFlag((t) => connectionsById.get(t.participant.identity)?.role === "host"),
        byLabel(trackLabel),
      ),
    );
  }, [isPhone, rawGridTracks, connectionsById]);

  const rawGridAvatars = useMemo(() => {
    let avatars = avatarParticipants;
    if (mobileVisibleIds) {
      avatars = avatars.filter((p) => mobileVisibleIds.has(p.identity));
    }
    return avatars;
  }, [avatarParticipants, mobileVisibleIds]);

  const gridAvatars = useMemo(() => {
    if (!isPhone) return rawGridAvatars;
    // Sort on mobile: stable remotes first (host-first), then local user last.
    return [...rawGridAvatars].sort(
      chainComparators<Participant>(
        deferFlag(isLocalParticipant),
        preferFlag((p) => connectionsById.get(p.identity)?.role === "host"),
        byLabel(participantLabel),
      ),
    );
  }, [isPhone, rawGridAvatars, connectionsById]);

  // Alone in the room: one tile, and the link in a line under it. Not for an
  // egress recorder, which is "alone" by construction and has nobody to invite.
  const alone =
    !!meetingCode && !excludeLocalParticipant && allParticipants.length <= 1;
  const gridTileCount = gridTracks.length + gridAvatars.length;
  const hasGridTiles = gridTileCount > 0;

  const registerVoiceTile = useVoiceGlow(allParticipants, !isPhone);

  // Phones fill the stage with tiles. Everywhere else the tiles are fitted to
  // the space that exists, which means measuring it: a column count picked from
  // the participant count alone cannot know whether it is being poured into an
  // ultrawide or a half-width window (see `gallery-fit`).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = stageRef.current;
    if (isPhone || !element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setStageSize((previous) =>
        // Round before comparing: sub-pixel jitter from the browser would
        // otherwise re-fit (and re-render) the whole gallery continuously.
        Math.round(previous.width) === Math.round(width) &&
        Math.round(previous.height) === Math.round(height)
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  // The measured stage is not mounted for the empty-state render. Re-run when
  // the gallery crosses that lifecycle boundary so a recorder whose remote
  // participant list arrives one frame later attaches its observer to the new
  // stage instead of leaving every tile hidden awaiting a measurement.
  }, [hasGridTiles, isPhone]);

  // Two people on an upright phone: the other person fills the stage, and you
  // are a picture in its corner.
  const selfInCorner =
    isPhone && !isLandscape && !embedded && !excludeLocalParticipant && gridTileCount === 2 &&
    allParticipants.some((participant) => participant.isLocal);
  const stageTracks = selfInCorner ? gridTracks.filter((track) => !track.participant.isLocal) : gridTracks;
  const stageAvatars = selfInCorner ? gridAvatars.filter((participant) => !participant.isLocal) : gridAvatars;
  const cornerTrack = selfInCorner ? gridTracks.find((track) => track.participant.isLocal) : undefined;
  const cornerAvatar = selfInCorner && !cornerTrack ? gridAvatars.find((participant) => participant.isLocal) : undefined;

  const galleryGap = gridTileCount > 9 ? 12 : 16;
  const galleryFit =
    isPhone || stageSize.width === 0
      ? null
      : alone
        ? fitAloneTile(stageSize.width, stageSize.height - ALONE_STRIP_HEIGHT_PX - ALONE_STRIP_GAP_PX)
        : fitGallery({
            count: gridTileCount,
            width: stageSize.width,
            height: stageSize.height,
            gap: galleryGap,
          });
  // The observer reports after the first paint, so there is exactly one frame
  // where a fitted gallery has no measurement yet. It fades in over that frame
  // rather than painting a pile of zero-sized tiles.
  const awaitingMeasurement = !isPhone && !galleryFit;
  const phoneGrid = getPhoneGridLayout(stageTracks.length + stageAvatars.length, isLandscape);

  if (!hasGridTiles) {
    return (
      <div {...stylex.props(shared.emptyStage)}>
        <div {...stylex.props(styles.emptyCard, blur.xl)}>
          {/* Tiny decorative orb */}
          <div
            {...stylex.props(
              glow.orb(`color-mix(in oklab, ${accent.a500} 15%, transparent)`, 20),
              styles.emptyOrb,
            )}
          />
          <div {...stylex.props(styles.emptyGlyph)}>
            <Users size={32} />
          </div>
          <p {...stylex.props(styles.emptyTitle)}>
            Waiting for participants
          </p>
          <p {...stylex.props(styles.emptyBody)}>
            They&rsquo;ll appear here when they join.
          </p>
        </div>
      </div>
    );
  }

  const use3TileSpan = gridTileCount === 3 && isPhone && !isLandscape;

  const trackTile = (track: TrackReference, clearsCorner = false) => (
    <>
      <ParticipantVideoTile
        track={track}
        identity={track.participant.identity}
        participantName={track.participant.name || track.participant.identity}
        isSpeaking={track.participant.isSpeaking}
        isLocal={track.participant.isLocal}
        isMicrophoneEnabled={track.participant.isMicrophoneEnabled}
        isPhone={isPhone}
        registerVoiceTile={registerVoiceTile}
        videoDevices={videoDevices}
        currentVideoDeviceId={currentVideoDeviceId}
        onSelectVideoDevice={onSelectVideoDevice}
        onRefreshVideoDevices={onRefreshVideoDevices}
        actions={track.participant.isLocal ? undefined : renderTileActions?.(track.participant.identity)}
        clearsCorner={clearsCorner}
      />
      {!isScreenShareTrack(track) && <TileHandBadge participant={track.participant} compact={isPhone} />}
    </>
  );
  const avatarTile = (p: Participant) => (
    <>
      <GridAvatarTile
        identity={p.identity}
        name={p.name || ""}
        isLocal={p.isLocal}
        isSpeaking={p.isSpeaking}
        isMicrophoneEnabled={p.isMicrophoneEnabled}
        isPhone={isPhone}
        registerVoiceTile={registerVoiceTile}
        tileHeight={galleryFit?.tileHeight ?? 0}
        actions={p.isLocal ? undefined : renderTileActions?.(p.identity)}
      />
      <TileHandBadge participant={p} compact={isPhone} />
    </>
  );

  const grid = (
    <div
      {...stylex.props(
        galleryFit || awaitingMeasurement ? styles.fitted : styles.grid,
        awaitingMeasurement && styles.awaitingMeasurement,
        isPhone && styles.gridPhone,
        !galleryFit && !awaitingMeasurement &&
          styles.phoneGrid(phoneGrid.columns, phoneGrid.gap),
        galleryFit && styles.fittedSize(
          galleryGap,
          galleryFit.columns * galleryFit.tileWidth +
            (galleryFit.columns - 1) * galleryGap,
        ),
      )}
    >
      {stageTracks.map((track, idx) => (
        <div
          key={getTrackRenderKey(track)}
          {...stylex.props(
            styles.tileSlot,
            galleryFit && styles.tileSize(galleryFit.tileWidth, galleryFit.tileHeight),
            use3TileSpan && idx === 0 && styles.tileSlotWide,
          )}
        >
          {trackTile(track, selfInCorner)}
        </div>
      ))}

      {stageAvatars.map((p, idx) => (
        <div
          key={p.identity}
          {...stylex.props(
            styles.tileSlot,
            galleryFit && styles.tileSize(galleryFit.tileWidth, galleryFit.tileHeight),
            use3TileSpan && stageTracks.length + idx === 0 && styles.tileSlotWide,
          )}
        >
          {avatarTile(p)}
        </div>
      ))}

    </div>
  );

  return (
    // The phone grid lives inside the shell's stage rect rather than bleeding
    // to the display edge. Full-bleed video reads well until a tile's name
    // badge lands under the Dynamic Island or its mute badge runs off the
    // side — which is exactly what happened. Inset tiles are also what every
    // native calling app does, so the result looks deliberate rather than
    // clipped. The extra 0.25rem keeps tiles off the safe boundary itself.
    <div
      {...stylex.props(
        styles.stageHolder,
        embedded ? styles.embeddedStage : isPhone ? styles.phoneStage : styles.desktopStage,
      )}
    >
      {/* The measured box, deliberately without padding of its own: the fit
          divides up the space the tiles actually get, and measuring the padded
          parent instead would hand it 48px it is not allowed to use. */}
      <div ref={stageRef} {...stylex.props(styles.measureBox)}>
        {alone ? (
          <div {...stylex.props(styles.aloneColumn)}>
            {grid}
            <MeetingAloneStrip widthPx={galleryFit ? galleryFit.tileWidth : undefined} />
          </div>
        ) : (
          grid
        )}
      </div>
      {(cornerTrack || cornerAvatar) && (
        <div {...stylex.props(styles.selfPip)}>
          {cornerTrack ? trackTile(cornerTrack) : cornerAvatar && avatarTile(cornerAvatar)}
        </div>
      )}
    </div>
  );
}

/**
 * Alone, the tile is the camera's own 16:9, as large as the stage allows. It
 * used to stop at 880px, which left a 1440px window 60% empty around one
 * small tile; the stage is there to be used.
 */
function fitAloneTile(width: number, height: number) {
  return fitGallery({ count: 1, width, height, gap: 0, minAspect: 16 / 9, maxAspect: 16 / 9 });
}
