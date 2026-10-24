import * as React from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import type { Room } from "livekit-client";
import { BottomSheet, useToast } from "@orbmeet/ui/react";
import { progress } from "@orbmeet/ui/styles/animations";
import { layout, stack } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { inStage, onBoard } from "@orbmeet/ui/styles/stage";
import { SIDE_PANEL_WIDTH, sidePanel } from "@/modules/meetings/client/meeting-styles";
import { accent, ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { stage as stageVars } from "@orbmeet/ui/tokens/stage.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { MEETING_DOCK_SELECTOR, MeetingShell } from "./meeting-shell";
import { MeetingTopBar } from "./meeting-top-bar";
import { type HostPermissionRequest, type LiveMeetingState } from "@/modules/meetings/client/use-live-meeting";
import { selectComposition } from "@/modules/meetings/client/select-composition";
import { selectContentPanel, selectRoomLayout, type MeetingSideColumnTab } from "@/modules/meetings/client/room-layout";
import { useContentPanel } from "@/modules/meetings/client/use-content-panel";
import { MeetingPhoneHeader } from "./meeting-phone-header";
import { CHROME_GAP_PX, PHONE_DOCK_CLEARANCE_PX, PHONE_RAIL_WIDTH_PX } from "@/modules/meetings/client/chrome";
import { HostPermissionDock } from "./host-permission-dock";
import { ParticipantPermissionBanner } from "./participant-permission-banner";
import { MicrophoneInterruptedBanner } from "./microphone-interrupted-banner";
import { SurfaceUnavailableOverlay } from "./surface-unavailable-overlay";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";
import { SharedTimerChip } from "./shared-timer-chip";
import type {
  PhoneStageModes,
  SharedScreenControls,
  SurfaceToolbarControls,
} from "@/modules/meetings/client/components/dock-controls";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { useMeetingCommandPalette } from "@/modules/meetings/client/use-meeting-command-palette";
import { commandPaletteShortcutLabel } from "@/modules/meetings/client/meeting-command-shortcut";
import { mediaControlsAvailability } from "@/modules/meetings/client/media-controls";
import { useDelayedFlag } from "@/lib/hooks/use-delayed-flag";
import type { MeetingCommandInput } from "@/modules/meetings/client/meeting-commands";
import { useParticipantTileActions, type ParticipantManagement } from "./participant-actions";
import { ESSENTIAL_MEETING_UI, SECONDARY_MEETING_UI } from "./meeting-ui-modules";
import { CATCH_UP_QUESTION, ORB_NAME, recentlySaid, type MeetingAssistant } from "@/modules/meetings/client/orb";
import { useTimelineThreads } from "@/modules/meetings/client/use-timeline-threads";
import { useOpenOnRoomQuestion } from "@/modules/meetings/client/use-open-on-room-question";

const styles = stylex.create({
  room: { backgroundColor: surface.canvas },
  fillBox: { width: "100%", height: "100%" },
  notice: {
    position: "absolute",
    insetInline: 0,
    zIndex: zIndex.meetingBar,
    width: "fit-content",
    maxWidth: "calc(100% - 2rem)",
    marginInline: "auto",
    borderRadius: radii.pill,
    backgroundColor: `color-mix(in oklab, ${warning.w500} 95%, transparent)`,
    paddingInline: space.s4,
    paddingBlock: space.s2,
    textAlign: "center",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: ink.onDark,
    boxShadow: shadows.card,
  },
  noticeBelowHeader: { top: "4.5rem" },
  connectingOverlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: zIndex.modal,
    backgroundColor: `color-mix(in oklab, ${surface.canvas} 95%, transparent)`,
  },
  connectingCard: {
    borderRadius: radii.panel,
    paddingInline: space.s12,
    paddingBlock: space.s9,
    textAlign: "center",
  },
  spinner: {
    width: 36,
    height: 36,
    marginInline: "auto",
    marginBottom: space.s4,
    borderWidth: 2.5,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    borderTopColor: `color-mix(in oklab, ${accent.a700} 80%, transparent)`,
    borderRadius: radii.pill,
  },
  connectingLabel: { margin: 0, fontWeight: weight.medium, color: neutral.n600 },
  surfaceBackdrop: {
    backgroundColor: surface.board,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: "500ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  shown: { opacity: 1 },
  stage: { position: "absolute", overflow: "hidden" },
  participantLayout: { display: "flex" },
  participantColumn: { flexDirection: "column" },
  contentRow: { display: "flex", minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  /** Talk's stage over a docked panel: what the panel leaves. */
  talkStage: { position: "relative", minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  /** The folded Conversation over Talk's stage: centred, above its bottom edge. */
  stageCaption: {
    position: "absolute",
    insetInline: 0,
    bottom: space.s5,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  /** On the board: centred under its top band (`WHITEBOARD_CONTROLS_BAND_PX`). */
  boardCaption: {
    position: "absolute",
    top: 60,
    insetInline: 0,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  landscapeIdentity: {
    position: "absolute",
    left: `calc(${stageVars.left} + 0.5rem)`,
    zIndex: zIndex.meetingPanel,
    maxWidth: "40%",
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${surface.raised} 90%, transparent)`,
    paddingInline: space.s2,
    paddingBlock: space.s1,
    pointerEvents: "none",
  },
  landscapeTitle: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  /** A phone's card, just above its controls: the stage's bottom edge is the dock's top. */
  phoneCaption: {
    position: "absolute",
    left: space.s3,
    right: `calc(${stageVars.panel} + 0.75rem)`,
    bottom: `calc(${stageVars.bottom} + 0.75rem)`,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    pointerEvents: "none",
  },
  /** The bar's leading end: who and where, then the room's countdown while one runs. */
  identityRow: { display: "flex", minWidth: 0, alignItems: "center", gap: space.s3 },
  /**
   * Under an upright board: the faces across, then on a phone the
   * Conversation's newest line, both in the height the short page leaves.
   */
  contentFoot: { display: "flex", flexShrink: 0, flexDirection: "column", gap: space.s2 },
  /** A phone's board runs edge to edge; its foot keeps off the edges and the dock. */
  contentFootPhone: { padding: space.s2 },
  /** A tablet's board is a card; its foot lines up with the card's edges. */
  contentFootCard: { paddingInline: space.s3, paddingBottom: space.s3 },
  surfaceCell: {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    overflow: "hidden",
    backgroundColor: surface.board,
  },
  /**
   * Off a phone the content is a card on the room's ground, inset by the
   * room's gutter (`space.s4`) like the side panel beside it, rather than a desk running
   * to the window's edges. A phone keeps every pixel.
   */
  surfaceCard: {
    marginTop: space.s3,
    marginInline: space.s3,
    marginBottom: space.s3,
    borderRadius: radii.card,
    boxShadow: shadows.card,
  },
  surfaceContent: {
    overflow: "hidden",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: "500ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  inert: { pointerEvents: "none" },
  requestTray: {
    position: "absolute",
    zIndex: zIndex.meetingPip,
    display: "flex",
    justifyContent: "center",
    paddingInline: space.s4,
  },
  requestDock: { width: "min(28rem, 100%)" },
  /** In a bottom sheet: the sheet is the card, and the panel fills its width. */
  sheetPanel: {
    width: "100%",
    height: "100%",
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
    backdropFilter: "none",
  },
  captionSheet: { height: "100%", gap: space.s3 },
  /** The sheet's tabs, in its title's place: the side column's tabs, sized for a thumb. */
  sheetTabs: { display: "flex", minWidth: 0, gap: space.s1 },
  sheetTab: {
    display: "inline-flex",
    height: 40,
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: 0,
    borderRadius: radii.control,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n500,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  sheetTabOn: { color: neutral.n900, fontWeight: weight.semibold, backgroundColor: neutral.n100 },
  sheetTabCount: { fontSize: text.xs, fontWeight: weight.normal, color: neutral.n400, fontVariantNumeric: "tabular-nums" },
  captionHelp: { margin: 0, fontSize: text.xs, lineHeight: leading.sm, color: ink.muted },
  grow: { minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
});

/** Where a phone's sheet stands: on the dock, a gap above it, so the dock stays in reach. */
const PHONE_SHEET_LIFT = `calc(env(safe-area-inset-bottom, 0px) + ${PHONE_DOCK_CLEARANCE_PX - CHROME_GAP_PX}px)`;
/** On a phone on its side the sheet stops at the control rail, so muting does not mean closing the chat first. */
const PHONE_SHEET_BESIDE_RAIL = `calc(env(safe-area-inset-right, 0px) + ${PHONE_RAIL_WIDTH_PX}px)`;

const INACTIVE_COUNTDOWN: SharedCountdownState = {
  endsAtMs: null,
  remainingSeconds: 0,
  active: false,
  done: false,
  canControl: false,
  start: () => false,
  stop: () => false,
};

type ComponentProps<Module, Name extends keyof Module> =
  Module[Name] extends React.ComponentType<infer Props> ? Props : never;

function lazyNamedComponent<Module, Name extends keyof Module>(
  loader: () => Promise<Module>,
  exportName: Name,
): React.LazyExoticComponent<React.ComponentType<ComponentProps<Module, Name>>> {
  return React.lazy(async () => {
    const module = await loader();
    const component = module[exportName];
    if (typeof component !== "function") {
      throw new Error(`Missing component export: ${String(exportName)}`);
    }
    return {
      default: component as React.ComponentType<ComponentProps<Module, Name>>,
    };
  });
}

const LazyControlDock = lazyNamedComponent(ESSENTIAL_MEETING_UI.controlDock, "MeetingControlDock");
const LazyStageSwitch = lazyNamedComponent(ESSENTIAL_MEETING_UI.controlDock, "MeetingStageSwitch");
const LazyRoomActions = lazyNamedComponent(ESSENTIAL_MEETING_UI.controlDock, "MeetingRoomActions");
const LazyMeetingIdentity = lazyNamedComponent(ESSENTIAL_MEETING_UI.identity, "MeetingIdentity");
const LazyVideoGrid = lazyNamedComponent(ESSENTIAL_MEETING_UI.videoLayout, "VideoGrid");
const LazySpeakerStage = lazyNamedComponent(ESSENTIAL_MEETING_UI.videoLayout, "SpeakerStage");
const LazyScreenShareStage = lazyNamedComponent(ESSENTIAL_MEETING_UI.videoLayout, "ScreenShareStage");
const LazyRoomFaces = lazyNamedComponent(ESSENTIAL_MEETING_UI.videoLayout, "RoomFaces");
const LazyPhoneDock = lazyNamedComponent(ESSENTIAL_MEETING_UI.phoneDock, "PhoneDock");
const LazyCaptionLanguagePicker = lazyNamedComponent(SECONDARY_MEETING_UI.captionLanguagePicker, "CaptionLanguagePicker");
const LazyCommandPalette = lazyNamedComponent(SECONDARY_MEETING_UI.commandPalette, "MeetingCommandPalette");
const LazyEndMeetingDialog = lazyNamedComponent(SECONDARY_MEETING_UI.endMeetingDialog, "EndMeetingDialog");
const LazyLiveCaption = lazyNamedComponent(SECONDARY_MEETING_UI.liveCaption, "LiveCaption");
const LazyConversationPeek = lazyNamedComponent(SECONDARY_MEETING_UI.liveCaption, "ConversationPeek");
const LazyParticipantsPanel = lazyNamedComponent(SECONDARY_MEETING_UI.participantsPanel, "ParticipantsPanel");
const LazySideColumn = lazyNamedComponent(SECONDARY_MEETING_UI.sideColumn, "MeetingSideColumn");
const LazyMeetingTimeline = lazyNamedComponent(SECONDARY_MEETING_UI.timeline, "MeetingTimeline");

function SuspenseBoundary({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return <React.Suspense fallback={fallback}>{children}</React.Suspense>;
}

function LiveKitRoomRefTracker({
  onRoom,
}: {
  onRoom: (room: Room | undefined) => void;
}) {
  const room = useMaybeRoomContext();
  React.useEffect(() => {
    onRoom(room);
  }, [room, onRoom]);
  return null;
}

export interface MeetingExtensions {
  surface?: {
    content: React.ReactNode;
    /**
     * Height of the toolbar the surface paints along its own top edge. Meeting
     * chrome floated over the stage (chat, participants, hand raises) starts
     * below it, so a panel never sits on top of the surface's tools.
     */
    toolbarHeightPx?: number;
    show: boolean;
    canMount: boolean;
    loading?: boolean;
    reconnecting?: boolean;
    error?: boolean;
    disabledByConfig?: boolean;
    disabledReason?: string | null;
    onClose?: () => void;
  };
  surfaceToolbar?: SurfaceToolbarControls;
  /**
   * Orb, the board's assistant. Its conversation is part of the Timeline, and
   * "@Orb" there asks it. `assistant` is null while the board is not open.
   */
  orb?: {
    assistant: MeetingAssistant | null;
    /** The conversation so far, still shown while the board is closed. */
    history: MeetingAssistant["entries"];
  };
  extraPermissions?: HostPermissionRequest[];
  onApproveExtraPermission?: (requestId: string) => void;
  onDenyExtraPermission?: (requestId: string) => void;
  leaveOverlay?: React.ReactNode;
  /** Portal-style UI owned by an extension, such as a document chooser. */
  overlay?: React.ReactNode;
}

/* oxlint-disable react/refs -- oxlint 1.85 still reports ref-tainted state reads inside an explicitly opted-out component. */
export function LiveMeetingLayout({
  meeting,
  extensions,
}: {
  meeting: LiveMeetingState;
  extensions?: MeetingExtensions;
}) {
  // Read out before use: a value handed to a JSX `ref` makes React Compiler
  // treat the object it came from as a ref, which would bail out the layout.
  const { mediaScope } = meeting;
  // Only a reconnect that lasts is worth an overlay; a blip shows nothing.
  const showReconnecting = useDelayedFlag(meeting.isLiveKitReconnecting, 1500);
  const hasCommandPalette = !meeting.isPhone && !meeting.isEgress;
  // A phone on its side has no room for a header and a dock: its controls
  // stand in a rail down the right edge instead, Leave at the top.
  const phoneLandscape = meeting.isPhone && meeting.isLandscape;
  const commands = useMeetingCommandPalette(hasCommandPalette);
  const { copy: copyToClipboard } = useCopyToClipboard();
  const { add: addToast } = useToast();

  const surface = extensions?.surface;
  const surfaceToolbar = extensions?.surfaceToolbar;
  const surfaceToolbarHeightPx = surface?.toolbarHeightPx ?? 0;

  const surfaceRequested = surface?.show ?? false;
  const surfaceLoading = surface?.loading ?? false;
  const surfaceReconnecting = surface?.reconnecting ?? false;
  const surfaceError = surface?.error ?? false;
  const surfaceDisabledByConfig = surface?.disabledByConfig ?? false;
  const surfaceReady =
    surfaceRequested && !surfaceLoading && !surfaceReconnecting && !surfaceError && !surfaceDisabledByConfig;
  // A shared screen takes the stage until this viewer picks Talk or the board
  // instead; it carries on, one press away, and the next share takes the
  // stage again. It used to hold the stage for as long as it lasted, with the
  // switch still saying Talk.
  const [screenSetAside, setScreenSetAside] = React.useState(false);
  const [shareWasLive, setShareWasLive] = React.useState(meeting.hasScreenShare);
  if (shareWasLive !== meeting.hasScreenShare) {
    setShareWasLive(meeting.hasScreenShare);
    setScreenSetAside(false);
  }
  const showScreenShareStage = meeting.hasScreenShare && !screenSetAside;
  const sharedScreen: SharedScreenControls | undefined =
    meeting.hasScreenShare && !meeting.isEgress
      ? {
          presenterName: meeting.screenSharerName,
          shown: showScreenShareStage,
          onShow: () => setScreenSetAside(false),
          onSetAside: () => setScreenSetAside(true),
        }
      : undefined;
  const showSurfaceContent = surfaceReady && !showScreenShareStage;
  const hostPermissionRequests = React.useMemo(
    () => [...meeting.hostPermissionRequests, ...(extensions?.extraPermissions ?? [])],
    [meeting.hostPermissionRequests, extensions?.extraPermissions],
  );
  const { recordingDisabled, recordingDisabledReason, streamingDisabled } = mediaControlsAvailability(meeting);
  const hasContent = surfaceRequested || showScreenShareStage;
  const composition = selectComposition({
    participantCount: meeting.connectedParticipants.length,
    hasContent,
    isPhone: meeting.isPhone,
    isLandscape: meeting.isLandscape,
  });
  const railOrientation =
    meeting.isNarrow && !meeting.isLandscape ? "horizontal" : "vertical";
  const showSurfaceStage = showSurfaceContent || showScreenShareStage;

  // A moderator's hand button opens the queue; anyone else's raises a hand.
  const handRaise = {
    isHandRaised: meeting.isHandRaised,
    queue: meeting.canModerate
      ? {
          open: meeting.ui.panel === "timeline",
          pendingCount: meeting.handRaiseQueue.filter((raise) => raise.status === "pending").length,
        }
      : null,
    onToggle: meeting.ui.handleHandRaiseAction,
  };

  const openPanel = meeting.ui.panel;
  const orbExtension = extensions?.orb;
  const orbAssistant = orbExtension?.assistant ?? null;
  const orbEntries = orbExtension ? (orbAssistant?.entries ?? orbExtension.history) : undefined;
  // The Timeline's threads outlive the panel: closing it keeps your place.
  const timelineThreads = useTimelineThreads({
    messages: meeting.chatMessages,
    orb: orbEntries,
    currentUserId: meeting.currentUserId,
    participants: meeting.participantsList,
    timelineOpen: openPanel === "timeline",
  });
  const { openPrivate: openPrivateThread, showRoom: showRoomThread, showOrb: showOrbThread } = timelineThreads;
  const openTimelinePanel = meeting.ui.openPanel;
  const messagePrivately = (person: { id: string; name: string }) => {
    openPrivateThread(person);
    openTimelinePanel("timeline");
  };
  // Someone asks Orb in the room: the Conversation opens on the room's thread
  // for everyone, unless they already have it showing.
  useOpenOnRoomQuestion({
    entries: orbEntries,
    currentUserId: meeting.currentUserId,
    enabled: !meeting.isEgress,
    open: () => {
      if (openPanel === "timeline") return;
      showRoomThread();
      openTimelinePanel("timeline");
    },
  });
  // "Catch me up": asked of Orb in your own thread with it, with what was
  // said lately, so nobody else sees that you asked.
  const captionEntries = meeting.captions.captions;
  const catchUp = orbAssistant
    ? () => {
        showOrbThread();
        openTimelinePanel("timeline");
        void orbAssistant
          .prompt(CATCH_UP_QUESTION, {
            audience: { kind: "private" },
            said: recentlySaid(captionEntries, Date.now()),
          })
          .then((error) => {
            if (error) addToast({ title: `${ORB_NAME} couldn't catch you up`, description: error, data: { variant: "error" } });
          });
      }
    : undefined;
  // ⌘K's "Ask Orb": in the room, with the Conversation open on the answer.
  const askOrbInRoom = orbAssistant
    ? (question: string) => {
        showRoomThread();
        openTimelinePanel("timeline");
        void orbAssistant
          .prompt(question, { audience: { kind: "room" }, said: recentlySaid(captionEntries, Date.now()) })
          .then((error) => {
            if (error) addToast({ title: `${ORB_NAME} couldn't take that`, description: error, data: { variant: "error" } });
          });
      }
    : undefined;
  const pendingHands = meeting.handRaiseQueue
    .filter((raise) => raise.status === "pending")
    .sort((a, b) => a.raisedAt - b.raisedAt);
  const pendingHandCount = pendingHands.length;
  const showRequestTray = meeting.canModerate && hostPermissionRequests.length > 0;

  // Which panel is beside the stage, and where the faces are: one decision,
  // so every face has exactly one place.
  const roomLayout = selectRoomLayout({
    usesBottomSheets: meeting.useBottomSheet,
    isPhone: meeting.isPhone,
    isLandscape: meeting.isLandscape,
    contentOnStage: hasContent,
    panel: openPanel,
  });
  // A board or a shared screen opens the panel that belongs beside it: the
  // Conversation under a wide screen's faces, People under an upright board.
  // A recording opens nothing: its composition has no panels.
  useContentPanel({
    contentOnStage: hasContent && !meeting.isEgress,
    contentPanel: selectContentPanel({ isPhone: meeting.isPhone, usesBottomSheets: meeting.useBottomSheet }),
    ui: meeting.ui,
  });

  /*
   * A desktop side panel reserves board width instead of floating over it.
   *
   * The panel is a 300px column docked to the window's right edge. As an
   * overlay on `z-index` it covered the gallery — with two participants,
   * 308px of a 688px tile — so the person you opened chat to talk about was
   * the person chat hid. Publishing the width through the shell makes the
   * gallery and the board reflow into what is left, exactly as they already
   * do for a docked rail.
   *
   * Beside content the column holds the faces too, so it stays — and keeps
   * its width — whether or not a panel is open under them: the board is
   * fitted once, not again each time the Conversation opens.
   */
  // Nobody else here, nobody to show: the board keeps the width.
  const facesInColumn =
    roomLayout.faces === "column" &&
    meeting.connectedParticipants.some((person) => person.identity !== meeting.currentUserId);
  const sideColumnShown = roomLayout.placement === "side" || facesInColumn;
  const desktopPanelReservation = sideColumnShown ? `calc(${SIDE_PANEL_WIDTH} + ${space.s3})` : "0px";
  // What is said lives in the Conversation; folded, the Conversation is one
  // caption — at the bottom of the stage in Talk, at the top of the board,
  // where no writing hand rests, and as a card on a phone.
  const speechArriving =
    meeting.captions.showSpeech && meeting.captions.captions.some((entry) => !entry.isFinal);
  // The request tray hangs from the top of the board, below the toolbar the
  // surface paints there, so it cannot end up on top of the surface's tools.
  const requestTrayTopGap = `${showSurfaceStage ? `${surfaceToolbarHeightPx}px + ` : ""}0.75rem`;
  const selectVideoDevice = (deviceId: string | undefined) => {
    void meeting.camera.handleSelectVideoDevice(deviceId);
  };
  const refreshVideoDevices = () => {
    void meeting.camera.refreshVideoDevices();
  };
  // Off a phone, your camera is chosen from the menu on your own controls in
  // the top strip, so a tile carries no switcher over its video. A phone has
  // no such strip and keeps the one on its tile.
  const tileCameraSwitch = meeting.isPhone ? selectVideoDevice : undefined;
  // The phone header leaves through the end-meeting dialog. The desktop bar has
  // its own two-step Leave menu, so it calls the two actions directly.
  const leaveMeeting = () => {
    void (meeting.canManageMeeting
      ? meeting.leaveEnd.handleEnd()
      : meeting.leaveEnd.handleLeave());
  };
  const leaveMeetingNow = () => {
    void meeting.leaveEnd.handleLeave();
  };
  // The desktop Leave menu's "End meeting for everyone" ended the meeting on
  // the spot: one stray click disconnected the whole room. It now asks once,
  // in the dialog's end-only form, since leaving was the menu's other choice.
  const [endOnly, setEndOnly] = React.useState(false);
  const endMeetingForEveryone = () => {
    setEndOnly(true);
    meeting.leaveEnd.setShowEndConfirm(true);
  };
  const toggleScreenShare = () => {
    void meeting.screenShare.handleToggleScreenShare();
  };
  const toggleRecording = () => {
    void meeting.recording.handleToggleRecording();
  };
  const toggleMeetingSecurity = () => {
    void meeting.handleToggleMeetingSecurity();
  };
  const peopleToggle = () => meeting.ui.togglePanel("people");
  const security = {
    secured: meeting.joinPolicy === "approval_required",
    pending: meeting.admissionPolicyPending,
    onToggle: meeting.canManageMeeting && !meeting.spaceName ? toggleMeetingSecurity : undefined,
  };

  // The two side panels, built once and placed by the layout: a docked
  // column beside the stage, or a bottom sheet on a phone.
  const timelinePanel = (options: {
    onClose?: () => void;
    hideHeader?: boolean;
    embedded?: boolean;
    embeddedInSheet?: boolean;
    sx?: stylex.StyleXStyles;
  }) => (
    <LazyMeetingTimeline
      messages={meeting.chatMessages}
      currentUserId={meeting.currentUserId}
      onSendMessage={meeting.sendChatMessage}
      orb={orbExtension ? orbExtension.assistant : undefined}
      orbHistory={orbExtension?.history}
      threads={timelineThreads.props}
      onCatchUp={catchUp}
      // Tips that teach Orb. The shortcut where there is a keyboard to press
      // it on: a tablet has the palette, but rarely the keys.
      orbTeaching={
        meeting.isEgress
          ? undefined
          : {
              transcribing: meeting.transcription.on,
              paletteShortcut: hasCommandPalette && !meeting.isTablet ? commandPaletteShortcutLabel() : undefined,
            }
      }
      speech={{
        shown: meeting.captions.showSpeech,
        entries: meeting.captions.captions,
        onToggle: meeting.captions.toggleSpeech,
      }}
      hands={
        meeting.canModerate
          ? {
              queue: meeting.handRaiseQueue,
              serverClockOffsetMs: meeting.meetingClock.serverClockOffsetMs,
              onApprove: meeting.approveHandRaise,
              onDismiss: meeting.dismissHandRaise,
            }
          : undefined
      }
      onClose={options.onClose}
      hideHeader={options.hideHeader}
      embedded={options.embedded}
      embeddedInSheet={options.embeddedInSheet}
      sx={options.sx}
    />
  );
  // What this viewer may do to other people, for the list and the faces alike.
  const participantManagement: ParticipantManagement = {
    currentUserId: meeting.currentUserId,
    canManageModerators: meeting.canManageMeeting && Boolean(meeting.moderators),
    moderatorUpdatePending: meeting.moderators?.pendingIdentities,
    onSetModerator: (identity: string, moderator: boolean) => {
      void meeting.moderators?.setModerator(identity, moderator);
    },
    canRemoveParticipants: meeting.canModerate && Boolean(meeting.removals),
    removalPending: meeting.removals?.pendingIdentities,
    onRemoveParticipant: (identity: string) => {
      void meeting.removals?.removeParticipant(identity);
    },
    // A recording has nobody to write to.
    onMessagePrivately: meeting.isEgress ? undefined : messagePrivately,
  };
  // The same actions on a face in the gallery and in the column beside
  // content, with one removal confirmation between them.
  const tileActions = useParticipantTileActions(meeting.participantsList, participantManagement);
  const peoplePanel = (options: { onClose?: () => void; hideHeader?: boolean; sx?: stylex.StyleXStyles }) => (
    <LazyParticipantsPanel
      participants={meeting.participantsList}
      {...participantManagement}
      onInvite={meeting.isEgress ? undefined : copyMeetingLink}
      security={security}
      transcription={meeting.isEgress ? undefined : {
        on: meeting.transcription.on,
        pending: meeting.transcription.pending,
        canChange: meeting.canModerate,
        onChange: (on) => void meeting.transcription.setOn(on),
        asked: meeting.transcription.asked,
        onAsk: () => void meeting.transcription.askToStop(),
        onTakeBack: () => void meeting.transcription.takeBackAsk(),
      }}
      onClose={options.onClose ?? meeting.ui.closePanel}
      hideHeader={options.hideHeader}
      sx={options.sx}
    />
  );

  // The panel's names, the way the top bar names the same things. What is
  // waiting on the one you are not looking at is the top bar's badge.
  const sideColumnTabSpec = (tab: MeetingSideColumnTab) =>
    tab === "timeline"
      ? { id: tab, label: "Chat" }
      : { id: tab, label: "People", count: meeting.connectedParticipants.length };
  const copyMeetingLink = () => {
    void copyToClipboard(window.location.href).then((copied) => {
      addToast(
        copied
          ? { title: "Meeting link copied", data: { variant: "success" } }
          : { title: "Couldn't copy the link", description: window.location.href, data: { variant: "error" } },
      );
    });
  };

  const showEveryone = () => meeting.ui.openPanel("people");
  // The faces at the top of the column beside a wide board, over the
  // Conversation or People. The Conversation lists the same hands with their
  // own "Call on": while it is open, the faces do not repeat them. A
  // recording keeps the faces and none of the controls.
  const facesColumn = facesInColumn && (
    <SuspenseBoundary>
      <LazyRoomFaces
        variant="column"
        roomy={roomLayout.active === null}
        readOnly={meeting.isEgress}
        raisedHands={pendingHands}
        onShowEveryone={showEveryone}
        onCallOn={meeting.canModerate && openPanel !== "timeline" ? meeting.approveHandRaise : undefined}
      />
    </SuspenseBoundary>
  );

  // The column beside the stage — the faces beside content, then the
  // Timeline or People — or the panel under an upright tablet's content,
  // where People is a centred row of the faces.
  const panel = (placement: "side" | "below") =>
    (roomLayout.active || (placement === "side" && facesColumn)) && (
      <SuspenseBoundary>
        <LazySideColumn
          width={SIDE_PANEL_WIDTH}
          placement={placement}
          tabs={roomLayout.tabs.map((tab) => sideColumnTabSpec(tab))}
          active={roomLayout.active}
          onClose={meeting.ui.closePanel}
          speech={{ shown: meeting.captions.showSpeech, arriving: speechArriving, onToggle: meeting.captions.toggleSpeech }}
          top={placement === "side" ? facesColumn : undefined}
        >
          {roomLayout.active === null ? null : roomLayout.active === "timeline" ? (
            timelinePanel({ embedded: true, sx: sidePanel.docked })
          ) : placement === "side" ? (
            <SuspenseBoundary fallback={<div {...stylex.props(styles.fillBox)} />}>
              {peoplePanel({ hideHeader: true, sx: sidePanel.docked })}
            </SuspenseBoundary>
          ) : (
            <SuspenseBoundary fallback={<div {...stylex.props(styles.fillBox)} />}>
              <LazyVideoGrid
                connections={meeting.connectedParticipants}
                excludeLocalParticipant={meeting.isEgress}
                videoDevices={meeting.camera.videoDevices}
                currentVideoDeviceId={meeting.camera.currentVideoDeviceId}
                onSelectVideoDevice={tileCameraSwitch}
                onRefreshVideoDevices={refreshVideoDevices}
                embedded
              />
            </SuspenseBoundary>
          )}
        </LazySideColumn>
      </SuspenseBoundary>
    );

  const mainVideoArea =
    composition === "spotlight" ? (
      <SuspenseBoundary fallback={<div {...stylex.props(styles.fillBox)} />}>
        <LazySpeakerStage
          connections={meeting.connectedParticipants}
          excludeLocalParticipant={meeting.isEgress}
          railOrientation={railOrientation}
          videoDevices={meeting.camera.videoDevices}
          currentVideoDeviceId={meeting.camera.currentVideoDeviceId}
          onSelectVideoDevice={tileCameraSwitch}
          onRefreshVideoDevices={refreshVideoDevices}
        />
      </SuspenseBoundary>
    ) : (
      <SuspenseBoundary fallback={<div {...stylex.props(styles.fillBox)} />}>
        <LazyVideoGrid
          connections={meeting.connectedParticipants}
          excludeLocalParticipant={meeting.isEgress}
          videoDevices={meeting.camera.videoDevices}
          currentVideoDeviceId={meeting.camera.currentVideoDeviceId}
          onSelectVideoDevice={tileCameraSwitch}
          onRefreshVideoDevices={refreshVideoDevices}
          renderTileActions={tileActions.renderTileActions}
          meetingCode={meeting.code}
        />
      </SuspenseBoundary>
    );

  // Talk | Board | Screen, under the phone's header, while there is a board
  // or a shared screen to show.
  const board = surfaceToolbar?.onShowBoard && surfaceToolbar.onShowTalk ? surfaceToolbar : undefined;
  const phoneModes: PhoneStageModes | undefined =
    meeting.isPhone && !meeting.isEgress && (board || sharedScreen)
      ? {
          shown: showScreenShareStage ? "screen" : board?.active ? "board" : "talk",
          onTalk: () => {
            sharedScreen?.onSetAside();
            if (board?.active) board.onShowTalk?.();
          },
          onBoard: board
            ? () => {
                sharedScreen?.onSetAside();
                if (!board.active) board.onShowBoard?.();
              }
            : undefined,
          boardLabel: board?.label,
          onScreen: sharedScreen?.onShow,
        }
      : undefined;
  const phoneHeader = meeting.isPhone && !phoneLandscape ? (
    <MeetingPhoneHeader
      code={meeting.code}
      title={meeting.meetingTitle}
      modes={phoneModes}
      meetingClock={meeting.meetingClock}
      isRecording={meeting.recording.isRecording}
      isTranscribing={meeting.transcription.on}
      participantCount={meeting.connectedParticipants.length}
      onLeave={leaveMeeting}
      timer={meeting.countdown && <SharedTimerChip countdown={meeting.countdown} compact />}
    />
  ) : undefined;

  const phoneControls = (rail?: { onLeave: () => void; modes?: typeof phoneModes }) => (
    <SuspenseBoundary>
      <LazyPhoneDock
        rail={rail}
        isHost={meeting.canManageMeeting}
        isMicOn={meeting.isMicOn}
        onToggleMic={meeting.handleToggleMic}
        isCameraOn={meeting.isCameraOn}
        onToggleCamera={() => {
          void meeting.camera.handleToggleCamera();
        }}
        panels={meeting.ui}
        handRaise={handRaise}
        surface={surfaceToolbar}
        isScreenSharing={meeting.isScreenSharing}
        onToggleScreenShare={toggleScreenShare}
        // Phone search results render in the search BottomSheet, so the dock's
        // action opens the sheet (desktop instead submits from the control bar).
        audio={meeting.audioDevice}
        background={meeting.bgEffect}
        captions={{
          ...meeting.captions,
          onOpenLanguagePicker: () => meeting.captions.setShowCaptionLanguagePicker(true),
        }}
        recording={{
          isRecording: meeting.recording.isRecording,
          disabled: recordingDisabled,
          disabledReason: recordingDisabledReason,
          onToggle: meeting.canManageMeeting ? toggleRecording : undefined,
        }}
        streaming={{
          isStreaming: meeting.streaming.isStreaming,
          disabled: streamingDisabled,
          onGoLive: meeting.canManageMeeting ? meeting.streaming.handleStartStreaming : undefined,
          onStop: meeting.canManageMeeting ? meeting.streaming.handleStopStreaming : undefined,
        }}
        countdown={meeting.countdown ?? INACTIVE_COUNTDOWN}
      />
    </SuspenseBoundary>
  );
  const phoneDock = meeting.isPhone && !phoneLandscape ? phoneControls() : undefined;
  const phoneRail = phoneLandscape ? phoneControls({ onLeave: leaveMeeting, modes: phoneModes }) : undefined;

  // Desktop chrome is one top bar: identity — title, Space, elapsed, recording,
  // address — on the left, the controls on the right. Nothing pressable docks
  // at the bottom, where the hand holding a tablet rests.
  const desktopIdentity = !meeting.isPhone ? (
    <div {...stylex.props(styles.identityRow)}>
      <SuspenseBoundary>
        <LazyMeetingIdentity
          code={meeting.code}
          meetingTitle={meeting.meetingTitle}
          spaceName={meeting.spaceName}
          meetingClock={meeting.meetingClock}
          isRecording={meeting.recording.isRecording}
          isStreaming={meeting.streaming.isStreaming}
          isLocked={meeting.joinPolicy === "approval_required"}
          isTranscribing={meeting.transcription.on && !meeting.isEgress}
          isScreenSharing={meeting.isScreenSharing}
          surfaceActive={surfaceToolbar?.active}
          surfaceLabel={surfaceToolbar?.label}
          readOnly={meeting.isEgress}
          onCopyLink={copyMeetingLink}
          // The People button carries the count, so the bar says it once; a
          // recording has no button, and keeps it here.
          peopleCount={meeting.isEgress ? meeting.connectedParticipants.length : undefined}
        />
      </SuspenseBoundary>
      {meeting.countdown && <SharedTimerChip countdown={meeting.countdown} />}
    </div>
  ) : undefined;

  // The bar never auto-hides: it is a solid band the stage starts below, so
  // hiding it would only leave an empty strip — and a whiteboard camera fitted
  // against one geometry must not be re-fitted because the mouse went still.
  const showDesktopControls = !meeting.isPhone && !meeting.isEgress;
  const toggleCamera = () => {
    void meeting.camera.handleToggleCamera();
  };
  // A moderator's hands are the ones waiting in the timeline.
  const ownHand = meeting.canModerate
    ? undefined
    : { isHandRaised: meeting.isHandRaised, onToggle: meeting.ui.handleHandRaiseAction };
  const deskSurface = surfaceToolbar && {
    ...surfaceToolbar,
    onSync: meeting.canModerate ? surfaceToolbar.onSync : undefined,
  };
  const timelineToggle = () => meeting.ui.togglePanel("timeline");
  const showCaption = meeting.captions.showCaptions && openPanel !== "timeline" && !meeting.isEgress;
  const openConversation = () => {
    showRoomThread();
    openTimelinePanel("timeline");
  };
  const latestRoomMessage = meeting.chatMessages.filter((message) => !message.to).at(-1);
  const caption = (variant: "stage" | "board" | "card") =>
    showCaption && (
      <SuspenseBoundary>
        <LazyLiveCaption
          variant={variant}
          entries={meeting.captions.captions}
          newCount={meeting.ui.timelineUnreadCount}
          onOpen={openConversation}
        />
      </SuspenseBoundary>
    );
  const desktopControls = showDesktopControls ? (
    <SuspenseBoundary>
      <LazyControlDock
        self={{
          isMicOn: meeting.isMicOn,
          micPending: meeting.isMicPending,
          onToggleMic: meeting.handleToggleMic,
          audio: meeting.audioDevice,
          isCameraOn: meeting.isCameraOn,
          onToggleCamera: toggleCamera,
          camera: {
            videoDevices: meeting.camera.videoDevices,
            currentVideoDeviceId: meeting.camera.currentVideoDeviceId,
            onSelectVideoDevice: selectVideoDevice,
            onRefreshVideoDevices: refreshVideoDevices,
          },
          background: meeting.bgEffect,
          hand: ownHand,
          spokenLanguage: {
            language: meeting.captions.captionLanguage,
            label: meeting.captions.captionLanguageLabel ?? meeting.captions.captionLanguage,
            country: meeting.captions.captionCountry,
            onSelect: meeting.captions.setCaptionLanguage,
          },
        }}
      />
    </SuspenseBoundary>
  ) : undefined;
  const desktopStageSwitch = showDesktopControls ? (
    <SuspenseBoundary>
      <LazyStageSwitch
        isScreenSharing={meeting.isScreenSharing}
        onToggleScreenShare={toggleScreenShare}
        surface={deskSurface}
        sharedScreen={sharedScreen}
        // A tablet held upright has a narrow bar: the stage switch keeps its
        // icons and drops its words, as the phone-width bar already does.
        compact={meeting.isTablet && !meeting.isLandscape}
      />
    </SuspenseBoundary>
  ) : undefined;

  const desktopActions = showDesktopControls ? (
    <SuspenseBoundary>
      <LazyRoomActions
        countdown={meeting.countdown ?? INACTIVE_COUNTDOWN}
        recording={meeting.canManageMeeting ? {
          isRecording: meeting.recording.isRecording,
          recordingPending: meeting.recording.recordingPending,
          disabled: recordingDisabled,
          disabledReason: recordingDisabledReason,
          onToggle: toggleRecording,
        } : undefined}
        streaming={meeting.canManageMeeting ? meeting.streaming : undefined}
        captions={{ shown: meeting.captions.showCaptions, onToggle: meeting.captions.toggleCaptions }}
        timeline={{
          open: openPanel === "timeline",
          speechArriving,
          unreadCount: meeting.ui.timelineUnreadCount,
          waitingHands: meeting.canModerate ? pendingHandCount : 0,
          onToggle: timelineToggle,
        }}
        people={{
          open: openPanel === "people",
          count: meeting.connectedParticipants.length,
          onToggle: peopleToggle,
        }}
        onOpenCommands={commands.openPalette}
        leavePending={meeting.leaveEnd.actionPending}
        onLeave={leaveMeetingNow}
        onEndForEveryone={meeting.canManageMeeting ? endMeetingForEveryone : undefined}
      />
    </SuspenseBoundary>
  ) : undefined;

  // Built from exactly what the bar's controls receive, so the palette can
  // never offer an action its control would refuse.
  const commandInput: MeetingCommandInput = {
    mic: { on: meeting.isMicOn, toggle: meeting.handleToggleMic },
    camera: { on: meeting.isCameraOn, toggle: toggleCamera },
    hand: ownHand && { raised: ownHand.isHandRaised, toggle: ownHand.onToggle },
    screenShare: { sharing: meeting.isScreenSharing, toggle: toggleScreenShare },
    surface: deskSurface,
    speech: { shown: meeting.captions.showSpeech, toggle: meeting.captions.toggleSpeech },
    captions: { shown: meeting.captions.showCaptions, toggle: meeting.captions.toggleCaptions },
    timeline: { open: openPanel === "timeline", toggle: timelineToggle },
    people: { open: openPanel === "people", toggle: peopleToggle },
    recording: meeting.canManageMeeting
      ? {
          recording: meeting.recording.isRecording,
          disabledReason: recordingDisabledReason,
          toggle: toggleRecording,
        }
      : undefined,
    security: security.onToggle
      ? { secured: security.secured, pending: security.pending, toggle: security.onToggle }
      : undefined,
    hands: meeting.canModerate ? { queue: pendingHands, callOn: meeting.approveHandRaise } : undefined,
    messagePrivately: meeting.isEgress
      ? undefined
      : {
          people: meeting.participantsList.filter((person) => person.id !== meeting.currentUserId),
          open: messagePrivately,
        },
    copyLink: copyMeetingLink,
    leave: leaveMeetingNow,
    endForEveryone: meeting.canManageMeeting ? endMeetingForEveryone : undefined,
  };

  const desktopTopBar = !meeting.isPhone ? (
    <MeetingTopBar
      identity={desktopIdentity}
      controls={desktopStageSwitch}
      actions={
        showDesktopControls ? (
          <>
            {desktopControls}
            {desktopActions}
          </>
        ) : undefined
      }
    />
  ) : undefined;

  return (
    <MeetingShell
      ref={mediaScope}
      isPhone={meeting.isPhone}
      sx={styles.room}
      header={phoneHeader ?? desktopTopBar}
      dock={phoneDock}
      dockVisible={!meeting.isPhone || meeting.ui.controlsVisible}
      hasModeSwitch={Boolean(phoneModes) && !phoneLandscape}
      rail={phoneRail}
      panelWidth={phoneLandscape ? `${PHONE_RAIL_WIDTH_PX}px` : desktopPanelReservation}
    >
      <LiveKitRoomRefTracker onRoom={meeting.handleLiveKitRoomUpdate} />

      {/* Words-when-degraded: the bar carries no ambient health dot, so a poor
          connection announces itself in a sentence instead. Full disconnects
          are covered by the reconnecting overlay below. */}
      {meeting.connectionQuality === "poor" &&
        !showReconnecting &&
        !meeting.isPhone &&
        !meeting.isEgress && (
          <div
            {...stylex.props(styles.notice, styles.noticeBelowHeader)}
            role="status"
          >
            Your connection is unstable — audio and video quality may drop for a moment.
          </div>
        )}

      {(meeting.showConnectingOverlay || meeting.isLiveKitConnecting || showReconnecting) && (
        <div
          // No backdrop-filter: at 95% opacity nothing behind this is visible,
          // so the blur was a viewport-sized filter pass over live video that
          // rendered no pixels anyone could see.
          {...stylex.props(layout.fill, styles.connectingOverlay)}
        >
          <div {...stylex.props(surfaces.glassSolid, styles.connectingCard)}>
            <div {...stylex.props(progress.spin, styles.spinner)} />
            <p {...stylex.props(styles.connectingLabel)}>{meeting.connectionOverlayLabel}</p>
          </div>
        </div>
      )}

      <SuspenseBoundary>
        <LazyEndMeetingDialog
          show={meeting.leaveEnd.showEndConfirm}
          pending={meeting.leaveEnd.actionPending}
          onCancel={() => {
            setEndOnly(false);
            meeting.leaveEnd.setShowEndConfirm(false);
          }}
          onLeave={meeting.canManageMeeting && !endOnly ? meeting.leaveEnd.confirmLeave : undefined}
          onConfirm={meeting.leaveEnd.confirmEnd}
          peopleCount={meeting.connectedParticipants.length}
        />
      </SuspenseBoundary>

      {tileActions.dialog}

      {extensions?.leaveOverlay}

      {hasCommandPalette && commands.mounted && (
        <SuspenseBoundary>
          <LazyCommandPalette
            open={commands.open}
            onOpenChange={commands.setOpen}
            commands={commandInput}
            onAskOrb={askOrbInRoom}
          />
        </SuspenseBoundary>
      )}

      {/* Video may bleed to the display edge — letterboxing a phone to dodge the
          notch throws away the screen, and the grid insets its own labels and
          badges. A drawable surface may not: the whiteboard and screen share get
          the safe rect, so nothing lands under the Island or behind the dock.
          Reserving it from `surfaceRequested` rather than from "surface ready"
          keeps the camera's first fit from being computed against one geometry
          and then reflowed into another as the board fades in. */}
      {/* A phone's: the stage rect stops above the dock, so a surface used to end in a
          hard edge with the room's own background showing beneath it — a ledge
          the control capsule appeared to stand on. The surface's backdrop runs
          to the display edge instead, and the dock floats on one continuous
          canvas. Only the backdrop bleeds; the drawable cell above still keeps
          the safe rect. Anywhere else the surface is a card on the room's
          ground, and has no edge to hide. */}
      <div
        aria-hidden="true"
        {...stylex.props(layout.decorative, layout.fill, styles.surfaceBackdrop, showSurfaceStage && meeting.isPhone && styles.shown)}
      />

      <div
        {...stylex.props(
          styles.stage,
          hasContent ? inStage.fill : inStage.fillBesidePanel,
        )}
      >
        {hasContent ? (
          <>
            {/* The faces beside content are chrome, not part of it: they are
                mounted the moment the content is asked for and do not fade
                with it. They used to appear only once the board was ready,
                which meant the room played the whole composition twice — a
                full-stage gallery, then the same people again in a column. */}
            <div
              {...stylex.props(
                layout.fill,
                styles.participantLayout,
                styles.participantColumn,
              )}
            >
              {/* The desk, not white: a surface that is still loading should
                  not read as a blank page the user could draw on — and when it
                  does load, the board lands on the same colour it was already
                  standing on, so nothing changes shade underneath it. */}
              <div {...stylex.props(styles.contentRow)}>
              <div {...stylex.props(styles.surfaceCell, !meeting.isPhone && styles.surfaceCard)}>
                {/* No safe-area math here: the surface cell is already inside
                    the shell's stage rect. */}
                <div
                  {...stylex.props(
                    layout.fill,
                    styles.surfaceContent,
                    showSurfaceStage ? styles.shown : styles.inert,
                  )}
                >
                  {showScreenShareStage ? (
                    <SuspenseBoundary fallback={<div {...stylex.props(styles.fillBox)} />}>
                      <LazyScreenShareStage onStopPresenting={meeting.isScreenSharing ? toggleScreenShare : undefined} />
                    </SuspenseBoundary>
                  ) : surface?.canMount ? (
                    surface.content
                  ) : null}
                  {/* Under the board's top band; out of the way while a
                      request is waiting there. */}
                  {!meeting.isPhone && !showRequestTray && (
                    <div {...stylex.props(styles.boardCaption)}>{caption("board")}</div>
                  )}
                </div>
              </div>

              </div>

              {roomLayout.faces === "row" && (
                <div
                  {...stylex.props(
                    styles.contentFoot,
                    meeting.isPhone ? styles.contentFootPhone : styles.contentFootCard,
                  )}
                >
                  <SuspenseBoundary>
                    <LazyRoomFaces
                      variant="row"
                      roomy={!meeting.isPhone}
                      raisedHands={pendingHands}
                      onShowEveryone={showEveryone}
                    />
                  </SuspenseBoundary>
                  {meeting.isPhone && !meeting.isEgress && (
                    <SuspenseBoundary>
                      <LazyConversationPeek
                        entries={meeting.captions.captions}
                        latestMessage={latestRoomMessage}
                        newCount={meeting.ui.timelineUnreadCount}
                        onOpen={openConversation}
                      />
                    </SuspenseBoundary>
                  )}
                </div>
              )}

              {/* An upright tablet: the panel docks under the content, the
                  full width — the same panel as beside it on a landscape
                  screen, turned to fit. */}
              {roomLayout.placement === "below" && panel("below")}

            </div>

            {surfaceRequested &&
              !showScreenShareStage &&
              (surfaceLoading ||
                surfaceReconnecting ||
                surfaceError ||
                surfaceDisabledByConfig) && (
                <SurfaceUnavailableOverlay
                  disabledByConfig={surfaceDisabledByConfig}
                  disabledReason={surface?.disabledReason}
                  reconnecting={surfaceReconnecting}
                  error={surfaceError}
                  onClose={surface?.onClose}
                />
              )}
          </>
        ) : roomLayout.placement === "below" ? (
          // An upright tablet's Talk: the stage, and the Conversation docked
          // under it rather than sheeted over the people in it.
          <div {...stylex.props(layout.fill, styles.participantLayout, styles.participantColumn)}>
            <div {...stylex.props(styles.talkStage)}>{mainVideoArea}</div>
            {panel("below")}
          </div>
        ) : (
          <>
            {mainVideoArea}
            {!meeting.isPhone && <div {...stylex.props(styles.stageCaption)}>{caption("stage")}</div>}
          </>
        )}
      </div>

      {/* On its side, a phone has no header: the room's name rides on the stage. */}
      {phoneLandscape && (
        <div {...stylex.props(styles.landscapeIdentity, inStage.top("0.5rem"))}>
          <span {...stylex.props(styles.landscapeTitle)}>{meeting.meetingTitle || meeting.code}</span>
        </div>
      )}
      {/* On a phone's board the bottom is the pager's: the caption is Talk's. */}
      {meeting.isPhone && !hasContent && <div {...stylex.props(styles.phoneCaption)}>{caption("card")}</div>}

      {extensions?.overlay}

      {/* One tray, at the top of the board, under whatever toolbar a surface
          paints there. It used to have two homes: top-right over the gallery,
          and bottom-centre while a surface was up — where it landed squarely on
          the whiteboard's own zoom/page bar, so the request covered the
          controls and the controls covered the request. Top-centre of the
          board is empty in both modes, and `inset-x-board` keeps it centred on
          the board rather than on the window. */}
      {showRequestTray && (
        <div
          {...stylex.props(styles.requestTray, onBoard.spanX, inStage.top(requestTrayTopGap))}
        >
          <div {...stylex.props(styles.requestDock)}>
            <HostPermissionDock
              requests={hostPermissionRequests}
              onApproveScreenShare={(userId) => {
                void meeting.screenShare.handleApproveScreenShare(userId);
              }}
              onDenyScreenShare={(userId) => {
                void meeting.screenShare.handleDenyScreenShare(userId);
              }}
              onApproveAdmission={(admissionId) => {
                void meeting.handleApproveAdmission(admissionId);
              }}
              onDenyAdmission={(admissionId) => {
                void meeting.handleDenyAdmission(admissionId);
              }}
              onApproveExtraPermission={(requestId) => {
                if (!meeting.transcription.answerRequest(requestId, true)) extensions?.onApproveExtraPermission?.(requestId);
              }}
              onDenyExtraPermission={(requestId) => {
                if (!meeting.transcription.answerRequest(requestId, false)) extensions?.onDenyExtraPermission?.(requestId);
              }}
            />
          </div>
        </div>
      )}

      {meeting.isMicOn && (
        <MicrophoneInterruptedBanner cause={meeting.micInterruption} onResume={meeting.resumeMic} />
      )}

      {!meeting.canModerate && (
        <ParticipantPermissionBanner
          state={meeting.screenShare.screenShareRequestState}
          isPreparing={meeting.screenShare.isPreparingScreenShare}
          hasPrepared={meeting.screenShare.hasPreparedScreenShare}
          hasPermission={meeting.screenShare.hasScreenSharePermission}
          onCancel={meeting.screenShare.handleCancelScreenShareRequest}
          onDismiss={meeting.screenShare.handleDismissScreenShareDenied}
        />
      )}

      {meeting.useBottomSheet ? (
        <>
          {/* Chat and People, two tabs of one sheet. With the panel docked
              under the content, they are already open there — sheeting them
              over the board would cover the thing being discussed. On a
              phone the sheet stands on the dock and leaves it usable: muting
              should not mean closing the chat first. */}
          <BottomSheet
            open={(openPanel === "timeline" || openPanel === "people") && roomLayout.placement === null}
            onClose={meeting.ui.closePanel}
            title={openPanel === "people" ? "People" : "Chat"}
            heading={
              <div role="tablist" aria-label="Chat and people" {...stylex.props(styles.sheetTabs)}>
                {(["timeline", "people"] as const).map((tab) => {
                  const spec = sideColumnTabSpec(tab);
                  const selected = openPanel === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => meeting.ui.openPanel(tab)}
                      {...stylex.props(styles.sheetTab, selected && styles.sheetTabOn)}
                    >
                      {spec.label}
                      {spec.count !== undefined && <span {...stylex.props(styles.sheetTabCount)}>{spec.count}</span>}
                    </button>
                  );
                })}
              </div>
            }
            bottomInset={phoneDock ? PHONE_SHEET_LIFT : undefined}
            endInset={phoneRail ? PHONE_SHEET_BESIDE_RAIL : undefined}
            passThrough={phoneDock || phoneRail ? MEETING_DOCK_SELECTOR : undefined}
          >
            <SuspenseBoundary>
              {openPanel === "people"
                ? peoplePanel({ hideHeader: true, sx: styles.sheetPanel })
                : timelinePanel({ hideHeader: true, embeddedInSheet: true, sx: styles.sheetPanel })}
            </SuspenseBoundary>
          </BottomSheet>
          <BottomSheet
            open={meeting.captions.showCaptionLanguagePicker}
            onClose={() => meeting.captions.setShowCaptionLanguagePicker(false)}
            title="My spoken language"
          >
            <SuspenseBoundary>
              <div {...stylex.props(stack.x3, styles.captionSheet)}>
                <p {...stylex.props(styles.captionHelp)}>
                  While the meeting is transcribing, your microphone is sent to Deepgram in
                  this language for captions, the transcript and the summary.
                </p>
                <LazyCaptionLanguagePicker
                  country={meeting.captions.captionCountry}
                  selectedLanguage={meeting.captions.captionLanguage}
                  onSelectLanguage={(language: string) => {
                    meeting.captions.setCaptionLanguage(language);
                    meeting.captions.setShowCaptionLanguagePicker(false);
                  }}
                  sx={styles.grow}
                  autoFocusSearch
                />
              </div>
            </SuspenseBoundary>
          </BottomSheet>
        </>
      ) : (
        sideColumnShown && panel("side")
      )}
    </MeetingShell>
  );
}
/* oxlint-enable react/refs */
