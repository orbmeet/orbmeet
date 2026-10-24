import type { MeetingUIState } from "@/modules/meetings/client/use-meeting-ui";
import { selectedDeviceLabel } from "@/modules/meetings/client/device-selection";
import * as React from "react";
import {
  AudioWaveform,
  Captions,
  ChevronLeft,
  ChevronRight,
  Circle,
  Hand,
  Languages,
  MessageSquareText,
  Mic,
  MicOff,
  Monitor,
  MonitorUp,
  LogOut,
  MoreHorizontal,
  Radio,
  SquarePen,
  Timer,
  Users,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";
import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";
import { BottomSheet } from "@orbmeet/ui/react";
import { BackgroundEffectPicker } from "@/modules/meetings/client/components/background-effect-picker";
import { CountdownTimerPanel } from "@/modules/meetings/client/components/countdown-timer-button";
import { MeetingAudioDevicePanel } from "@/modules/meetings/client/components/meeting-audio-device-panel";
import { countBadge } from "@/modules/meetings/client/meeting-styles";
import {
  selectDockGroups,
  type DockAction,
  type DockActionId,
} from "@/modules/meetings/client/dock-actions";
import {
  STREAMING_DESTINATIONS,
  readStreamingPreference,
  writeStreamingPreference,
} from "@/modules/meetings/client/streaming-preferences";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";
import type { BackgroundMode } from "@/modules/meetings/client/use-background-effect";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import type {
  DockAudioDeviceControls,
  DockBackgroundControls,
  DockHandRaiseControls,
  PhoneStageModes,
  SurfaceToolbarControls,
} from "@/modules/meetings/client/components/dock-controls";

const ACTION_ICONS: Record<DockActionId, LucideIcon> = {
  hand: Hand,
  "surface-existing": SquarePen,
  share: MonitorUp,
  audio: AudioWaveform,
  background: Video,
  captions: Captions,
  "caption-language": Languages,
  record: Circle,
  stream: Radio,
  timer: Timer,
};

const BACKGROUND_LABELS: Record<BackgroundMode, string | undefined> = {
  none: undefined,
  blur: "Blur",
  image: "Image",
};

const styles = stylex.create({
  /**
   * The bar: the thumb zone. Five labelled controls across the bottom — mic,
   * camera, hand, the Conversation, more — each a full-width target, on the
   * same white as every other surface in the room. Leave is not here: it is
   * at the top, out of the thumb's arc.
   */
  bar: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: 2,
    marginInline: { default: space.s3, [bp.sm]: "auto" },
    marginBottom: space.s2,
    maxWidth: { default: null, [bp.sm]: "28rem" },
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
    paddingInline: space.s1,
    paddingBlock: space.s1,
    boxShadow: `0 12px 32px -12px ${scrim.soft}`,
  },

  sheetBody: {
    height: "100%",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingInline: space.s4,
    paddingBottom: space.s4,
  },
  /** Every group but the last leaves the next one a full step of air. */
  group: { marginBottom: { default: space.s5, ":last-child": 0 } },
  groupTitle: {
    marginBottom: space.s1_5,
    paddingInline: space.s1,
    marginBlockStart: 0,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
    color: neutral.n400,
  },
  /** The group's rows share one outline: separators are inner borders. */
  groupCard: {
    overflow: "hidden",
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
  },

  nestedPanel: { display: "flex", height: "100%", flexDirection: "column", overflow: "hidden" },
  back: {
    marginInline: space.s4,
    marginBottom: space.s2,
    display: "flex",
    width: "fit-content",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.control,
    paddingBlock: space.s2,
    paddingRight: space.s3,
    paddingLeft: 0,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n800 } },
  },
  nestedBody: {
    minHeight: 0,
    flexGrow: 1,
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingInline: space.s4,
    paddingBottom: space.s4,
  },
  /** The picker's fixed 256px gives way to the sheet's full width. */
  pickerInSheet: { width: "100%", padding: 0 },

  /**
   * A 56pt target, the column's full width: used one-handed while talking,
   * the worst case for pointing accuracy. The words under the icon say what
   * it does now — "Unmute", not a slashed glyph to decode.
   */
  dockButton: {
    display: "flex",
    height: 56,
    minWidth: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    color: neutral.n700,
    cursor: "pointer",
  },
  dockIcon: {
    position: "relative",
    display: "grid",
    width: 44,
    height: 30,
    placeItems: "center",
    borderRadius: radii.control,
    transform: { default: null, ":active": "scale(0.92)" },
    transitionProperty: "transform, background-color",
    transitionDuration: { default: "200ms", [env.reducedMotion]: "0s" },
  },
  dockButtonCompact: { height: 44, width: "100%" },
  /** The landscape rail: the right edge, top to bottom, Leave at its far top. */
  rail: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: neutral.n150,
    backgroundColor: surface.raised,
    paddingBlock: space.s2,
    paddingInline: space.s1,
  },
  railGap: { flexGrow: 1 },
  railLeave: {
    display: "grid",
    width: 44,
    height: 44,
    flexShrink: 0,
    placeItems: "center",
    marginBottom: space.s1,
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: danger.d600,
    color: ink.onDark,
    cursor: "pointer",
  },
  dockLabel: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  dockNeutral: {},
  dockActive: { backgroundColor: accent.a50, color: accent.a700 },
  /** Off is a red tint, not a red fill: the fill belongs to Leave alone. */
  dockOff: { backgroundColor: danger.d50, color: danger.d600 },
  dockDanger: { backgroundColor: danger.d500, color: ink.onDark },
  dockLabelActive: { color: accent.a700 },
  dockLabelOff: { color: danger.d700 },
  dockDisabled: { pointerEvents: "none", opacity: 0.4 },

  actionRow: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    textAlign: "start",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    // Stated, never unset: a `null` default removes the property rather than
    // leaving it alone, and a <button> then falls back to the user agent —
    // `currentColor` for this border, ButtonFace grey for the fill below.
    borderTopColor: { default: "transparent", ":not(:first-child)": neutral.n100 },
    backgroundColor: { default: "transparent", ":active": neutral.n100 },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.55 },
  },
  actionGlyph: {
    display: "flex",
    height: 36,
    width: 36,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },
  actionGlyphIdle: { backgroundColor: neutral.n100, color: neutral.n600 },
  actionGlyphActive: { backgroundColor: accent.a100, color: accent.a700 },
  actionGlyphDanger: { backgroundColor: danger.d100, color: danger.d600 },
  actionBody: { minWidth: 0, flexGrow: 1 },
  actionLabel: {
    display: "block",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n900,
  },
  actionDetail: { marginTop: space.s0_5, display: "block", fontSize: text.xs, color: neutral.n500 },
  actionChevron: { flexShrink: 0, color: neutral.n300 },

  /** The picker's own label style, at the sheet's larger size. */
  fieldLabel: {
    display: "block",
    marginBottom: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: neutral.n500,
  },
  destinations: {
    marginBottom: space.s4,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  destination: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200 },
    backgroundColor: { default: surface.raised },
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: { default: neutral.n700 },
  },
  destinationSelected: { borderColor: accent.a500, backgroundColor: accent.a50, color: accent.a800 },
  streamKeyInput: {
    marginBottom: space.s4,
    height: 48,
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus": accent.a500 },
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.base,
    color: neutral.n900,
    outlineStyle: "none",
    boxShadow: { default: null, ":focus": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)` },
    "::placeholder": { color: neutral.n400 },
  },
  /** Going live is the destructive-shaped action of the sheet: it is public. */
  goLive: {
    height: 48,
    width: "100%",
    borderRadius: radii.control,
    backgroundColor: { default: danger.d500, ":active": danger.d600 },
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.onDark,
    opacity: { default: 1, ":disabled": 0.4 },
  },
});

/**
 * Grouped to mirror the `useLiveMeeting` slices so the layout passes them
 * through unchanged (`captions={meeting.captions}`). Shapes are declared
 * structurally here; the dock imports no hook types.
 */
export interface PhoneDockProps {
  // Primary controls — the ones that live on the bar itself.
  isMicOn: boolean;
  onToggleMic: () => void;
  isCameraOn: boolean;
  onToggleCamera: () => void;

  // Everything else lives in the sheet.
  isHost: boolean;
  panels: Pick<MeetingUIState, "panel" | "timelineUnreadCount" | "togglePanel" | "closePanel">;
  handRaise?: DockHandRaiseControls;
  /** The extension surface (e.g. whiteboard); omit when none is registered. */
  surface?: Pick<SurfaceToolbarControls, "label" | "active" | "onToggle" | "onChooseExisting" | "chooseExistingLabel">;
  isScreenSharing: boolean;
  onToggleScreenShare: () => void;
  audio?: DockAudioDeviceControls;
  background?: DockBackgroundControls;
  /** Captions over the meeting, and your spoken language. */
  captions?: {
    showCaptions: boolean;
    toggleCaptions: () => void;
    captionLanguageLabel?: string;
    /** Opens the language picker sheet (a separate panel on phones). */
    onOpenLanguagePicker: () => void;
  };
  /** Recording status is shown to everyone; `onToggle` only for hosts. */
  recording: {
    isRecording: boolean;
    disabled?: boolean;
    disabledReason?: string | null;
    onToggle?: () => void;
  };
  /** Streaming status is shown to everyone; the handlers only for hosts. */
  streaming: {
    isStreaming: boolean;
    disabled?: boolean;
    onGoLive?: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
    onStop?: () => Promise<void>;
  };
  countdown: SharedCountdownState;
  /**
   * A phone on its side: the controls stand in a rail down the right edge,
   * with the way out at its far top and Talk | Board under it, since there is
   * no header to carry either.
   */
  rail?: {
    onLeave: () => void;
    modes?: PhoneStageModes;
  };
}

type NestedPanel = "audio" | "background" | "stream" | "timer" | null;

/**
 * The phone's meeting controls.
 *
 * Two decisions drive the shape:
 *
 * **The bar carries what is reached for every minute.** Mic, camera, the
 * board, the Timeline, more, leave — at most six 48pt targets, which fit with
 * real space between them on a 320pt screen because the bar is anchored to
 * the screen's width rather than computed from it (a computed `92vw` box once
 * rendered ~415pt wide on a 402pt phone and clipped mute and leave off both
 * edges). People and the lock are in the header.
 *
 * **Everything else is a list, not a grid.** A `grid-cols-4` of icons forces
 * every label through ~75pt, which is where "Open for ev…" came from. Rows give
 * each action its full label, a second line for its current state, a 44pt touch
 * target, and room to say *why* something is unavailable instead of hiding the
 * reason in a `title` no touch device will ever show.
 *
 * The bar sits below `--z-modal` and inside `MeetingShell`'s safe-area frame, so
 * sheets cover it by ordering and it cannot reach the display edge.
 */
export function PhoneDock({
  isMicOn,
  onToggleMic,
  isCameraOn,
  onToggleCamera,
  isHost,
  panels,
  handRaise,
  surface,
  isScreenSharing,
  onToggleScreenShare,
  audio,
  background,
  captions,
  recording,
  streaming,
  countdown,
  rail,
}: PhoneDockProps) {
  const { panel: openPanel, timelineUnreadCount: unreadCount, togglePanel, closePanel } = panels;
  // Chat and People are two tabs of one sheet, and its button opens or closes it whichever shows.
  const sheetOpen = openPanel === "timeline" || openPanel === "people";
  const onToggleHandRaise = handRaise?.onToggle;
  const {
    active: surfaceActive,
    onChooseExisting: onChooseExistingSurface,
    chooseExistingLabel: chooseExistingSurfaceLabel,
  } = surface ?? {};
  const {
    audioDevices,
    currentAudioDeviceId,
    handleSelectAudioDevice: onSelectAudioDevice,
    audioOutputDevices,
    currentAudioOutputDeviceId,
    handleSelectAudioOutputDevice: onSelectAudioOutputDevice,
  } = audio ?? {};
  const {
    mode: backgroundMode,
    imagePath: backgroundImagePath,
    isSupported: backgroundSupported,
    isProcessing: backgroundProcessing,
    clearEffect: onBackgroundNone,
    setBlur: onBackgroundBlur,
    setImage: onBackgroundImage,
  } = background ?? {};
  const {
    showCaptions,
    toggleCaptions,
    captionLanguageLabel,
    onOpenLanguagePicker: onOpenCaptionLanguage,
  } = captions ?? {};
  const {
    isRecording,
    disabled: recordingDisabled,
    disabledReason: recordingDisabledReason,
    onToggle: onToggleRecording,
  } = recording;
  const { isStreaming, disabled: streamingDisabled, onGoLive, onStop: onStopStream } = streaming;
  const [isSheetOpen, setIsSheetOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<NestedPanel>(null);

  const closeSheet = React.useCallback(() => {
    setIsSheetOpen(false);
    setPanel(null);
  }, []);

  const groups = selectDockGroups({
    isHost: isHost,
    // The hand has its own button on the dock.
    handRaise: null,
    surfaceActive: surfaceActive,
    canChooseExistingSurface: Boolean(onChooseExistingSurface),
    chooseExistingSurfaceLabel: chooseExistingSurfaceLabel,
    isScreenSharing: isScreenSharing,
    canConfigureAudio: Boolean(onSelectAudioDevice),
    audioDeviceLabel: selectedDeviceLabel(audioDevices ?? [], currentAudioDeviceId, "microphone"),
    backgroundSupported: Boolean(
      backgroundSupported &&
        onBackgroundNone &&
        onBackgroundBlur &&
        onBackgroundImage,
    ),
    backgroundLabel: backgroundMode
      ? BACKGROUND_LABELS[backgroundMode]
      : undefined,
    backgroundProcessing: backgroundProcessing,
    captionsShown: showCaptions,
    captionLanguageLabel: captionLanguageLabel,
    canRecord: Boolean(onToggleRecording),
    isRecording: Boolean(isRecording),
    recordingDisabled: Boolean(recordingDisabled),
    recordingDisabledReason: recordingDisabledReason,
    canStream: Boolean(onGoLive || onStopStream),
    isStreaming: Boolean(isStreaming),
    streamingDisabled: Boolean(streamingDisabled),
    countdownActive: countdown.active,
    countdownLabel: formatCountdown(countdown.remainingSeconds),
  });
  const handleSelect = (action: DockAction) => {
    switch (action.id) {
      case "hand":
        onToggleHandRaise?.();
        return closeSheet();
      case "surface-existing":
        onChooseExistingSurface?.();
        return closeSheet();
      case "share":
        onToggleScreenShare();
        return closeSheet();
      case "captions":
        toggleCaptions?.();
        return closeSheet();
      case "caption-language":
        onOpenCaptionLanguage?.();
        return closeSheet();
      case "record":
        onToggleRecording?.();
        return closeSheet();
      case "background":
        return setPanel("background");
      case "audio":
        return setPanel("audio");
      case "timer":
        return setPanel("timer");
      case "stream":
        if (isStreaming) {
          void onStopStream?.()
            .then(closeSheet)
            .catch(() => {
              // The meeting hook surfaces the error; keep the sheet open so
              // the still-active stream is represented accurately.
            });
          return;
        }
        return setPanel("stream");
    }
  };

  return (
    <>
      <nav aria-label="Meeting controls" {...stylex.props(rail ? styles.rail : styles.bar, !rail && blur.md)}>
        {rail && (
          <>
            <button
              type="button"
              onClick={rail.onLeave}
              aria-label="Leave meeting"
              title="Leave meeting"
              {...stylex.props(pressable.base, styles.railLeave)}
            >
              <LogOut size={18} strokeWidth={2} />
            </button>
            {rail.modes && (
              <RailStageButton modes={rail.modes} />
            )}
            <span aria-hidden="true" {...stylex.props(styles.railGap)} />
          </>
        )}
        <DockButton
          icon={isMicOn ? Mic : MicOff}
          label={isMicOn ? "Mute" : "Unmute"}
          tone={isMicOn ? "neutral" : "off"}
          compact={Boolean(rail)}
          onClick={onToggleMic}
        />
        <DockButton
          icon={isCameraOn ? Video : VideoOff}
          label={isCameraOn ? "Camera" : "Camera off"}
          description={isCameraOn ? "Turn camera off" : "Turn camera on"}
          tone={isCameraOn ? "neutral" : "off"}
          compact={Boolean(rail)}
          onClick={onToggleCamera}
        />
        {handRaise?.queue ? (
          // A moderator's hands wait in the Conversation, first in line on top.
          <DockButton
            icon={Hand}
            label="Hands"
            description={`Raised hands, ${handRaise.queue.pendingCount} waiting`}
            // The queue opens the Conversation, which the Chat button already
            // marks as open; lit here too, two buttons claimed one sheet.
            tone="neutral"
            badge={handRaise.queue.pendingCount}
            compact={Boolean(rail)}
            onClick={() => togglePanel("timeline")}
          />
        ) : handRaise ? (
          <DockButton
            icon={Hand}
            label={handRaise.isHandRaised ? "Lower" : "Hand"}
            description={handRaise.isHandRaised ? "Lower your hand" : "Raise your hand"}
            tone={handRaise.isHandRaised ? "active" : "neutral"}
            compact={Boolean(rail)}
            onClick={handRaise.onToggle}
          />
        ) : null}
        <DockButton
          icon={MessageSquareText}
          label="Chat"
          description={sheetOpen ? "Close the chat" : "Chat and people"}
          tone={sheetOpen ? "active" : "neutral"}
          badge={unreadCount}
          compact={Boolean(rail)}
          onClick={() => (sheetOpen ? closePanel() : togglePanel("timeline"))}
        />
        <DockButton
          icon={MoreHorizontal}
          label="More"
          description="More options"
          tone={isSheetOpen ? "active" : "neutral"}
          compact={Boolean(rail)}
          onClick={() => setIsSheetOpen(true)}
        />
      </nav>

      <BottomSheet
        open={isSheetOpen}
        onClose={closeSheet}
        title={panelTitle(panel)}
      >
        {panel === null ? (
          <div {...stylex.props(styles.sheetBody)}>
            {groups.map((group) => (
              <section key={group.id} {...stylex.props(styles.group)}>
                <h3 {...stylex.props(styles.groupTitle)}>
                  {group.title}
                </h3>
                <div {...stylex.props(styles.groupCard)}>
                  {group.actions.map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      onSelect={() => handleSelect(action)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div {...stylex.props(styles.nestedPanel)}>
            <button
              type="button"
              onClick={() => setPanel(null)}
              {...stylex.props(pressable.base, motion.tint, styles.back)}
            >
              <ChevronLeft size={16} />
              Back
            </button>
            <div {...stylex.props(styles.nestedBody)}>
              {panel === "background" &&
                onBackgroundNone &&
                onBackgroundBlur &&
                onBackgroundImage && (
                  <BackgroundEffectPicker
                    variant="light"
                    sx={styles.pickerInSheet}
                    mode={backgroundMode ?? "none"}
                    imagePath={backgroundImagePath ?? null}
                    isProcessing={Boolean(backgroundProcessing)}
                    onSelectNone={() => {
                      onBackgroundNone?.();
                      closeSheet();
                    }}
                    onSelectBlur={() => {
                      onBackgroundBlur?.();
                      closeSheet();
                    }}
                    onSelectImage={(path) => {
                      onBackgroundImage?.(path);
                      closeSheet();
                    }}
                  />
                )}
              {panel === "audio" && onSelectAudioDevice && (
                <MeetingAudioDevicePanel
                  isMicOn={isMicOn}
                  audioDevices={audioDevices ?? []}
                  currentAudioDeviceId={currentAudioDeviceId}
                  onSelectAudioDevice={onSelectAudioDevice}
                  audioOutputDevices={audioOutputDevices}
                  currentAudioOutputDeviceId={currentAudioOutputDeviceId}
                  onSelectAudioOutputDevice={onSelectAudioOutputDevice}
                  active={isSheetOpen}
                />
              )}
              {panel === "timer" && (
                <CountdownTimerPanel countdown={countdown} onClose={closeSheet} />
              )}
              {panel === "stream" && onGoLive && (
                <StreamSetupPanel onGoLive={onGoLive} onDone={closeSheet} />
              )}
            </div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function panelTitle(panel: NestedPanel): string {
  switch (panel) {
    case "audio":
      return "Audio devices";
    case "background":
      return "Background";
    case "timer":
      return "Timer";
    case "stream":
      return "Go live";
    default:
      return "Meeting options";
  }
}

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")} left`;
}

/**
 * The landscape rail's one stage button: back to Talk from the board or a
 * shared screen, and from Talk to whichever is there — the screen first,
 * since someone is presenting it.
 */
function RailStageButton({ modes }: { modes: PhoneStageModes }) {
  if (modes.shown !== "talk") {
    return (
      <DockButton icon={Users} label="Talk" description="Back to Talk" tone="neutral" compact onClick={modes.onTalk} />
    );
  }
  const toScreen = modes.onScreen;
  const onContent = toScreen ?? modes.onBoard;
  if (!onContent) return null;
  const label = toScreen ? "Screen" : (modes.boardLabel ?? "Board");
  return (
    <DockButton
      icon={toScreen ? Monitor : SquarePen}
      label={label}
      description={`Show the ${label.toLowerCase()}`}
      tone="neutral"
      compact
      onClick={onContent}
    />
  );
}

function DockButton({
  icon: Icon,
  label,
  description,
  tone,
  badge,
  disabled,
  compact = false,
  onClick,
}: {
  icon: LucideIcon;
  /** The word under the icon. */
  label: string;
  /** What pressing it does, for a screen reader, when the word alone does not say. */
  description?: string;
  tone: "neutral" | "active" | "off" | "danger";
  badge?: number;
  disabled?: boolean;
  /** In the landscape rail: the icon alone, its word in the tooltip. */
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={description ?? label}
      title={compact ? label : undefined}
      disabled={disabled}
      onClick={onClick}
      {...stylex.props(pressable.base, styles.dockButton, compact && styles.dockButtonCompact, disabled && styles.dockDisabled)}
    >
      <span
        {...stylex.props(
          styles.dockIcon,
          tone === "danger"
            ? styles.dockDanger
            : tone === "off"
              ? styles.dockOff
              : tone === "active"
                ? styles.dockActive
                : styles.dockNeutral,
        )}
      >
        <Icon size={20} strokeWidth={1.9} />
        {badge !== undefined && badge > 0 && (
          <span {...stylex.props(countBadge.base, countBadge.corner)}>{badge > 9 ? "9+" : badge}</span>
        )}
      </span>
      {!compact && <span
        aria-hidden="true"
        {...stylex.props(
          styles.dockLabel,
          tone === "active" && styles.dockLabelActive,
          tone === "off" && styles.dockLabelOff,
        )}
      >
        {label}
      </span>}
    </button>
  );
}

function ActionRow({
  action,
  onSelect,
}: {
  action: DockAction;
  onSelect: () => void;
}) {
  const Icon = ACTION_ICONS[action.id];
  return (
    <button
      type="button"
      disabled={action.disabled}
      onClick={onSelect}
      {...stylex.props(pressable.base, motion.tint, styles.actionRow)}
    >
      <span
        {...stylex.props(
          styles.actionGlyph,
          action.danger
            ? styles.actionGlyphDanger
            : action.active
              ? styles.actionGlyphActive
              : styles.actionGlyphIdle,
        )}
      >
        <Icon size={18} />
      </span>
      <span {...stylex.props(styles.actionBody)}>
        <span {...stylex.props(styles.actionLabel)}>{action.label}</span>
        {action.detail && (
          <span {...stylex.props(styles.actionDetail)}>{action.detail}</span>
        )}
      </span>
      {action.badge !== undefined && action.badge > 0 && (
        <span {...stylex.props(countBadge.base, countBadge.inline)}>
          {action.badge > 99 ? "99+" : action.badge}
        </span>
      )}
      {action.opensPanel && !action.disabled && (
        <ChevronRight size={16} {...stylex.props(styles.actionChevron)} />
      )}
    </button>
  );
}

function StreamSetupPanel({
  onGoLive,
  onDone,
}: {
  onGoLive: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
  onDone: () => void;
}) {
  const [platform, setPlatform] = React.useState<StreamingPlatform>(
    () => readStreamingPreference()?.platform ?? "twitch",
  );
  const [streamKey, setStreamKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const destination =
    STREAMING_DESTINATIONS.find((entry) => entry.id === platform) ??
    STREAMING_DESTINATIONS[0];

  const start = async () => {
    if (!streamKey.trim() || submitting) return;
    setSubmitting(true);
    try {
      writeStreamingPreference({ platform });
      await onGoLive(platform, streamKey.trim());
      onDone();
    } catch {
      // Preserve the entered stream key for a retry. The meeting hook already
      // owns the user-facing error toast.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p {...stylex.props(styles.fieldLabel)}>
        Destination
      </p>
      <div {...stylex.props(styles.destinations)}>
        {STREAMING_DESTINATIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setPlatform(entry.id)}
            {...stylex.props(
              pressable.base,
              motion.tint,
              styles.destination,
              platform === entry.id && styles.destinationSelected,
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <label
        htmlFor="dock-stream-key"
        {...stylex.props(styles.fieldLabel)}
      >
        {destination.keyLabel}
      </label>
      <input
        id="dock-stream-key"
        type="text"
        inputMode="text"
        placeholder={destination.placeholder}
        value={streamKey}
        onChange={(event) => setStreamKey(event.target.value)}
        {...stylex.props(styles.streamKeyInput, motion.tint)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => void start()}
        disabled={!streamKey.trim() || submitting}
        {...stylex.props(pressable.base, motion.tint, styles.goLive)}
      >
        {submitting ? "Starting…" : "Go live"}
      </button>
    </div>
  );
}
