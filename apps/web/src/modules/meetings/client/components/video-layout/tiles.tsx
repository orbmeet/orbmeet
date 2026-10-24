import * as stylex from "@stylexjs/stylex";
import { memo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { MeetingVideoTrack } from "../meeting-video-track";
import { type Participant, Track } from "livekit-client";
import { MicOff, Monitor } from "lucide-react";
import { eqByIndex, stagger } from "@orbmeet/ui/styles/animations";
import { layout } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { accent, danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { type StyleXStyles } from "@stylexjs/stylex";
import { Avatar } from "@orbmeet/ui/react";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import { getAvatarTileScale } from "@/modules/meetings/client/gallery-fit";
import { useCommittedRef } from "@orbmeet/ui/react";
import { glass, scrimBase } from "@orbmeet/ui/tokens/wash.stylex";
import { type VideoTrackRef } from "./tracks";
import { CameraSwitchButton } from "./camera-switch-button";
import { shared } from "./shared-styles";

const styles = stylex.create({
  /** Three accent bars — the room's one "this person is talking" mark. */
  bars: {
    display: "flex",
    height: 12,
    alignItems: "flex-end",
    gap: 2,
    color: accent.a600,
  },
  /** On a dark plate the accent steps up to stay legible. */
  barsOnDark: { color: accent.a300 },
  bar: { width: 2, borderRadius: radii.pill, backgroundColor: "currentColor" },
  barHeight: (height: string) => ({ height }),
  voiceHalo: (boxShadow: string) => ({ boxShadow }),
  scaledFont: (fontSize: number) => ({ fontSize }),
  /**
   * A tile, either viewport. The phone tile carries a lighter corner and a
   * hairline of white (it sits on black); the desktop tile the softer
   * panel radius on the canvas tone.
   */
  tile: {
    position: "relative",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    // WebKit composites a transformed <video> — your mirrored camera — on a
    // layer of its own that can paint square corners past the tile's
    // `overflow`; a stacking context of the tile's own keeps it clipped.
    isolation: "isolate",
    backgroundColor: neutral.n100,
    transitionProperty: "box-shadow, transform, opacity, border-color",
    transitionDuration: { default: "300ms", [env.reducedMotion]: "0s" },
  },
  tilePhone: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: glass.veil,
  },
  tileDesktop: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
  },
  /**
   * Video tiles sit on black while frames load, not on a grey that flashes.
   * The black stops inside the border: under it, the 8% hairline read as a
   * near-black frame around every face.
   */
  tileVideo: {
    backgroundColor: neutral.n900,
    backgroundClip: "padding-box",
    borderColor: `color-mix(in oklab, ${scrimBase.black} 8%, transparent)`,
  },
  /**
   * Speaking: a crisp accent edge. The ring itself is drawn in the inline
   * box-shadow (see `speakingRing`), because the voice halo is an inline
   * box-shadow on the same element and would win over any class.
   */
  tileSpeakingDesktop: { borderColor: accent.a500 },
  tileSpeakingPhone: {
    borderColor: live.l400,
    boxShadow: `0 0 0 1px color-mix(in oklab, ${live.l400} 40%, transparent)`,
  },
  /**
   * The nameplate is a light chip, not white text on a scrim: the room's
   * chrome is light everywhere else, and a translucent white pill stays
   * legible over a camera feed of any brightness without darkening the
   * bottom third of every tile to make room for it.
   */
  nameRow: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: space.s2_5,
    bottom: space.s2_5,
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s1_5,
  },
  /**
   * Beside your own picture in the corner (`selfPip` in video-grid: 30% wide,
   * at most 132px, 0.75rem in). A long name used to run on under it.
   */
  nameRowClearsCorner: { insetInlineEnd: `calc(min(30%, 132px) + 0.75rem + ${space.s2_5})` },
  /**
   * The nameplate on video: a small dark glass chip. A camera feed is
   * anything from a window to a black hoodie, and dark glass with white type
   * reads over all of it without the scrim that would darken the bottom third
   * of every face. It is small and square-ish on purpose — a label, not a
   * button.
   */
  nameChip: {
    pointerEvents: "auto",
    display: "flex",
    minWidth: 0,
    height: 26,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 52%, transparent)`,
    paddingInline: space.s2,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ink.onDark} 10%, transparent)`,
  },
  name: { fontSize: text.xs, fontWeight: weight.medium, color: ink.onDark },
  you: { marginLeft: space.s1, fontWeight: weight.normal, color: `color-mix(in oklab, ${ink.onDark} 65%, transparent)` },
  /** The speaking bars ride in their own chip so a long name cannot crowd them. */
  barsChip: {
    pointerEvents: "auto",
    display: "flex",
    height: 26,
    width: 26,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 52%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ink.onDark} 10%, transparent)`,
  },
  /** A shared screen: whole, on dark, as the screen stage shows it — never cropped to fill. */
  tileScreen: { backgroundColor: neutral.n900 },
  screenVideo: { objectFit: "contain" },
  presentingChip: {
    position: "absolute",
    top: space.s2_5,
    left: space.s2_5,
    display: "flex",
    height: 26,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 52%, transparent)`,
    paddingInline: space.s2,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ink.onDark} 10%, transparent)`,
  },
  /**
   * A moderator's actions on someone's tile, in the corner a camera switch
   * takes on your own. They wait for a pointer or focus where there is one,
   * and stay put on a touch screen, which has no hover to reveal them.
   */
  railActions: {
    position: "absolute",
    right: space.s1_5,
    top: space.s1_5,
    zIndex: zIndex.meetingPanel,
    opacity: {
      default: 1,
      [env.hoverable]: { default: 0, ":focus-within": 1, [stylex.when.ancestor(":hover")]: 1 },
    },
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [env.reducedMotion]: "0s" },
  },
  /** A camera-off tile keeps the same box as a camera-on one. */
  avatarTile: {
    position: "relative",
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    // Not flat white: a camera-off tile is a room someone is in, and the
    // faint fall-off toward its foot is what keeps a gallery of them from
    // reading as a grid of empty cards.
    backgroundColor: surface.raised,
    backgroundImage: `radial-gradient(120% 90% at 50% 0%, ${surface.raised} 40%, ${neutral.n50})`,
    transitionProperty: "box-shadow, transform, opacity, border-color",
    transitionDuration: { default: "300ms", [env.reducedMotion]: "0s" },
  },
  avatarTileBody: {
    display: "flex",
    maxWidth: "100%",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s4,
  },
  avatarTileNameBlock: {
    display: "flex",
    maxWidth: "100%",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1_5,
    textAlign: "center",
  },
  avatarTileName: {
    display: "block",
    maxWidth: "100%",
    fontWeight: weight.medium,
    color: neutral.n900,
  },
  avatarTileYou: { marginLeft: space.s1_5, fontWeight: weight.normal, color: ink.muted },
  avatarTileState: { display: "flex", alignItems: "center", gap: space.s1_5, fontWeight: weight.medium },
  avatarTileSpeaking: { color: accent.a700 },
  avatarTileMuted: { color: ink.muted },
});

export type RegisterVoiceTile = (
  identity: string,
  el: HTMLElement | null,
) => void | (() => void);

// Base (non-reactive) shadow for each tile shape. The live voice halo is
// appended to the same box-shadow without a second wrapper element.
export const VIDEO_TILE_BASE_SHADOW = shadows.hairline;

const SPEAKING_BAR_HEIGHTS = ["45%", "100%", "65%"] as const;

/**
 * Three accent bars — the room's one "this person is talking" mark. Deliberately
 * monochrome: the speaking state is already carried by the tile's accent ring,
 * so this repeats it in the same colour rather than introducing a second one.
 */
function SpeakingBars({ sx }: { sx?: StyleXStyles }) {
  return (
    <span {...stylex.props(styles.bars, sx)} aria-hidden="true">
      {SPEAKING_BAR_HEIGHTS.map((height, i) => (
        <span
          key={height}
          {...stylex.props(
            styles.bar,
            styles.barHeight(height),
            eqByIndex[i],
            stagger.by(i * 120),
          )}
        />
      ))}
    </span>
  );
}

export function voiceHaloBoxShadow(base: string): string {
  return `${base}, 0 0 calc(var(--voice, 0) * 30px) calc(var(--voice, 0) * 7px) color-mix(in oklab, ${accent.a500} calc(var(--voice, 0) * 50%), transparent)`;
}

/**
 * Drives the voice-reactive halo for every tile from a single requestAnimationFrame
 * loop. We read each participant's server-reported `audioLevel` (no per-tile
 * AudioContext — those are capped at ~6 per page) and write a shaped value to a
 * `--voice` CSS variable on the tile element. Writing CSS variables via refs
 * keeps this off React's render path entirely, so it scales to large meetings.
 */
export function useVoiceGlow(
  participants: Participant[],
  enabled: boolean,
): RegisterVoiceTile {
  const tilesRef = useRef(new Map<string, Set<HTMLElement>>());
  const participantsRef = useCommittedRef(participants);

  const registerVoiceTile = useCallback<RegisterVoiceTile>((identity, el) => {
    if (!el) return;
    const elements = tilesRef.current.get(identity) ?? new Set<HTMLElement>();
    elements.add(el);
    tilesRef.current.set(identity, elements);
    return () => {
      el.style.setProperty("--voice", "0");
      elements.delete(el);
      if (elements.size === 0) tilesRef.current.delete(identity);
    };
  }, []);

  useEffect(() => {
    // Phone tiles don't render the halo (see the `isPhone` guard on the tile's
    // boxShadow), so the loop there wrote a CSS variable nothing consumed while
    // waking the main thread 60×/s for the entire call. A permanently-scheduled
    // rAF also stops the browser ever coalescing frames or idling the CPU,
    // which on a handset is paid for in battery and heat rather than in jank.
    if (!enabled) return;

    let raf = 0;
    const tiles = tilesRef.current;
    const lastWritten = new WeakMap<HTMLElement, number>();

    const tick = () => {
      for (const participant of participantsRef.current) {
        const elements = tiles.get(participant.identity);
        if (!elements) continue;
        const raw = participant.isMicrophoneEnabled
          ? participant.audioLevel
          : 0;
        // sqrt curve lifts normal speech into a visible range; clamp to 1.
        const shaped = Math.min(1, Math.sqrt(Math.max(0, raw)) * 1.4);
        const rounded = Math.round(shaped * 100) / 100;
        for (const el of elements) {
          if (lastWritten.get(el) === rounded) continue;
          el.style.setProperty("--voice", String(rounded));
          lastWritten.set(el, rounded);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const elements of tiles.values()) {
        for (const el of elements) el.style.setProperty("--voice", "0");
      }
    };
  }, [enabled, participantsRef]);

  return registerVoiceTile;
}

interface ParticipantVideoTileProps {
  track: VideoTrackRef;
  identity: string;
  participantName: string;
  isSpeaking: boolean;
  isLocal: boolean;
  isMicrophoneEnabled: boolean;
  isPhone: boolean;
  registerVoiceTile: RegisterVoiceTile;
  videoDevices: MediaDeviceInfo[];
  currentVideoDeviceId?: string;
  onSelectVideoDevice?: (deviceId: string | undefined) => void;
  onRefreshVideoDevices?: () => void;
  /** A moderator's actions on this person; see `railActions`. */
  actions?: ReactNode;
  /** Your own picture sits over this tile's bottom-right corner; the nameplate stops short of it. */
  clearsCorner?: boolean;
}

export function ParticipantVideoTile({
  track,
  identity,
  participantName,
  isSpeaking,
  isLocal,
  isMicrophoneEnabled,
  isPhone,
  registerVoiceTile,
  videoDevices,
  currentVideoDeviceId,
  onSelectVideoDevice,
  onRefreshVideoDevices,
  actions,
  clearsCorner = false,
}: ParticipantVideoTileProps) {
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => registerVoiceTile(identity, el),
    [identity, registerVoiceTile],
  );
  const isScreen = track.source === Track.Source.ScreenShare;
  return (
    <div
      ref={setRoot}
      {...stylex.props(
        styles.tile,
        shared.haloTransition,
        isPhone ? styles.tilePhone : styles.tileDesktop,
        !isPhone && styles.tileVideo,
        isScreen && styles.tileScreen,
        actions ? stylex.defaultMarker() : null,
        isSpeaking && (isPhone ? styles.tileSpeakingPhone : styles.tileSpeakingDesktop),
        !isPhone &&
          styles.voiceHalo(
            voiceHaloBoxShadow(isSpeaking ? `0 0 0 1px ${accent.a500}` : VIDEO_TILE_BASE_SHADOW),
          ),
      )}
    >
      <MeetingVideoTrack
        trackRef={track}
        {...stylex.props(
          videoTrack.fill,
          isScreen ? styles.screenVideo : isLocal && videoTrack.mirrored,
        )}
      />

      {/* The nameplate is a light chip, not white text on a scrim (see
          styles.nameChip). `minWidth: 0` on the row and the chip is what lets
          the ellipsis engage: without it the chip's min-content width wins and
          a long name pushes the mute badge out of the tile. A shared screen
          has no nameplate: its chip says whose it is, and their microphone
          is on their own tile beside it. */}
      {!isScreen && (
        <div {...stylex.props(styles.nameRow, clearsCorner && styles.nameRowClearsCorner)}>
          <div {...stylex.props(layout.minZero, styles.nameChip, blur.md)}>
            {!isMicrophoneEnabled && (
              <MicOff size={12} strokeWidth={2} color={danger.d400} />
            )}
            <span {...stylex.props(layout.minZero, styles.name, layout.truncate)}>
              {participantName}
              {isLocal && <span {...stylex.props(styles.you)}>(You)</span>}
            </span>
          </div>

          {isSpeaking && isMicrophoneEnabled && (
            <div {...stylex.props(styles.barsChip, blur.md)}>
              <SpeakingBars sx={styles.barsOnDark} />
            </div>
          )}
        </div>
      )}

      {isScreen && (
        <div {...stylex.props(styles.presentingChip, blur.md)}>
          <Monitor size={14} color={accent.a300} />
          <span {...stylex.props(styles.name)}>{isLocal ? "Your screen" : `${participantName}'s screen`}</span>
        </div>
      )}

      {isLocal &&
        !isScreen &&
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

      {actions && !isScreen && <div {...stylex.props(styles.railActions)}>{actions}</div>}
    </div>
  );
}

interface GridAvatarTileProps {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  isMicrophoneEnabled: boolean;
  isPhone: boolean;
  registerVoiceTile: RegisterVoiceTile;
  /** The height the gallery fit gave this tile, or 0 when unmeasured. */
  tileHeight: number;
  /** A moderator's actions on this person; see `railActions`. */
  actions?: ReactNode;
}

export const GridAvatarTile = memo(
  function GridAvatarTile({
    identity,
    name,
    isLocal,
    isSpeaking,
    isMicrophoneEnabled,
    isPhone,
    registerVoiceTile,
    tileHeight,
    actions,
  }: GridAvatarTileProps) {
    const setRoot = useCallback(
      (el: HTMLDivElement | null) => registerVoiceTile(identity, el),
      [identity, registerVoiceTile],
    );
    // The tile is fitted to the stage, so its contents are fitted to the tile.
    // Phones fill rather than fit, and keep the fixed sizes.
    const scale = getAvatarTileScale(isPhone ? 0 : tileHeight);
    return (
      <div
        ref={setRoot}
        {...stylex.props(
          styles.avatarTile,
          shared.haloTransition,
          isPhone ? styles.tilePhone : styles.tileDesktop,
          actions ? stylex.defaultMarker() : null,
          isSpeaking && !isPhone && styles.tileSpeakingDesktop,
          !isPhone && styles.voiceHalo(
            voiceHaloBoxShadow(isSpeaking ? `0 0 0 1px ${accent.a500}` : VIDEO_TILE_BASE_SHADOW),
          ),
        )}
      >
        <div {...stylex.props(styles.avatarTileBody)}>
          <Avatar name={name || identity || "User"} sizePx={scale.avatarPx} />

          <div {...stylex.props(styles.avatarTileNameBlock)}>
            {/* The cap tracks the tile too: 180px was a name-sized truncation
                on a 240px tile and a hard stop mid-name on a 558px one. */}
            <span
              {...stylex.props(
                styles.avatarTileName,
                layout.truncate,
                styles.scaledFont(scale.namePx),
              )}
            >
              {name || identity}
              {isLocal && <span {...stylex.props(styles.avatarTileYou)}>(You)</span>}
            </span>

            {isMicrophoneEnabled ? (
              isSpeaking && (
                <span
                  {...stylex.props(
                    styles.avatarTileState,
                    styles.avatarTileSpeaking,
                    styles.scaledFont(scale.statePx),
                  )}
                >
                  <SpeakingBars />
                  Speaking
                </span>
              )
            ) : (
              <span
                {...stylex.props(
                  styles.avatarTileState,
                  styles.avatarTileMuted,
                  styles.scaledFont(scale.statePx),
                )}
              >
                <MicOff size={12} strokeWidth={2} />
                Muted
              </span>
            )}
          </div>
        </div>
        {actions && <div {...stylex.props(styles.railActions)}>{actions}</div>}
      </div>
    );
  },
  (prev, next) =>
    prev.identity === next.identity &&
    prev.name === next.name &&
    prev.isLocal === next.isLocal &&
    prev.isSpeaking === next.isSpeaking &&
    prev.isMicrophoneEnabled === next.isMicrophoneEnabled &&
    prev.isPhone === next.isPhone &&
    prev.tileHeight === next.tileHeight &&
    prev.actions === next.actions &&
    prev.registerVoiceTile === next.registerVoiceTile,
);
