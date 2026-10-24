import { BrandMark } from "@orbmeet/ui/react";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CameraOff,
  Mic,
  MicOff,
  Settings2,
  Sparkles,
  Video,
} from "lucide-react";
import { spinner as spinnerRing } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, live, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env, safeArea } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@orbmeet/ui/react";
import { Avatar } from "@orbmeet/ui/react";
import { BottomSheet } from "@orbmeet/ui/react";
import { ADMISSION_PENDING_TTL_MS } from "@/modules/meetings/contract/constants";
import { BackgroundEffectPicker } from "@/modules/meetings/client/components/background-effect-picker";
import { PreJoinDeviceForm, PreJoinDeviceNotice } from "@/modules/meetings/client/components/pre-join-device-form";
import { useRotationRepaintRef } from "@/modules/meetings/client/components/meeting-video-track";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import type { MeetingWaitingReason } from "@/modules/meetings/client/entry/join-outcome";
import { useNodeLatencyPrefetch } from "@/modules/meetings/client/entry/use-node-latency-prefetch";
import type { PreJoinSubmission } from "@/modules/meetings/client/types";
import { resolvePreJoinMediaEnabled, selectedDeviceLabel } from "@/modules/meetings/client/device-selection";
import { getPreviousSession } from "@/modules/meetings/server/history/previous-session.functions";
import {
  getDevicePickerPlaceholder,
  getToggleBlockedReason,
} from "@/modules/meetings/client/pre-join-device-status";
import { glass, inkWash } from "@orbmeet/ui/tokens/wash.stylex";
import {
  loadStoredMeetingDisplayName,
  saveStoredMeetingDisplayName,
} from "@/modules/meetings/client/display-name-storage";
import {
  loadSavedSpokenLanguage,
  pickSpeechLanguage,
  saveSpokenLanguage,
  SPEECH_LANGUAGE_OPTIONS,
  speechLanguageDisplayName,
} from "@/modules/meetings/client/captions/languages";
import { queryKeys } from "@/app/query-client/query-keys";
import {
  usePreJoinDevices,
  stopWarmupAudio as _stopWarmupAudio,
} from "@/modules/meetings/client/use-pre-join-devices";

export { _stopWarmupAudio as stopWarmupAudio };

const styles = stylex.create({
  /**
   * The doorway: one card on the room's own canvas. On a phone the card
   * dissolves into the page and the preview absorbs the slack, so the column
   * still fits exactly one viewport.
   */
  root: {
    position: "relative",
    display: "flex",
    minHeight: "100dvh",
    flexDirection: "column",
    alignItems: { default: "stretch", [bp.sm]: "center" },
    justifyContent: { default: "flex-start", [bp.sm]: "center" },
    overflowX: "hidden",
    backgroundColor: surface.canvas,
    fontFamily: "inherit",
    paddingTop: { default: `calc(${safeArea.top} + 0.75rem)`, [bp.sm]: space.s8 },
    paddingBottom: { default: `calc(${safeArea.bottom} + 0.75rem)`, [bp.sm]: space.s8 },
    paddingLeft: `calc(${safeArea.left} + 1rem)`,
    paddingRight: `calc(${safeArea.right} + 1rem)`,
  },
  /**
   * Where you are, before you are anywhere: the same mark and name the room's
   * top bar carries, at the same corner. It is also the way back out. On a
   * phone it is a short row above the column, and the preview gives up the
   * height, so the column still fits one viewport.
   */
  brand: {
    position: { default: "static", [bp.sm]: "absolute" },
    top: `calc(${safeArea.top} + ${space.s5})`,
    left: `calc(${safeArea.left} + ${space.s6})`,
    display: "flex",
    alignSelf: "flex-start",
    flexShrink: 0,
    minHeight: { default: 40, [bp.sm]: null },
    marginBottom: { default: space.s2, [bp.sm]: 0 },
    alignItems: "center",
    gap: space.s2,
    fontFamily: fonts.heading,
    fontSize: text.sm,
    fontWeight: weight.bold,
    letterSpacing: tracking.tight,
    color: ink.strong,
    textDecorationLine: "none",
  },

  /**
   * The doorway, in the room's language: one flat card with a hairline edge
   * and a contact shadow, not a slab lifted off the page.
   */
  card: {
    display: "flex",
    minHeight: 0,
    width: "100%",
    maxWidth: { default: null, [bp.sm]: "60rem" },
    flexGrow: { default: 1, [bp.sm]: 0 },
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: { default: "stretch", [bp.sm]: "center" },
    gap: { default: space.s4, [bp.sm]: space.s8 },
    borderRadius: { default: 0, [bp.sm]: radii.card },
    borderWidth: { default: 0, [bp.sm]: 1 },
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: { default: "transparent", [bp.sm]: surface.raised },
    padding: { default: 0, [bp.sm]: space.s6 },
    boxShadow: { default: "none", [bp.sm]: `0 1px 2px ${inkWash.x04}, 0 16px 40px -24px ${inkWash.x10}` },
  },

  /**
   * You, as the room will see you — built like a room tile, so the preview
   * and the tile you appear in a second later are the same object: black
   * under a live camera, the light avatar ground when it is off, the same
   * hairline edge either way.
   */
  preview: {
    position: "relative",
    minHeight: 260,
    flexGrow: { default: 1, [bp.sm]: 0 },
    flexShrink: 0,
    flexBasis: { default: null, [bp.sm]: "54%" },
    overflow: "hidden",
    borderRadius: radii.control,
    backgroundColor: neutral.n900,
    aspectRatio: { default: null, [bp.sm]: "16 / 11" },
  },
  /** The tile's edge, drawn over its contents so video cannot cover it. */
  previewEdge: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    borderRadius: "inherit",
    boxShadow: `inset 0 0 0 1px ${inkWash.x08}`,
  },
  /** The room's name plate: a small dark glass chip that reads over any feed. */
  previewName: {
    position: "absolute",
    top: space.s3,
    left: space.s3,
    maxWidth: "calc(100% - 1.5rem)",
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 52%, transparent)`,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: ink.onDark,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ink.onDark} 10%, transparent)`,
    backdropFilter: "blur(12px)",
  },
  /**
   * The video and the camera-off portrait are pinned to the preview's edges:
   * on a phone the preview's height comes from flex, so a child measuring
   * `height: 100%` against it would fall back to its own intrinsic size.
   */
  previewFill: { position: "absolute", inset: 0 },
  cameraOff: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
    paddingBottom: space.s12,
    // The room's camera-off tile: white falling off to the faintest grey.
    backgroundColor: surface.raised,
    backgroundImage: `radial-gradient(120% 90% at 50% 0%, ${surface.raised} 40%, ${neutral.n50})`,
  },
  cameraOffAvatar: { width: 88, height: 88, fontSize: text.xl2, boxShadow: `0 0 0 4px ${surface.raised}, 0 0 0 5px ${neutral.n150}` },
  cameraOffLabel: { margin: 0, fontSize: text.sm, fontWeight: weight.medium, color: neutral.n500 },

  bgError: {
    position: "absolute",
    insetInline: space.s3,
    top: space.s12,
    borderRadius: radii.control,
    backgroundColor: glass.opaque,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: danger.d700,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },

  /**
   * Mic, camera and effects as one object over the preview, so they read as
   * acting on it: a dark glass capsule, the one ground that holds up over a
   * live camera and the light camera-off tile alike.
   */
  avBand: {
    position: "absolute",
    insetInline: 0,
    bottom: space.s4,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  avCapsule: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.card,
    padding: space.s1,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 55%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ink.onDark} 10%, transparent), 0 8px 24px -8px ${inkWash.x12}`,
    backdropFilter: "blur(16px) saturate(1.2)",
    pointerEvents: "auto",
  },
  bgSlot: { position: "relative" },
  bgPopover: {
    position: "absolute",
    bottom: "100%",
    left: "50%",
    zIndex: 50,
    marginBottom: space.s2,
    transform: "translateX(-50%)",
  },
  bgPopoverCard: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    boxShadow: `0 20px 25px -5px ${inkWash.x10}, 0 8px 10px -6px ${inkWash.x10}`,
  },

  // It grows across the row beside the preview; down a phone, the preview takes the slack.
  aside: { display: "flex", minWidth: 0, flexGrow: { default: 0, [bp.sm]: 1 }, flexDirection: "column" },
  eyebrow: { margin: 0, fontSize: text.xs, fontWeight: weight.semibold, color: accent.a700 },
  heading: {
    margin: 0,
    marginTop: space.s1,
    fontFamily: fonts.heading,
    fontSize: { default: "1.75rem", [bp.sm]: "2.25rem" },
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  meta: {
    margin: 0,
    marginTop: space.s2_5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: space.s1,
    fontSize: text.sm,
    color: neutral.n500,
  },
  /** The code, set as the room sets its clock: a mono readout in a hairline chip. */
  code: {
    display: "inline-flex",
    height: 22,
    alignItems: "center",
    borderRadius: radii.field,
    paddingInline: space.s1_5,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs2,
    letterSpacing: tracking.wide,
    color: neutral.n600,
    backgroundColor: neutral.n50,
    boxShadow: `inset 0 0 0 1px ${neutral.n150}`,
  },
  /** Whether the room is live: green while it is, amber while it is not open, grey otherwise. */
  status: { display: "inline-flex", alignItems: "center", gap: space.s1_5 },
  statusDot: { height: 7, width: 7, flexShrink: 0, borderRadius: radii.pill, backgroundColor: neutral.n300 },
  statusLive: { backgroundColor: live.l500, boxShadow: `0 0 0 3px color-mix(in oklab, ${live.l500} 18%, transparent)` },
  statusClosed: { backgroundColor: warning.w500 },
  dot: { height: 3, width: 3, borderRadius: radii.pill, backgroundColor: neutral.n300 },

  /** What happened last time, so walking back in is a return, not a restart. */
  previous: {
    marginTop: space.s5,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: neutral.n50,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  previousHead: {
    margin: 0,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
    color: neutral.n500,
  },
  previousBody: { margin: 0, marginTop: space.s1_5, fontSize: text.sm, lineHeight: 1.55, color: neutral.n700 },
  previousLink: {
    marginTop: space.s2,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "none",
  },

  fieldLabel: {
    display: "block",
    marginTop: space.s5,
    marginBottom: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n700,
  },
  nameInput: {
    height: 46,
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.base,
    color: neutral.n900,
    outlineStyle: "none",
    "::placeholder": { color: neutral.n400 },
  },
  nameInputOk: {
    borderColor: { default: neutral.n200, ":focus-visible": accent.a500 },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)` },
  },
  nameInputError: {
    borderColor: { default: danger.d400, ":focus-visible": danger.d400 },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px color-mix(in oklab, ${danger.d400} 20%, transparent)` },
  },
  nameError: { marginTop: space.s1_5, marginBottom: 0, fontSize: text.xs, color: danger.d600 },

  /**
   * The devices, as one sentence you can open. The pickers are real but rarely
   * changed, so they wait behind the summary instead of standing between you
   * and the door.
   */
  devices: {
    marginTop: space.s4,
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n150, [env.hoverable]: { default: neutral.n150, ":hover": neutral.n200 } },
    backgroundColor: { default: neutral.n50, [env.hoverable]: { default: neutral.n50, ":hover": surface.raised } },
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    textAlign: "start",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  devicesInline: { display: { default: "none", [bp.sm]: "flex" } },
  devicesSheet: { display: { default: "flex", [bp.sm]: "none" } },
  devicesText: { minWidth: 0, flexGrow: 1, fontSize: text.xs, lineHeight: 1.5, color: neutral.n600 },
  devicesAction: { flexShrink: 0, fontSize: text.xs, fontWeight: weight.semibold, color: accent.a700 },
  devicesIcon: { flexShrink: 0, color: neutral.n400 },
  inlineDevices: { marginTop: space.s4, display: { default: "none", [bp.sm]: "block" } },
  notice: { marginTop: space.s3 },

  /** Amber, not red: waiting is expected, not broken. */
  waiting: {
    marginTop: space.s5,
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  waitingTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.medium, color: warning.w900 },
  waitingCopy: { margin: 0, fontSize: text.xs, color: warning.w700 },
  waitingBody: { minWidth: 0 },
  waitingSpinner: { borderColor: warning.w300, borderTopColor: warning.w600 },

  joinButton: { marginTop: space.s5, height: 48, width: "100%" },
  joinLabel: { display: "flex", alignItems: "center", gap: space.s2 },
  joinConsequence: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: 1.5,
    textAlign: "center",
    color: warning.w800,
  },
  /** The privacy disclosure, at the moment of the decision it is about. */
  /**
   * Where your voice goes, said at the moment you decide to join — as a card
   * with Orb's mark, not fine print, because it is the one thing here you
   * might want to say no to.
   */
  fine: {
    display: "flex",
    gap: space.s3,
    marginTop: space.s4,
    padding: space.s4,
    borderRadius: 14,
    backgroundColor: accent.a50,
  },
  fineBody: { display: "flex", flexDirection: "column", gap: space.s1, minWidth: 0 },
  fineTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  fineText: { margin: 0, fontSize: "0.8125rem", lineHeight: 1.5, color: ink.muted },

  sheetBody: {
    height: "100%",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingInline: space.s4,
    paddingBottom: space.s4,
  },

  /**
   * A 44pt AV toggle inside the capsule. Off is a red *tint*, as it is in the
   * room's top bar: filled red belongs to leaving, and "my mic is off" should
   * look the same on the way in as it does once you are there.
   */
  previewToggle: {
    display: "flex",
    height: 44,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    transform: { default: null, ":active:not(:disabled)": "scale(0.94)" },
    transitionProperty: "transform, background-color, color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  previewOn: {
    color: ink.onDark,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": `color-mix(in oklab, ${ink.onDark} 14%, transparent)` },
    },
  },
  // White on a strong red tint: legible over a live feed and the light
  // camera-off ground alike, and still a tint rather than Leave's solid fill.
  previewOff: {
    color: ink.onDark,
    backgroundColor: {
      default: `color-mix(in oklab, ${danger.d500} 60%, transparent)`,
      [env.hoverable]: {
        default: `color-mix(in oklab, ${danger.d500} 60%, transparent)`,
        ":hover": `color-mix(in oklab, ${danger.d500} 72%, transparent)`,
      },
    },
  },
  previewAccentOn: { backgroundColor: `color-mix(in oklab, ${accent.a500} 55%, transparent)`, color: ink.onDark },
  previewAccentOff: {
    color: `color-mix(in oklab, ${ink.onDark} 80%, transparent)`,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": `color-mix(in oklab, ${ink.onDark} 14%, transparent)` },
    },
  },
  previewToggleDisabled: { cursor: "not-allowed", opacity: 0.5 },
  /** The rule between your devices and the effect applied to them. */
  avRule: { height: 22, width: 1, marginInline: 2, backgroundColor: `color-mix(in oklab, ${ink.onDark} 18%, transparent)` },
});

export interface PreJoinScreenProps {
  meetingCode?: string;
  meetingTitle?: string;
  spaceName?: string | null;
  /** Whose personal room this is, for a meeting with neither title nor Space. */
  hostName?: string | null;
  waitingForHost?: boolean;
  waitingReason?: MeetingWaitingReason | null;
  waitingRequestId?: string | null;
  /** True when no occurrence is currently open for this link. */
  noOpenMeeting?: boolean;
  /** Whether this principal is allowed to open the occurrence. */
  canStartMeeting?: boolean;
  /**
   * Whether you are in this meeting right now on another tab or device.
   * Joining here moves you, and the screen says so before you press it.
   */
  alreadyInMeeting?: boolean;
  scheduledStartsAt?: string | null;
  scheduledTimeZone?: string | null;
  scheduledNotOpenYet?: boolean;
  /** True once the user clicked join and the admission request is in flight. */
  isJoining?: boolean;
  /** Authenticated user — name is pre-filled and locked (non-editable). */
  user?: { name: string };
  onJoin: (submission: PreJoinSubmission) => void;
  /** Device changes made while waiting to be admitted. */
  onWaitingSettingsChange?: (submission: PreJoinSubmission) => void;
}

/**
 * The screen between "I have a link" and "I am in the meeting".
 *
 * On a phone this has to fit in one viewport. The previous version could not:
 * it nested `min-h-[calc(100dvh-56px)]` inside a `min-h-[100dvh]` parent *below*
 * a header, which made the page taller than the screen by construction — on
 * every device — and then centred content that was already overflowing, so the
 * camera preview was scrolled out of reach before you ever saw it.
 *
 * The layout here is a viewport-minimum column instead: header and footer take
 * what they need and the preview absorbs the slack at normal text sizes. If
 * browser zoom or large accessibility text makes the controls taller than the
 * viewport, the document can scroll instead of clipping the join action. That forces a
 * useful editorial decision — only the three things you actually decide before
 * joining stay on screen (your name, camera on/off, mic on/off, and the join
 * button). Device pickers are real but secondary, so on phones they move into a
 * settings sheet; from `sm:` up there is room for them beside the preview and
 * they are shown inline.
 *
 * One tree, switched by CSS rather than by a JS breakpoint, so there is no
 * first-paint flash between layouts.
 */
/* oxlint-disable react/immutability, react/refs -- oxlint 1.85 still reports the device controller's refs inside an explicitly opted-out component. */
export function PreJoinScreen({
  meetingCode,
  meetingTitle,
  spaceName,
  hostName = null,
  waitingForHost = false,
  waitingReason = null,
  waitingRequestId = null,
  noOpenMeeting = false,
  canStartMeeting = false,
  alreadyInMeeting = false,
  scheduledStartsAt = null,
  scheduledTimeZone = null,
  scheduledNotOpenYet = false,
  isJoining = false,
  user,
  onJoin,
  onWaitingSettingsChange,
}: PreJoinScreenProps) {
  const devices = usePreJoinDevices();
  useNodeLatencyPrefetch();
  // Read out before use: a value handed to a JSX `ref` makes React Compiler
  // treat the object it came from as a ref, which would bail out this screen.
  const { previewVideo, bgPicker } = devices;
  const rotationRepaintRef = useRotationRepaintRef();
  const previewVideoRef = React.useCallback(
    (el: HTMLVideoElement | null) => {
      previewVideo(el);
      const cleanup = rotationRepaintRef(el);
      // Returning a cleanup means React never calls this ref with null, so the
      // detach is reported to the device hook here.
      return () => {
        if (typeof cleanup === "function") cleanup();
        previewVideo(null);
      };
    },
    [previewVideo, rotationRepaintRef],
  );

  const userName = user?.name;
  const [captionLanguage, setCaptionLanguage] = React.useState(() =>
    pickSpeechLanguage({
      savedLanguage: loadSavedSpokenLanguage(),
      navigatorLanguage: typeof navigator === "undefined" ? null : navigator.language,
    }),
  );
  const [displayName, setDisplayName] = React.useState(userName ?? "");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showDevices, setShowDevices] = React.useState(false);
  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const submissionLockedRef = React.useRef(false);

  React.useEffect(() => {
    if (userName) {
      setDisplayName(userName);
      return;
    }
    setDisplayName(loadStoredMeetingDisplayName() || "");
  }, [userName]);

  React.useEffect(() => {
    saveSpokenLanguage(captionLanguage);
  }, [captionLanguage]);

  const handleJoin = () => {
    // This is a synchronous ownership gate, not just button styling. React can
    // receive multiple key events before the parent has rendered `isJoining`;
    // only the first event is allowed to create a server-side join attempt.
    if (
      submissionLockedRef.current ||
      isJoining ||
      waitingForHost ||
      scheduledNotOpenYet ||
      devices.isLoadingDevices
    ) {
      return;
    }
    if (!user && !displayName.trim()) {
      setNameError("Please enter your name to join");
      nameInputRef.current?.focus();
      return;
    }

    const submission = buildSubmission();
    if (!submission) return;

    submissionLockedRef.current = true;
    if (!user && submission.displayName) saveStoredMeetingDisplayName(submission.displayName);
    onJoin(submission);
  };

  // What Join submits, or null while a device verdict is still pending. The
  // camera preview deliberately stays open after Join: this screen stays
  // mounted while the participant waits to be admitted, and unmounting it is
  // what hands the camera to the room.
  function buildSubmission(): PreJoinSubmission | null {
    const isSecureContext = typeof window === "undefined" || window.isSecureContext;
    const allowMedia = isSecureContext && !!navigator.mediaDevices;
    const videoDecision = resolvePreJoinMediaEnabled({
      isLoadingDevices: devices.isLoadingDevices,
      desiredEnabled: allowMedia && devices.videoEnabled,
      available: devices.videoAvailable,
    });
    const audioDecision = resolvePreJoinMediaEnabled({
      isLoadingDevices: devices.isLoadingDevices,
      desiredEnabled: allowMedia && devices.audioEnabled,
      available: devices.audioAvailable,
    });
    if (videoDecision === null || audioDecision === null) return null;

    const trimmedName = user ? user.name : displayName.trim();
    return {
      // The device choice travels independently of the on/off decision: it
      // seeds RoomOptions capture defaults and the in-meeting device pickers,
      // so someone who picks a microphone and then joins muted still unmutes
      // onto that microphone. publishInitialMeetingMedia drops the constraints
      // for whichever track starts disabled.
      videoDeviceId: devices.effectiveVideoDeviceId,
      audioDeviceId: devices.effectiveAudioDeviceId,
      audioOutputDeviceId: devices.selectedAudioOutputDevice,
      videoEnabled: videoDecision,
      audioEnabled: audioDecision,
      displayName: trimmedName || undefined,
      captionLanguage,
      bgMode: devices.bgMode,
      bgImagePath: devices.bgImagePath,
    };
  }

  // Admission publishes what the lobby shows when it happens, so every change
  // made while waiting replaces the settings captured by Join.
  const waitingSubmission = waitingForHost ? buildSubmission() : null;
  const waitingSubmissionKey = waitingSubmission ? JSON.stringify(waitingSubmission) : null;
  React.useEffect(() => {
    if (waitingSubmissionKey === null) return;
    onWaitingSettingsChange?.(JSON.parse(waitingSubmissionKey) as PreJoinSubmission);
  }, [onWaitingSettingsChange, waitingSubmissionKey]);

  const cameraBlockedReason = getToggleBlockedReason("camera", devices.cameraStatus);
  const microphoneBlockedReason = getToggleBlockedReason("microphone", devices.microphoneStatus);

  const cameraPreviewLabel = devices.isLoadingDevices
    ? "Looking for camera…"
    : !devices.videoAvailable
      ? getDevicePickerPlaceholder("camera", devices.cameraStatus)
      : devices.videoEnabled
        ? "Starting camera…"
        : "Camera is off";

  const [approvalCountdown, setApprovalCountdown] = React.useState(ADMISSION_PENDING_TTL_MS);
  const approvalStartRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (waitingReason !== "approval") {
      approvalStartRef.current = null;
      setApprovalCountdown(ADMISSION_PENDING_TTL_MS);
      return;
    }
    // This effect only restarts when the reason or server-issued admission id
    // changes, so a renewed approval lease gets its own full countdown.
    approvalStartRef.current = Date.now();
    const start = approvalStartRef.current;
    const tick = () =>
      setApprovalCountdown(Math.max(0, ADMISSION_PENDING_TTL_MS - (Date.now() - start)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [waitingReason, waitingRequestId]);

  const countdownText = `${Math.floor(approvalCountdown / 60_000)}:${String(
    Math.floor((approvalCountdown % 60_000) / 1000),
  ).padStart(2, "0")}`;

  const scheduledTimeLabel = React.useMemo(() => {
    if (!scheduledStartsAt) return null;
    const startsAt = new Date(scheduledStartsAt);
    if (Number.isNaN(startsAt.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(scheduledTimeZone ? { timeZone: scheduledTimeZone } : {}),
    }).format(startsAt);
  }, [scheduledStartsAt, scheduledTimeZone]);

  const joinLabel = scheduledNotOpenYet
    ? "Not open yet"
    : devices.isLoadingDevices
      ? "Checking devices"
      : isJoining
        ? alreadyInMeeting
          ? "Moving here"
          : canStartMeeting
            ? "Starting meeting"
            : "Joining"
        : alreadyInMeeting
          ? "Move the meeting here"
          : canStartMeeting
            ? "Start meeting"
            : "Join meeting";

  const shownName = (user ? user.name : displayName.trim()) || "Guest";
  // The most human name this room has — its title, its Space, whose room it
  // is — and the Space it belongs to when that is a different name.
  const heading =
    meetingTitle ||
    spaceName ||
    (hostName && user?.name === hostName
      ? "Your meeting"
      : hostName
        ? `${hostName}\u2019s meeting`
        : "Ready to join?");
  const eyebrow = spaceName && spaceName !== heading ? spaceName : null;
  const status = scheduledNotOpenYet
    ? `Opens 15 minutes before ${scheduledTimeLabel ?? "it starts"}`
    : noOpenMeeting
      ? canStartMeeting
        ? "Not started yet. Joining starts it."
        : "Not started yet. You'll wait here for the host."
      : alreadyInMeeting
        ? "You’re in this meeting on another tab or device"
        : "In progress";
  const statusTone: "live" | "closed" | "idle" = scheduledNotOpenYet
    ? "closed"
    : noOpenMeeting
      ? "idle"
      : "live";
  const languageOption = SPEECH_LANGUAGE_OPTIONS.find((option) => option.tag === captionLanguage);
  const deviceSummary = [
    devices.audioEnabled
      ? selectedDeviceLabel(devices.audioDevices, devices.effectiveAudioDeviceId, "microphone")
      : "Microphone off",
    devices.videoEnabled
      ? selectedDeviceLabel(devices.videoDevices, devices.effectiveVideoDeviceId, "camera")
      : "Camera off",
    `Captions in ${languageOption ? speechLanguageDisplayName(languageOption) : captionLanguage}`,
  ].join(" · ");

  const previous = useQuery({
    queryKey: queryKeys.meetings.previousSession(meetingCode),
    queryFn: () => getPreviousSession({ data: { code: meetingCode! } }),
    enabled: Boolean(meetingCode && user),
    staleTime: 60_000,
  }).data;

  return (
    <div {...stylex.props(styles.root)}>
      <a href="/" {...stylex.props(focus.ring, styles.brand)}>
        <BrandMark size={24} />
        Orb Meet
      </a>
      <main {...stylex.props(styles.card)}>
        {/* You, as the room will see you. */}
        <div {...stylex.props(styles.preview)}>
          {devices.videoEnabled && devices.localVideoTrack ? (
            <video
              ref={previewVideoRef}
              autoPlay
              playsInline
              muted
              {...stylex.props(videoTrack.fill, videoTrack.mirrored, styles.previewFill)}
            />
          ) : (
            <div {...stylex.props(styles.cameraOff, styles.previewFill)}>
              <Avatar name={shownName} size="xl" sx={styles.cameraOffAvatar} />
              <p {...stylex.props(styles.cameraOffLabel)}>{cameraPreviewLabel}</p>
            </div>
          )}
          <span aria-hidden="true" {...stylex.props(styles.previewEdge)} />
          <span {...stylex.props(styles.previewName, layout.truncate)}>{shownName}</span>

          {devices.bgError && (
            <div {...stylex.props(styles.bgError)}>
              Background effect failed: {devices.bgError}
            </div>
          )}

          <div {...stylex.props(styles.avBand)}>
            <div role="group" aria-label="Your camera and microphone" {...stylex.props(styles.avCapsule)}>
            <PreviewToggle
              on={devices.audioEnabled}
              onClick={devices.onAudioToggle}
              onIcon={Mic}
              offIcon={MicOff}
              label={devices.audioEnabled ? "Mute microphone" : "Unmute microphone"}
              blockedReason={microphoneBlockedReason}
            />
            <PreviewToggle
              on={devices.videoEnabled}
              onClick={devices.onVideoToggle}
              onIcon={Video}
              offIcon={CameraOff}
              label={devices.videoEnabled ? "Turn off camera" : "Turn on camera"}
              blockedReason={cameraBlockedReason}
            />
            {devices.videoEnabled && <span aria-hidden="true" {...stylex.props(styles.avRule)} />}
            {devices.videoEnabled && (
              <div ref={bgPicker} {...stylex.props(styles.bgSlot)}>
                <PreviewToggle
                  on={devices.bgMode !== "none"}
                  accent
                  disabled={devices.bgProcessing}
                  onClick={devices.onBgPickerToggle}
                  onIcon={Sparkles}
                  offIcon={Sparkles}
                  label="Background effects"
                />
                {devices.showBgPicker && (
                  <div {...stylex.props(styles.bgPopover)}>
                    <div {...stylex.props(styles.bgPopoverCard)}>
                      <BackgroundEffectPicker
                        mode={devices.bgMode}
                        imagePath={devices.bgImagePath}
                        isProcessing={devices.bgProcessing}
                        variant="light"
                        onSelectNone={devices.onBgNone}
                        onSelectBlur={devices.onBgBlur}
                        onSelectImage={devices.onBgImage}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            </div>
          </div>
        </div>

        <div {...stylex.props(styles.aside)}>
          {eyebrow && <p {...stylex.props(styles.eyebrow, layout.truncate)}>{eyebrow}</p>}
          <h1 {...stylex.props(styles.heading)}>{heading}</h1>
          <p {...stylex.props(styles.meta)}>
            {meetingCode && <span {...stylex.props(styles.code)}>{meetingCode}</span>}
            <span {...stylex.props(styles.status)}>
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.statusDot,
                  statusTone === "live" && styles.statusLive,
                  statusTone === "closed" && styles.statusClosed,
                )}
              />
              {status}
            </span>
            {scheduledTimeLabel && !scheduledNotOpenYet && (
              <>
                <span aria-hidden="true" {...stylex.props(styles.dot)} />
                <span>{scheduledTimeLabel}</span>
              </>
            )}
          </p>

          {previous && (
            <section aria-label="Last session" {...stylex.props(styles.previous)}>
              <p {...stylex.props(styles.previousHead)}>
                Last session · {formatPreviousDate(previous.endedAt)}
                {previous.durationSeconds ? ` · ${Math.max(1, Math.round(previous.durationSeconds / 60))} min` : ""}
              </p>
              <p {...stylex.props(styles.previousBody)}>
                {previous.excerpt ?? "Its summary is still being written."}
              </p>
              <a
                href={`/meetings/${previous.meetingId}`}
                target="_blank"
                rel="noreferrer"
                {...stylex.props(focus.ring, styles.previousLink)}
              >
                Open the record
                <ArrowUpRight size={13} />
              </a>
            </section>
          )}

          {!user && (
            <>
              <label htmlFor="prejoin-name" {...stylex.props(styles.fieldLabel)}>
                Your name
              </label>
              <input
                ref={nameInputRef}
                id="prejoin-name"
                type="text"
                maxLength={100}
                autoComplete="name"
                enterKeyHint="go"
                placeholder="How should people know you?"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleJoin();
                  }
                }}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "prejoin-name-error" : undefined}
                {...stylex.props(
                  styles.nameInput,
                  motion.tint,
                  nameError ? styles.nameInputError : styles.nameInputOk,
                )}
              />
              {nameError && (
                <p id="prejoin-name-error" role="alert" {...stylex.props(styles.nameError)}>
                  {nameError}
                </p>
              )}
            </>
          )}

          {/* One sentence for the devices; the pickers open beside it on a
              tablet or desktop, and in a sheet on a phone. */}
          <button
            type="button"
            aria-expanded={showDevices}
            aria-controls="prejoin-inline-devices"
            onClick={() => setShowDevices((open) => !open)}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.devices, styles.devicesInline)}
          >
            <Settings2 size={16} {...stylex.props(styles.devicesIcon)} />
            <span {...stylex.props(styles.devicesText)}>{deviceSummary}</span>
            <span {...stylex.props(styles.devicesAction)}>{showDevices ? "Done" : "Change"}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.devices, styles.devicesSheet)}
          >
            <Settings2 size={16} {...stylex.props(styles.devicesIcon)} />
            <span {...stylex.props(styles.devicesText)}>{deviceSummary}</span>
            <span {...stylex.props(styles.devicesAction)}>Change</span>
          </button>
          {showDevices ? (
            <div id="prejoin-inline-devices" {...stylex.props(styles.inlineDevices)}>
              <PreJoinDeviceForm
                devices={devices}
                captionLanguage={captionLanguage}
                onCaptionLanguageChange={setCaptionLanguage}
                idPrefix="prejoin-inline"
              />
            </div>
          ) : (
            // A device problem is never folded away with the pickers.
            <div {...stylex.props(styles.notice)}>
              <PreJoinDeviceNotice devices={devices} />
            </div>
          )}

          {waitingForHost ? (
            <div {...stylex.props(styles.waiting)} role="status" aria-live="polite">
              <div {...stylex.props(spinnerRing.ring, spinnerRing.md, styles.waitingSpinner)} />
              <div {...stylex.props(styles.waitingBody)}>
                <p {...stylex.props(styles.waitingTitle)}>
                  {waitingReason === "approval" ? "Waiting for approval" : "Waiting for host"}
                </p>
                <p {...stylex.props(styles.waitingCopy)}>
                  {waitingReason === "approval"
                    ? `You'll join automatically when the host admits you (${countdownText})`
                    : "You'll join automatically when the host starts"}
                </p>
              </div>
            </div>
          ) : (
            <Button
              variant="primary"
              size="lg"
              onClick={handleJoin}
              loading={isJoining}
              disabled={devices.isLoadingDevices || scheduledNotOpenYet}
              sx={styles.joinButton}
            >
              <span {...stylex.props(styles.joinLabel)}>{joinLabel}</span>
            </Button>
          )}

          {/* The consequence, at the moment of the decision. */}
          {alreadyInMeeting && !waitingReason && (
            <p {...stylex.props(styles.joinConsequence)}>
              Your mic, camera and board move to this screen, and the other one steps out of the
              call. You can bring it back from there.
            </p>
          )}
          {!waitingReason && devices.joinsSilent && !devices.isLoadingDevices && (
            <p {...stylex.props(styles.joinConsequence)}>
              You&rsquo;ll join muted — no one will hear you until your microphone works.
            </p>
          )}
          <div {...stylex.props(styles.fine)}>
            <BrandMark size={20} />
            <div {...stylex.props(styles.fineBody)}>
              <p {...stylex.props(styles.fineTitle)}>Orb only listens while transcription is on</p>
              <p {...stylex.props(styles.fineText)}>
                Then your mic&rsquo;s audio goes to Deepgram for live captions, the transcript and the
                summary. A host can turn transcription off, and anyone can ask them to.
              </p>
            </div>
          </div>
        </div>
      </main>

      <BottomSheet
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="Camera, microphone & captions"
      >
        <div {...stylex.props(styles.sheetBody)}>
          <PreJoinDeviceForm
            devices={devices}
            captionLanguage={captionLanguage}
            onCaptionLanguageChange={setCaptionLanguage}
            idPrefix="prejoin-sheet"
          />
        </div>
      </BottomSheet>
    </div>
  );
}
/* oxlint-enable react/immutability, react/refs */

function formatPreviousDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(date);
}

function PreviewToggle({
  on,
  accent: accentTone,
  disabled,
  onClick,
  onIcon: OnIcon,
  offIcon: OffIcon,
  label,
  blockedReason,
}: {
  on: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onIcon: React.ElementType;
  offIcon: React.ElementType;
  label: string;
  /**
   * Why this kind cannot be turned on right now. The button stays enabled —
   * activating it re-probes, which is exactly what someone who just fixed a
   * permission wants — but it must say so. Left unexplained, a click that
   * cannot flip `aria-pressed` reads as a broken control, and that is the
   * single most-reported symptom of a blocked microphone.
   */
  blockedReason?: string | null;
}) {
  const Icon = on ? OnIcon : OffIcon;
  const describedById = React.useId();
  const accessibleLabel = blockedReason ? `${label} (unavailable)` : label;
  return (
    <>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-pressed={on}
      aria-describedby={blockedReason ? describedById : undefined}
      title={blockedReason ? `${label} — ${blockedReason}` : label}
      {...stylex.props(
        pressable.base,
        focus.ring,
        styles.previewToggle,
        accentTone
          ? on
            ? styles.previewAccentOn
            : styles.previewAccentOff
          : on
            ? styles.previewOn
            : styles.previewOff,
        disabled && styles.previewToggleDisabled,
      )}
    >
      <Icon size={20} />
    </button>
    {blockedReason && (
      <span id={describedById} {...stylex.props(layout.srOnly)}>
        {`${blockedReason} Activating this retries.`}
      </span>
    )}
    </>
  );
}
