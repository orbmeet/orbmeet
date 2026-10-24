import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  Captions,
  ChevronDown,
  ChevronLeft,
  Keyboard,
  Layers,
  LocateFixed,
  LogOut,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  PhoneOff,
  Radio,
  SquarePen,
  Timer,
  Users,
  XCircle,
} from "lucide-react";
import { Toolbar } from "@base-ui/react/toolbar";
import { progress } from "@orbmeet/ui/styles/animations";
import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, live, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Button, PopoverContent, PopoverRoot, PopoverTrigger, Tooltip } from "@orbmeet/ui/react";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";
import { useNow } from "@/lib/hooks/use-now";
import { formatClock } from "@/modules/meetings/client/format-duration";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";
import { GoLiveForm } from "./go-live-button";
import { firstName } from "./meeting-format";
import { CountdownTimerPanel } from "./countdown-timer-button";
import type { SharedScreenControls, SurfaceToolbarControls } from "./dock-controls";
import {
  DockButton,
  DockLabel,
  DockMenuRow,
  SpeechWave,
  dockAccessibleName,
  dockItemStyles,
  dockStyles,
} from "./dock-primitives";
import { SelfControls, type SelfControlsProps } from "./self-controls";
import { commandPaletteShortcutLabel } from "@/modules/meetings/client/meeting-command-shortcut";
import {
  canPresentScreen,
  canShareScreenSound,
  loadShareScreenSound,
  saveShareScreenSound,
} from "@/modules/meetings/client/screen-share-sound";

// The strip's shared look lives in dock-primitives; these re-exports keep the
// contract tests pointed at the controls they describe.
export { dockAccessibleName, dockItemStyles } from "./dock-primitives";

export interface MeetingControlDockProps {
  self: SelfControlsProps;
}

export interface MeetingStageSwitchProps {
  isScreenSharing: boolean;
  onToggleScreenShare: () => void;
  /** The extension surface (e.g. whiteboard); omit when none is registered. */
  surface?: SurfaceToolbarControls;
  /** A screen being shared in the room; omit while nobody shares one. */
  sharedScreen?: SharedScreenControls;
  /** Hides the stage switch's words where the bar is narrow; the icons and names stay. */
  compact?: boolean;
}

export interface MeetingRoomActionsProps {
  countdown: SharedCountdownState;
  /** Omit to hide the recording control (non-hosts). */
  recording?: {
    isRecording: boolean;
    recordingPending?: boolean;
    disabled?: boolean;
    /** Why recording is unavailable, for the tooltip and accessible name. */
    disabledReason?: string | null;
    onToggle: () => void;
  };
  /** Omit to hide the go-live control (non-hosts). */
  streaming?: {
    isStreaming: boolean;
    streamingPending: boolean;
    handleStartStreaming: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
    handleStopStreaming: () => Promise<void>;
  };
  /** Captions over the meeting, for this viewer: the latest line of what is said. */
  captions: { shown: boolean; onToggle: () => void };
  /** The meeting's running record: chat, what is said, and raised hands. */
  timeline: {
    open: boolean;
    /** Someone's words are being written into it right now. */
    speechArriving?: boolean;
    /** Chat that arrived while it was closed. */
    unreadCount: number;
    /** Raised hands waiting for a moderator; 0 for anyone else. */
    waitingHands: number;
    onToggle: () => void;
  };
  /** The people in the room. Omit where there is no People panel. */
  people?: { open: boolean; count: number; onToggle: () => void };
  /** Opens the command palette. Omit where there is no keyboard to drive it. */
  onOpenCommands?: () => void;
  /** True while a leave or end request is in flight. */
  leavePending?: boolean;
  /** Leaves the meeting; it carries on without you. */
  onLeave: () => void;
  /** Ends the meeting for everyone. Omit for anyone who cannot end it. */
  onEndForEveryone?: () => void;
}

const styles = stylex.create({
  /** The room's half: its record and its people in one pill, then the way out. */
  actions: { display: "flex", alignItems: "center", gap: space.s2 },
  /**
   * What is on stage, as one choice between named views rather than a toggle
   * on each. "Whiteboard" as an on/off button said nothing about what you
   * would see instead; Talk, Board and your screen are all things the stage
   * can show, so presenting is the third of them rather than a button apart.
   */
  views: {
    position: "relative",
    display: "flex",
    height: { default: 40, [env.touch]: 44 },
    alignItems: "center",
    gap: 2,
    borderRadius: radii.pill,
    padding: 4,
    backgroundColor: `color-mix(in oklab, ${neutral.n900} 5.5%, transparent)`,
    boxShadow: `inset 0 1px 2px color-mix(in oklab, ${neutral.n900} 6%, transparent)`,
  },
  /**
   * The chosen view's ground, as one object that slides to whatever is picked
   * rather than a highlight that blinks from one button to the next.
   */
  thumb: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 0,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    boxShadow: `0 0 0 1px ${neutral.n150}, 0 1px 3px color-mix(in oklab, ${neutral.n900} 10%, transparent), 0 4px 12px color-mix(in oklab, ${neutral.n900} 6%, transparent)`,
    transitionProperty: "translate, width",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
    pointerEvents: "none",
  },
  thumbAt: (left: number, width: number) => ({ translate: `${left}px 0`, width }),
  view: {
    position: "relative",
    display: "flex",
    height: "100%",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n800 } },
    backgroundColor: "transparent",
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 30%, transparent)` },
    transitionProperty: "background-color, color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  viewOn: {
    color: neutral.n900,
    fontWeight: weight.semibold,
  },
  viewDisabled: { cursor: "not-allowed", opacity: 0.45 },
  /**
   * A screen is live — someone else's, or yours while you look at something
   * else: the mark of a broadcast, in place of the icon. The room's live
   * green, as in the phone's header, not red: red here read as recording.
   */
  liveDot: { width: 8, height: 8, flexShrink: 0, borderRadius: "50%", backgroundColor: live.l600 },
  /** Asked a host to open the board: a quiet amber mark, waiting. */
  viewAsked: { position: "relative" },
  askedDot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: "50%",
    backgroundColor: warning.w500,
    boxShadow: `0 0 0 2px ${surface.raised}`,
  },
  viewLabel: { display: { default: "none", [bp.lg]: "inline" } },
  viewLabelHidden: { display: "none" },
  viewOptions: {
    display: "flex",
    height: "100%",
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n900 } },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": surface.raised },
      ":is([data-popup-open])": surface.raised,
    },
  },

  record: {
    display: "flex",
    height: { default: 34, [env.touch]: 40 },
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    paddingInline: space.s3,
  },
  /** The record slot is the one control whose focus ring is red, not blue. */
  recordFocus: {
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${danger.d500} 30%, transparent)` },
  },
  /** While the toggle is in flight the control is visible but dimmed, not greyed out. */
  recordPending: { opacity: 0.7 },
  recordDot: {
    height: 10,
    width: 10,
    flexShrink: 0,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: danger.d500,
    backgroundColor: "transparent",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  recordDotLive: { backgroundColor: danger.d500 },
  recordLabel: { fontVariantNumeric: "tabular-nums" },
  /** The idle record dot, as a menu row's glyph. */
  menuRecordDot: {
    height: 10,
    width: 10,
    marginInline: 3,
    flexShrink: 0,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: danger.d500,
  },

  subview: { padding: space.s1 },
  subviewBack: {
    marginBottom: space.s2,
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.control,
    paddingInline: space.s1_5,
    paddingBlock: space.s1,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": neutral.n600 } },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n50 },
    },
  },

  /**
   * Leave is the bar's one filled red block — the fill every "off" state is
   * kept a tint so as not to be confused with. It sits at the far end of the
   * bar, away from the hands, and it opens a menu rather than acting, so no
   * single tap can end a call.
   */
  leave: {
    display: "flex",
    height: 34,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s3_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    color: ink.onDark,
    backgroundColor: {
      default: danger.d600,
      [env.hoverable]: { default: danger.d600, ":hover": danger.d700 },
      ":is([data-popup-open])": danger.d700,
    },
    boxShadow: {
      default: `inset 0 1px 0 color-mix(in oklab, ${ink.onDark} 14%, transparent)`,
      ":focus-visible": `0 0 0 2px ${surface.raised}, 0 0 0 4px color-mix(in oklab, ${danger.d500} 45%, transparent)`,
    },
    outlineStyle: "none",
  },
  leavePanel: { width: 272, padding: space.s1_5 },
  /** Before the browser's picker: whether the screen's sound goes too. */
  presentPanel: { display: "flex", width: 300, flexDirection: "column", gap: space.s2, padding: space.s3 },
  presentTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold, color: neutral.n900 },
  soundRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2_5,
    borderRadius: radii.control,
    padding: space.s2,
    backgroundColor: neutral.n50,
  },
  soundCheck: {
    flexShrink: 0,
    width: 16,
    height: 16,
    marginTop: 1,
    accentColor: accent.a600,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
  },
  soundText: { display: "flex", minWidth: 0, flexDirection: "column", gap: 2 },
  soundLabel: { fontSize: text.xs, fontWeight: weight.medium, color: neutral.n800 },
  soundLabelOff: { color: neutral.n400 },
  soundHint: { fontSize: text.xs2, lineHeight: leading.xs, color: neutral.n500 },
  presentGo: { alignSelf: "stretch" },
});

// ── The stage switch ──────────────────────────────────────────────────────────

/**
 * Talk, Board or Screen: what this participant has on stage.
 *
 * Talk and Board are views of the same room. Picking Talk never closes the
 * board for anyone else, and picking Board opens one for everyone only when a
 * moderator asks for a board the meeting does not have open yet. Closing it
 * for the whole room is a deliberate act, so it lives in the board's options
 * with the other things only a moderator does to the shared board.
 *
 * Screen presents yours to everyone; pressed, it stops.
 */
function StageSwitch({
  surface,
  isScreenSharing,
  onToggleScreenShare,
  sharedScreen,
  compact,
}: {
  surface?: SurfaceToolbarControls;
  isScreenSharing: boolean;
  onToggleScreenShare: () => void;
  sharedScreen?: SharedScreenControls;
  compact: boolean;
}) {
  // A shared screen takes the stage until this participant picks Talk or the
  // board instead; the Screen view then brings it back.
  const screenShown = sharedScreen?.shown === true;
  const boardShown = surface?.active === true && !screenShown;
  const boardAsked = surface?.asked === true && !boardShown;
  const talkShown = !boardShown && !screenShown;
  const setScreenAside = () => {
    if (screenShown) sharedScreen?.onSetAside();
  };
  const boardDisabled = surface?.disabled === true && !boardShown;
  const boardTooltip = !surface
    ? ""
    : boardDisabled
      ? (surface.disabledReason ?? `${surface.label} unavailable`)
      : boardShown
        ? [surface.label, surface.documentTitle].filter(Boolean).join(" — ")
        : (surface.toggleLabel ?? `Show the ${surface.label.toLowerCase()}`);
  const showBoard = surface?.onShowBoard ?? surface?.onToggle;
  const showTalk = surface?.onShowTalk ?? surface?.onToggle;
  const hasOptions =
    surface !== undefined &&
    (Boolean(surface.onChooseExisting) || Boolean(surface.onSync && boardShown) || Boolean(surface.onCloseForEveryone));
  // Someone else's screen is watched from here; your own is presented and
  // stopped, and says it is still going out while you look at Talk or the board.
  const othersScreen = sharedScreen?.presenterName ?? null;
  const presenting = isScreenSharing && !othersScreen;
  const screenLabel = othersScreen ? `${firstName(othersScreen)}'s screen` : presenting ? "Presenting" : "Screen";
  const screenTooltip = othersScreen
    ? `${othersScreen} is presenting their screen`
    : screenShown ? "Stop presenting your screen" : "Show your screen";
  const onScreen = () => {
    if (sharedScreen && !screenShown) sharedScreen.onShow();
    else if (!othersScreen) onToggleScreenShare();
  };
  const labelStyle = compact ? styles.viewLabelHidden : styles.viewLabel;
  const groupRef = useRef<HTMLDivElement>(null);
  const thumb = usePickedViewBounds(groupRef, `${talkShown}${boardShown}${screenShown}${compact}`);

  return (
    <Toolbar.Group ref={groupRef} aria-label="What is on stage" {...stylex.props(styles.views)}>
      {thumb && <span aria-hidden="true" {...stylex.props(styles.thumb, styles.thumbAt(thumb.left, thumb.width))} />}
      <Tooltip content="Faces, with the board one tap away" side="bottom">
        <Toolbar.Button
          onClick={() => {
            setScreenAside();
            if (surface?.active) showTalk?.();
          }}
          aria-pressed={talkShown}
          aria-label="Talk. Faces, with the board one tap away"
          {...stylex.props(pressable.base, styles.view, talkShown && styles.viewOn)}
        >
          <Users size={18} strokeWidth={talkShown ? 2 : 1.75} />
          <span {...stylex.props(labelStyle)}>Talk</span>
        </Toolbar.Button>
      </Tooltip>
      {surface && (
        <Tooltip content={boardTooltip} side="bottom">
          <Toolbar.Button
            onClick={() => {
              setScreenAside();
              if (!surface.active) showBoard?.();
            }}
            disabled={boardDisabled}
            aria-pressed={boardShown}
            aria-label={dockAccessibleName("Board", boardTooltip)}
            {...stylex.props(
              pressable.base,
              styles.view,
              boardShown && styles.viewOn,
              boardDisabled && styles.viewDisabled,
              boardAsked && styles.viewAsked,
            )}
          >
            {boardAsked && <span aria-hidden="true" {...stylex.props(styles.askedDot)} />}
            <SquarePen size={18} strokeWidth={boardShown ? 2 : 1.75} />
            <span {...stylex.props(labelStyle)}>Board</span>
          </Toolbar.Button>
        </Tooltip>
      )}
      {hasOptions && <BoardOptions surface={surface} boardShown={boardShown} />}
      {othersScreen || presenting ? (
        <Tooltip content={screenTooltip} side="bottom">
          <Toolbar.Button
            onClick={onScreen}
            aria-pressed={screenShown}
            aria-label={dockAccessibleName(screenLabel, screenTooltip)}
            {...stylex.props(pressable.base, styles.view, screenShown && styles.viewOn)}
          >
            <span aria-hidden="true" {...stylex.props(styles.liveDot)} />
            <span {...stylex.props(labelStyle)}>{screenLabel}</span>
          </Toolbar.Button>
        </Tooltip>
      ) : canPresentScreen() ? (
        <PresentScreen labelStyle={labelStyle} onPresent={onToggleScreenShare} />
      ) : null}
    </Toolbar.Group>
  );
}

/**
 * Screen, while nobody presents: one step before the browser's picker, to say
 * whether the screen's sound goes too and where that works at all. The picker
 * alone never says that a window carries no sound, so a video went out silent
 * and nobody knew why. The choice is remembered for the next time.
 */
function PresentScreen({
  labelStyle,
  onPresent,
}: {
  labelStyle: stylex.StyleXStyles;
  onPresent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const soundAvailable = canShareScreenSound();
  const [sound, setSound] = useState(() => soundAvailable && loadShareScreenSound());
  const present = () => {
    if (soundAvailable) saveShareScreenSound(sound);
    setOpen(false);
    // Still inside the click, so the browser lets the picker open.
    onPresent();
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Toolbar.Button
        render={<PopoverTrigger />}
        aria-label={dockAccessibleName("Screen", "Present your screen")}
        {...stylex.props(pressable.base, styles.view)}
      >
        <Monitor size={18} strokeWidth={1.75} />
        <span {...stylex.props(labelStyle)}>Screen</span>
      </Toolbar.Button>
      <PopoverContent title="Present your screen" side="bottom" align="center" sx={[dockStyles.menuPanel, styles.presentPanel]}>
        <p {...stylex.props(styles.presentTitle)}>Present your screen</p>
        <label {...stylex.props(styles.soundRow)}>
          <input
            type="checkbox"
            checked={sound}
            disabled={!soundAvailable}
            onChange={(event) => setSound(event.target.checked)}
            {...stylex.props(styles.soundCheck)}
          />
          <span {...stylex.props(styles.soundText)}>
            <span {...stylex.props(styles.soundLabel, !soundAvailable && styles.soundLabelOff)}>Also share sound</span>
            <span {...stylex.props(styles.soundHint)}>
              {soundAvailable
                ? "Only works when you share a tab, or your whole screen on Windows. A single window has no sound."
                : "Only works in Chrome or Edge on a computer."}
            </span>
          </span>
        </label>
        <Button size="sm" onClick={present} sx={styles.presentGo}>
          Choose what to share
        </Button>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * Where the picked view sits in the switch: the thumb's place. Measured after
 * layout and again when the switch resizes (a label appearing at a wider
 * breakpoint, a font arriving), so the thumb is never left between buttons.
 */
function usePickedViewBounds(
  groupRef: RefObject<HTMLDivElement | null>,
  pickedKey: string,
): { left: number; width: number } | null {
  const [bounds, setBounds] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const picked = group.querySelector<HTMLElement>('[aria-pressed="true"]');
      setBounds(picked ? { left: picked.offsetLeft, width: picked.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [groupRef, pickedKey]);
  return bounds;
}

function BoardOptions({
  surface,
  boardShown,
}: {
  surface: SurfaceToolbarControls;
  boardShown: boolean;
}) {
  const [open, setOpen] = useState(false);
  const run = (action: (() => void) | undefined) => () => {
    setOpen(false);
    action?.();
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Toolbar.Button
        render={<PopoverTrigger />}
        aria-label="Board options"
        {...stylex.props(pressable.base, motion.tint, styles.viewOptions)}
      >
        <ChevronDown size={14} />
      </Toolbar.Button>
      <PopoverContent title="Board options" side="bottom" align="end" sx={dockStyles.menuPanel}>
        {surface.onChooseExisting && (
          <DockMenuRow
            icon={Layers}
            label={surface.chooseExistingLabel ?? "Open another board"}
            hint="Present a board from this Space or your library"
            disabled={surface.disabled}
            onClick={run(surface.onChooseExisting)}
          />
        )}
        {boardShown && surface.onSync && (
          <DockMenuRow
            icon={LocateFixed}
            label="Bring everyone to my page"
            onClick={run(surface.onSync)}
          />
        )}
        {surface.onCloseForEveryone && (
          <>
            <div aria-hidden="true" {...stylex.props(dockStyles.menuRule)} />
            <DockMenuRow
              icon={XCircle}
              label="Close the board for everyone"
              hint="Everyone goes back to faces until it is opened again"
              danger
              onClick={run(surface.onCloseForEveryone)}
            />
          </>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

// ── Record button ─────────────────────────────────────────────────────────────

/**
 * Recording is a pill with words, not an ambiguous glyph. While recording it
 * doubles as the "this is being recorded" disclosure, with an elapsed clock
 * when this client observed the start (a late joiner just sees REC — we don't
 * know the true start time here).
 */
interface RecordButtonProps {
  isRecording: boolean;
  recordingPending: boolean;
  disabled: boolean;
  /** Why it is disabled. Becomes the tooltip and part of the accessible name. */
  disabledReason?: string | null;
  onToggle: () => void;
}

function RecordButton(props: RecordButtonProps) {
  const { isRecording, recordingPending, onToggle: toggleRecording } = props;
  const [locallyRequestedStartMs, setLocallyRequestedStartMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isRecording && !recordingPending) setLocallyRequestedStartMs(null);
  }, [isRecording, recordingPending]);

  const onToggle = useCallback(() => {
    if (isRecording) {
      setLocallyRequestedStartMs(null);
    } else {
      setLocallyRequestedStartMs(Date.now());
    }
    toggleRecording();
  }, [isRecording, toggleRecording]);

  return (
    <RecordButtonState
      {...props}
      observedStartMs={isRecording ? locallyRequestedStartMs : null}
      onToggle={onToggle}
    />
  );
}

function RecordButtonState({
  isRecording,
  recordingPending,
  disabled,
  disabledReason,
  onToggle,
  observedStartMs,
}: RecordButtonProps & { observedStartMs: number | null }) {
  const now = useNow(1_000, isRecording && observedStartMs !== null);

  const elapsed =
    observedStartMs === null ? null : Math.max(0, Math.floor((now - observedStartMs) / 1000));
  const label = recordingPending
    ? isRecording
      ? "Stopping…"
      : "Starting…"
    : isRecording
      ? elapsed !== null
        ? `REC ${formatClock(elapsed)}`
        : "REC"
      : "Record";
  const tooltip =
    disabled && !isRecording
      ? (disabledReason ?? "Recording is unavailable")
      : isRecording
        ? "Stop recording"
        : "Start recording";

  const inert = disabled && !recordingPending;

  return (
    <Tooltip content={tooltip} side="bottom">
      <Toolbar.Button
        onClick={onToggle}
        disabled={inert}
        aria-pressed={isRecording}
        aria-label={dockAccessibleName(label, tooltip)}
        {...stylex.props(
          pressable.base,
          ...dockItemStyles({ off: isRecording, disabled: inert }),
          styles.record,
          styles.recordFocus,
          recordingPending && styles.recordPending,
        )}
      >
        <span
          // A recording indicator means "working right now", so it keeps
          // breathing under reduced motion like every progress indicator.
          {...stylex.props(
            styles.recordDot,
            isRecording && styles.recordDotLive,
            isRecording && progress.pulse,
          )}
          aria-hidden="true"
        />
        <span {...stylex.props(styles.recordLabel)}>{label}</span>
      </Toolbar.Button>
    </Tooltip>
  );
}

// ── More menu ─────────────────────────────────────────────────────────────────

type MoreMenuView = "menu" | "golive" | "timer";

function MenuRecordDot() {
  return <span aria-hidden="true" {...stylex.props(styles.menuRecordDot)} />;
}

function MenuKeyboardGlyph() {
  return <Keyboard size={16} strokeWidth={1.75} {...stylex.props(dockStyles.menuRowIcon)} />;
}

/**
 * The room's occasional tools behind one labelled menu: recording, going live
 * and the shared timer. The launchers for go-live and the timer open as
 * subviews of the same popup — no nested popovers.
 *
 * Its last row names the keyboard shortcut for the command palette, which
 * runs every control here and looks things up, so the bar needs no search box
 * of its own.
 */
function MoreMenu({
  record,
  countdown,
  showGoLive,
  goLiveDisabledReason,
  onGoLive,
  isStreaming,
  streamingPending,
  onStopStream,
  onOpenCommands,
}: {
  /** Starting a recording, while none is running. Omit to hide the row. */
  record?: { disabledReason: string | null; onStart: () => void };
  countdown: SharedCountdownState;
  showGoLive: boolean;
  goLiveDisabledReason: string | null;
  onGoLive?: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
  isStreaming: boolean;
  streamingPending: boolean;
  onStopStream?: () => Promise<void>;
  onOpenCommands?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MoreMenuView>("menu");

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setView("menu");
  }, []);

  const subviewTitle = view === "golive" ? "Go live" : "Shared timer";

  return (
    <PopoverRoot open={open} onOpenChange={handleOpenChange}>
      <Toolbar.Button
        render={<PopoverTrigger />}
        aria-label="More controls"
        {...stylex.props(pressable.base, ...dockItemStyles({ active: open }))}
      >
        <MoreHorizontal size={20} strokeWidth={1.75} aria-hidden="true" />
        <DockLabel wide>More</DockLabel>
      </Toolbar.Button>
      <PopoverContent title="More controls" side="bottom" align="end" sx={dockStyles.menuPanel}>
        {view === "menu" ? (
          <>
            {record && (
              <DockMenuRow
                icon={MenuRecordDot}
                label="Record meeting"
                hint={record.disabledReason ?? undefined}
                disabled={record.disabledReason !== null}
                onClick={() => {
                  record.onStart();
                  setOpen(false);
                }}
              />
            )}
            {showGoLive && (
              <DockMenuRow
                icon={Radio}
                label="Go live"
                hint={goLiveDisabledReason ?? "YouTube · Twitch"}
                disabled={goLiveDisabledReason !== null}
                onClick={() => setView("golive")}
              />
            )}
            {isStreaming && onStopStream && (
              <DockMenuRow
                icon={Radio}
                label="Stop the live stream"
                hint={streamingPending ? "Stopping…" : "Streaming now"}
                disabled={streamingPending}
                onClick={() => {
                  void onStopStream();
                  setOpen(false);
                }}
              />
            )}
            <DockMenuRow
              icon={Timer}
              label="Shared timer"
              hint={countdown.active ? "Running" : undefined}
              onClick={() => setView("timer")}
            />
            {onOpenCommands && (
              <>
                <div aria-hidden="true" {...stylex.props(dockStyles.menuRule)} />
                <DockMenuRow
                  icon={MenuKeyboardGlyph}
                  label="Every control from the keyboard"
                  hint={`${commandPaletteShortcutLabel()} runs any control, or asks Orb`}
                  onClick={() => {
                    setOpen(false);
                    onOpenCommands();
                  }}
                />
              </>
            )}
          </>
        ) : (
          <div {...stylex.props(styles.subview)}>
            <button
              type="button"
              onClick={() => setView("menu")}
              {...stylex.props(pressable.base, motion.tint, styles.subviewBack)}
            >
              <ChevronLeft size={12} />
              {subviewTitle}
            </button>
            {view === "golive" && <GoLiveForm onGoLive={onGoLive} onDone={() => setOpen(false)} />}
            {view === "timer" && (
              <CountdownTimerPanel countdown={countdown} onClose={() => setOpen(false)} />
            )}
          </div>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

// ── Leave menu ────────────────────────────────────────────────────────────────

/**
 * Leaving takes two deliberate taps: the button opens this menu, and the menu
 * says what each way out does. A host gets both ways out side by side —
 * leaving and ending for everyone are different decisions, and a host who
 * only meant to step away should never have to read a dialog to find the
 * button that does not end the call.
 */
function LeaveMenu({
  pending,
  onLeave,
  onEndForEveryone,
}: {
  pending: boolean;
  onLeave: () => void;
  onEndForEveryone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Toolbar.Button
        render={<PopoverTrigger />}
        aria-label="Leave the meeting"
        {...stylex.props(pressable.base, motion.tint, styles.leave)}
      >
        <LogOut size={15} strokeWidth={2} />
        Leave
      </Toolbar.Button>
      <PopoverContent
        title="Leave the meeting"
        side="bottom"
        align="end"
        sx={[dockStyles.menuPanel, styles.leavePanel]}
      >
        <DockMenuRow
          icon={LogOut}
          label="Leave meeting"
          hint={onEndForEveryone ? "Everyone else stays in the call" : "You can rejoin with the same link"}
          disabled={pending}
          onClick={() => {
            setOpen(false);
            onLeave();
          }}
        />
        {onEndForEveryone && (
          <>
            <div aria-hidden="true" {...stylex.props(dockStyles.menuRule)} />
            <DockMenuRow
              icon={PhoneOff}
              label="End meeting for everyone"
              hint="Disconnects every participant"
              danger
              disabled={pending}
              onClick={() => {
                setOpen(false);
                onEndForEveryone();
              }}
            />
          </>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

// ── Your controls ─────────────────────────────────────────────────────────────

/** Your controls: mic, camera and hand, with their settings. */
export function MeetingControlDock({ self }: MeetingControlDockProps) {
  return (
    // Toolbar.Root, not a bare role="toolbar": the role promises roving
    // tabindex and arrow-key navigation, and Base UI is what implements them.
    <Toolbar.Root aria-label="Your controls">
      <SelfControls {...self} />
    </Toolbar.Root>
  );
}

/**
 * What is on stage — Talk, Board or Screen — centred in the top strip: the
 * one choice that changes the whole room, so it has the middle of the bar to
 * itself.
 */
export function MeetingStageSwitch({
  isScreenSharing,
  onToggleScreenShare,
  surface,
  sharedScreen,
  compact = false,
}: MeetingStageSwitchProps) {
  return (
    <Toolbar.Root aria-label="Stage">
      <StageSwitch
        surface={surface}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={onToggleScreenShare}
        sharedScreen={sharedScreen}
        compact={compact}
      />
    </Toolbar.Root>
  );
}

// ── The room's actions ────────────────────────────────────────────────────────

/**
 * The room's half of the top strip, at its trailing edge: the room's
 * record, the people in it, who may join, and the way out — in that order,
 * so Leave is the last thing on the line and the furthest from your controls.
 *
 * Chat, spoken lines and raised hands are one Timeline, and the people are
 * one People button that also carries the head count, so the count is shown
 * in exactly one place.
 */
export function MeetingRoomActions({
  countdown,
  recording,
  streaming,
  captions,
  timeline,
  people,
  onOpenCommands,
  leavePending = false,
  onLeave,
  onEndForEveryone,
}: MeetingRoomActionsProps) {
  const showStreamingControl = streaming !== undefined;
  const {
    isStreaming = false,
    streamingPending = false,
    handleStartStreaming: onGoLive,
    handleStopStreaming: onStopStream,
  } = streaming ?? {};
  const timelineBadge = timeline.open ? 0 : timeline.unreadCount + timeline.waitingHands;
  const timelineTooltip = timeline.open
    ? "Close the chat"
    : timeline.waitingHands > 0
      ? `Chat · ${timeline.waitingHands} ${timeline.waitingHands === 1 ? "hand" : "hands"} raised`
      : "Chat · messages, the transcript, Orb and raised hands";

  return (
    <Toolbar.Root aria-label="Meeting controls" {...stylex.props(styles.actions)}>
      {/* Recording earns a place in the bar only while it is happening, where
          it doubles as the "you are being recorded" disclosure. Idle, it is
          one row of the More menu. */}
      {recording && (recording.isRecording || recording.recordingPending) && (
        <RecordButton
          isRecording={recording.isRecording}
          recordingPending={recording.recordingPending ?? false}
          disabled={recording.disabled ?? false}
          disabledReason={recording.disabledReason ?? null}
          onToggle={recording.onToggle}
        />
      )}
      <div {...stylex.props(dockStyles.cluster)}>
      <DockButton
        icon={Captions}
        label="Captions"
        showLabel="wide"
        tooltip={captions.shown ? "Hide captions on your screen" : "Show captions on your screen · what is said, over the meeting"}
        active={captions.shown}
        onClick={captions.onToggle}
      />
      <DockButton
        icon={MessageSquareText}
        label="Chat"
        showLabel
        tooltip={timelineTooltip}
        active={timeline.open}
        badge={timelineBadge}
        trailing={timeline.speechArriving ? <SpeechWave /> : undefined}
        onClick={timeline.onToggle}
      />
      {people && (
        <DockButton
          icon={Users}
          label="People"
          showLabel
          count={people.count}
          tooltip={people.open ? "Close the people list" : `People · ${people.count} in the meeting`}
          active={people.open}
          onClick={people.onToggle}
        />
      )}
      <MoreMenu
        record={
          recording && !recording.isRecording && !recording.recordingPending
            ? {
                disabledReason: recording.disabled
                  ? (recording.disabledReason ?? "Recording is unavailable")
                  : null,
                onStart: recording.onToggle,
              }
            : undefined
        }
        countdown={countdown}
        showGoLive={showStreamingControl && !isStreaming && !!onGoLive}
        goLiveDisabledReason={
          recording?.isRecording ? "Stop recording first" : streamingPending ? "Starting…" : null
        }
        onGoLive={onGoLive}
        isStreaming={showStreamingControl && isStreaming}
        streamingPending={streamingPending}
        onStopStream={onStopStream}
        onOpenCommands={onOpenCommands}
      />
      </div>

      <LeaveMenu pending={leavePending} onLeave={onLeave} onEndForEveryone={onEndForEveryone} />
    </Toolbar.Root>
  );
}
