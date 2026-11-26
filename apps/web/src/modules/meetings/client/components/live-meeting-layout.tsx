import * as React from "react";
import { BottomSheet, useToast } from "@orbmeet/ui/react";
import { stack } from "@orbmeet/ui/styles/atoms";
import { inStage, onBoard } from "@orbmeet/ui/styles/stage";
import { SIDE_PANEL_WIDTH, sidePanel } from "@/modules/meetings/client/meeting-styles";
import { ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { stage as stageVars } from "@orbmeet/ui/tokens/stage.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { MEETING_DOCK_SELECTOR } from "./meeting-shell";
import { MeetingStageLayout } from "./meeting-stage-layout";
import { MeetingTopBar } from "./meeting-top-bar";
import { type HostPermissionRequest, type LiveMeetingState } from "@/modules/meetings/client/use-live-meeting";
import { selectContentPanel, selectRoomLayout, type MeetingSideColumnTab } from "@/modules/meetings/client/room-layout";
import { useContentPanel } from "@/modules/meetings/client/use-content-panel";
import { MeetingPhoneHeader } from "./meeting-phone-header";
import { CHROME_GAP_PX, PHONE_DOCK_CLEARANCE_PX, PHONE_RAIL_WIDTH_PX } from "@/modules/meetings/client/chrome";
import { HostPermissionDock } from "./host-permission-dock";
import { ParticipantPermissionBanner } from "./participant-permission-banner";
import { MicrophoneInterruptedBanner } from "./microphone-interrupted-banner";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";
import { SharedTimerChip } from "./shared-timer-chip";
import type {
  PhoneStageModes,
  SharedScreenControls,
  SurfaceToolbarControls,
} from "@/modules/meetings/client/components/dock-controls";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { useMeetingCommandPalette } from "@/modules/meetings/client/use-meeting-command-palette";
import { commandKLabel } from "@/lib/command-k";
import { mediaControlsAvailability } from "@/modules/meetings/client/media-controls";
import { useDelayedFlag } from "@/lib/hooks/use-delayed-flag";
import type { MeetingCommandInput } from "@/modules/meetings/client/meeting-commands";
import { useParticipantTileActions, type ParticipantManagement } from "./participant-actions";
import { ESSENTIAL_MEETING_UI, SECONDARY_MEETING_UI } from "./meeting-ui-modules";
import { CATCH_UP_QUESTION, ORB_NAME, recentConversation, type MeetingAssistant } from "@/modules/meetings/client/orb";
import { useTimelineThreads } from "@/modules/meetings/client/use-timeline-threads";
import { useSpaceTranscriptionDefault } from "@/modules/spaces/client/use-space-transcription";
import { useOpenOnRoomQuestion } from "@/modules/meetings/client/use-open-on-room-question";

const styles = stylex.create({
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

const LazyControlDock = React.lazy(() =>
  ESSENTIAL_MEETING_UI.controlDock().then((m) => ({ default: m.MeetingControlDock })),
);
const LazyStageSwitch = React.lazy(() =>
  ESSENTIAL_MEETING_UI.controlDock().then((m) => ({ default: m.MeetingStageSwitch })),
);
const LazyRoomActions = React.lazy(() =>
  ESSENTIAL_MEETING_UI.controlDock().then((m) => ({ default: m.MeetingRoomActions })),
);
const LazyMeetingIdentity = React.lazy(() =>
  ESSENTIAL_MEETING_UI.identity().then((m) => ({ default: m.MeetingIdentity })),
);
const LazyVideoGrid = React.lazy(() =>
  ESSENTIAL_MEETING_UI.videoLayout().then((m) => ({ default: m.VideoGrid })),
);
const LazyPhoneDock = React.lazy(() =>
  ESSENTIAL_MEETING_UI.phoneDock().then((m) => ({ default: m.PhoneDock })),
);
const LazyCaptionLanguagePicker = React.lazy(() =>
  SECONDARY_MEETING_UI.captionLanguagePicker().then((m) => ({ default: m.CaptionLanguagePicker })),
);
const LazyCommandPalette = React.lazy(() =>
  SECONDARY_MEETING_UI.commandPalette().then((m) => ({ default: m.MeetingCommandPalette })),
);
const LazyEndMeetingDialog = React.lazy(() =>
  SECONDARY_MEETING_UI.endMeetingDialog().then((m) => ({ default: m.EndMeetingDialog })),
);
const LazyLiveCaption = React.lazy(() =>
  SECONDARY_MEETING_UI.liveCaption().then((m) => ({ default: m.LiveCaption })),
);
const LazyConversationPeek = React.lazy(() =>
  SECONDARY_MEETING_UI.liveCaption().then((m) => ({ default: m.ConversationPeek })),
);
const LazyParticipantsPanel = React.lazy(() =>
  SECONDARY_MEETING_UI.participantsPanel().then((m) => ({ default: m.ParticipantsPanel })),
);
const LazySideColumn = React.lazy(() =>
  SECONDARY_MEETING_UI.sideColumn().then((m) => ({ default: m.MeetingSideColumn })),
);
const LazyMeetingTimeline = React.lazy(() =>
  SECONDARY_MEETING_UI.timeline().then((m) => ({ default: m.MeetingTimeline })),
);

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
  const hasCommandPalette = !meeting.isPhone;
  // A phone on its side has no room for a header and a dock: its controls
  // stand in a rail down the right edge instead, Leave at the top.
  const phoneLandscape = meeting.isPhone && meeting.isLandscape;
  const commands = useMeetingCommandPalette(hasCommandPalette);
  const { copy: copyToClipboard } = useCopyToClipboard();
  // The Space's default for its meetings, offered beside this meeting's switch to its admins.
  const spaceTranscription = useSpaceTranscriptionDefault(meeting.spaceTranscription);
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
  // stage again.
  const [screenSetAside, setScreenSetAside] = React.useState(false);
  const [shareWasLive, setShareWasLive] = React.useState(meeting.hasScreenShare);
  if (shareWasLive !== meeting.hasScreenShare) {
    setShareWasLive(meeting.hasScreenShare);
    setScreenSetAside(false);
  }
  const showScreenShareStage = meeting.hasScreenShare && !screenSetAside;
  const sharedScreen: SharedScreenControls | undefined = meeting.hasScreenShare
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
  const showSurfaceStage = showSurfaceContent || showScreenShareStage;

  // A moderator's hand button opens the queue; anyone else's raises a hand.
  const pendingHands = [...meeting.handRaiseQueue].sort((a, b) => a.raisedAt - b.raisedAt);
  const pendingHandCount = pendingHands.length;
  const handRaise = {
    isHandRaised: meeting.isHandRaised,
    queue: meeting.canModerate
      ? {
          open: meeting.ui.panel === "timeline",
          pendingCount: pendingHandCount,
        }
      : null,
    onToggle: meeting.ui.handleHandRaiseAction,
  };

  const openPanel = meeting.ui.panel;
  const orbExtension = extensions?.orb;
  const orbAssistant = orbExtension?.assistant ?? null;
  const orbEntries = orbExtension ? (orbAssistant?.entries ?? orbExtension.history) : undefined;
  // The Timeline's threads outlive the panel: closing it keeps your place.
  const timelinePeople = React.useMemo(
    () => meeting.connectedParticipants.map((person) => ({ id: person.participantKey, name: person.userName })),
    [meeting.connectedParticipants],
  );
  const timelineThreads = useTimelineThreads({
    messages: meeting.chatMessages,
    orb: orbEntries,
    self: meeting.participantKey,
    participants: timelinePeople,
    timelineOpen: openPanel === "timeline",
    readUpTo: meeting.chatReadUpTo,
    markRead: meeting.markChatRead,
  });
  const { openPrivate: openPrivateThread, showRoom: showRoomThread, showOrb: showOrbThread } = timelineThreads;
  const openTimelinePanel = meeting.ui.openPanel;
  // People are listed by connection; a private thread is with the person,
  // whose key outlives the connection.
  const messagePrivately = (person: { id: string; name: string }) => {
    const key = meeting.connectedParticipants.find((listed) => listed.identity === person.id)?.participantKey;
    if (!key) return;
    openPrivateThread({ id: key, name: person.name });
    openTimelinePanel("timeline");
  };
  // Someone asks Orb in the room: the Conversation opens on the room's thread
  // for everyone, unless they already have it showing.
  useOpenOnRoomQuestion({
    entries: orbEntries,
    self: meeting.participantKey,
    enabled: true,
    open: () => {
      if (openPanel === "timeline") return;
      showRoomThread();
      openTimelinePanel("timeline");
    },
  });
  // "Catch me up": asked of Orb in your own thread with it, with what was
  // said and written to the room lately, so nobody else sees that you asked.
  const captionEntries = meeting.captions.captions;
  const lately = () =>
    recentConversation(
      { said: captionEntries, chat: meeting.chatMessages, orb: orbEntries },
      Date.now(),
    );
  const catchUp = orbAssistant
    ? () => {
        showOrbThread();
        openTimelinePanel("timeline");
        void orbAssistant
          .prompt(CATCH_UP_QUESTION, {
            audience: { kind: "private" },
            said: lately(),
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
          .prompt(question, { audience: { kind: "room" }, said: lately() })
          .then((error) => {
            if (error) addToast({ title: `${ORB_NAME} couldn't take that`, description: error, data: { variant: "error" } });
          });
      }
    : undefined;
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
  useContentPanel({
    contentOnStage: hasContent,
    contentPanel: selectContentPanel({ isPhone: meeting.isPhone, usesBottomSheets: meeting.useBottomSheet }),
    ui: meeting.ui,
  });

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
  const leaveMeeting = () => {
    void (meeting.canManageMeeting
      ? meeting.leaveEnd.handleEnd()
      : meeting.leaveEnd.handleLeave());
  };
  const leaveMeetingNow = () => {
    void meeting.leaveEnd.handleLeave();
  };
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

  const timelinePanel = (options: {
    onClose?: () => void;
    hideHeader?: boolean;
    embedded?: boolean;
    embeddedInSheet?: boolean;
    sx?: stylex.StyleXStyles;
  }) => (
    <LazyMeetingTimeline
      messages={meeting.chatMessages}
      self={meeting.participantKey}
      onSendMessage={meeting.sendChatMessage}
      orb={orbExtension ? orbExtension.assistant : undefined}
      orbHistory={orbExtension?.history}
      threads={timelineThreads.props}
      onCatchUp={catchUp}
      orbTeaching={{
        transcribing: meeting.transcription.on,
        paletteShortcut: hasCommandPalette && !meeting.isTablet ? commandKLabel() : undefined,
      }}
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
              onResolve: meeting.resolveHandRaise,
            }
          : undefined
      }
      onOpenBoard={surfaceToolbar?.onShowBoard ?? surfaceToolbar?.onToggle}
      onClose={options.onClose}
      hideHeader={options.hideHeader}
      embedded={options.embedded}
      embeddedInSheet={options.embeddedInSheet}
      sx={options.sx}
    />
  );

  // What this viewer may do to other people, for the list and the faces alike.
  const participantManagement: ParticipantManagement = {
    currentIdentity: meeting.currentIdentity,
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
    onMessagePrivately: messagePrivately,
  };
  const tileActions = useParticipantTileActions(meeting.connectedParticipants, participantManagement);
  const copyMeetingLink = () =>
    copyToClipboard(window.location.href).then((copied) => {
      addToast(
        copied
          ? { title: "Meeting link copied", data: { variant: "success" } }
          : { title: "Couldn't copy the link", description: window.location.href, data: { variant: "error" } },
      );
      return copied;
    });

  const peoplePanel = (options: { onClose?: () => void; hideHeader?: boolean; sx?: stylex.StyleXStyles }) => (
    <LazyParticipantsPanel
      participants={meeting.connectedParticipants}
      {...participantManagement}
      onInvite={() => void copyMeetingLink()}
      security={security}
      transcription={{
        on: meeting.transcription.on,
        pending: meeting.transcription.pending,
        canChange: meeting.canModerate,
        onChange: (on) => void meeting.transcription.setOn(on),
        asked: meeting.transcription.asked,
        onAsk: () => void meeting.transcription.askToStop(),
        onTakeBack: () => void meeting.transcription.takeBackAsk(),
        future: meeting.canModerate && spaceTranscription ? spaceTranscription : undefined,
      }}
      onClose={options.onClose ?? meeting.ui.closePanel}
      hideHeader={options.hideHeader}
      sx={options.sx}
    />
  );

  const sideColumnTabSpec = (tab: MeetingSideColumnTab) =>
    tab === "timeline"
      ? { id: tab, label: "Chat" }
      : { id: tab, label: "People", count: meeting.connectedParticipants.length };

  const showEveryone = () => meeting.ui.openPanel("people");

  const renderPanel = (placement: "side" | "below", facesColumn?: React.ReactNode) =>
    (roomLayout.active || (placement === "side" && facesColumn)) && (
      <React.Suspense fallback={null}>
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
            <React.Suspense fallback={<div {...stylex.props(styles.fillBox)} />}>
              {peoplePanel({ hideHeader: true, sx: sidePanel.docked })}
            </React.Suspense>
          ) : (
            <React.Suspense fallback={<div {...stylex.props(styles.fillBox)} />}>
              <LazyVideoGrid
                connections={meeting.connectedParticipants}
                videoDevices={meeting.camera.videoDevices}
                currentVideoDeviceId={meeting.camera.currentVideoDeviceId}
                onSelectVideoDevice={tileCameraSwitch}
                onRefreshVideoDevices={refreshVideoDevices}
                embedded
              />
            </React.Suspense>
          )}
        </LazySideColumn>
      </React.Suspense>
    );

  // Talk | Board | Screen, under the phone's header, while there is a board or shared screen.
  const board = surfaceToolbar?.onShowBoard && surfaceToolbar.onShowTalk ? surfaceToolbar : undefined;
  const phoneModes: PhoneStageModes | undefined =
    meeting.isPhone && (board || sharedScreen)
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
    <React.Suspense fallback={null}>
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
    </React.Suspense>
  );
  const phoneDock = meeting.isPhone && !phoneLandscape ? phoneControls() : undefined;
  const phoneRail = phoneLandscape ? phoneControls({ onLeave: leaveMeeting, modes: phoneModes }) : undefined;

  const toggleCamera = () => {
    void meeting.camera.handleToggleCamera();
  };
  const ownHand = meeting.canModerate
    ? undefined
    : { isHandRaised: meeting.isHandRaised, onToggle: meeting.ui.handleHandRaiseAction };
  const deskSurface = surfaceToolbar && {
    ...surfaceToolbar,
    onSync: meeting.canModerate ? surfaceToolbar.onSync : undefined,
  };
  const timelineToggle = () => meeting.ui.togglePanel("timeline");
  const showCaption = meeting.captions.showCaptions && openPanel !== "timeline";
  const openConversation = () => {
    showRoomThread();
    openTimelinePanel("timeline");
  };
  const latestRoomMessage = meeting.chatMessages.filter((message) => !message.to).at(-1);
  const caption = (variant: "stage" | "board" | "card") =>
    showCaption ? (
      <React.Suspense fallback={null}>
        <LazyLiveCaption
          variant={variant}
          entries={meeting.captions.captions}
          newCount={meeting.ui.timelineUnreadCount}
          onOpen={openConversation}
        />
      </React.Suspense>
    ) : undefined;

  const desktopTopBar = !meeting.isPhone ? (
    <MeetingTopBar
      identity={
        <div {...stylex.props(styles.identityRow)}>
          <React.Suspense fallback={null}>
            <LazyMeetingIdentity
              code={meeting.code}
              meetingTitle={meeting.meetingTitle}
              spaceName={meeting.spaceName}
              meetingClock={meeting.meetingClock}
              isRecording={meeting.recording.isRecording}
              isStreaming={meeting.streaming.isStreaming}
              isLocked={meeting.joinPolicy === "approval_required"}
              isTranscribing={meeting.transcription.on}
              isScreenSharing={meeting.isScreenSharing}
              surfaceActive={surfaceToolbar?.active}
              surfaceLabel={surfaceToolbar?.label}
              onCopyLink={copyMeetingLink}
            />
          </React.Suspense>
          {meeting.countdown && <SharedTimerChip countdown={meeting.countdown} />}
        </div>
      }
      controls={
        <React.Suspense fallback={null}>
          <LazyStageSwitch
            isScreenSharing={meeting.isScreenSharing}
            onToggleScreenShare={toggleScreenShare}
            surface={deskSurface}
            sharedScreen={sharedScreen}
            compact={meeting.isTablet && !meeting.isLandscape}
          />
        </React.Suspense>
      }
      actions={
        <React.Suspense fallback={null}>
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
        </React.Suspense>
      }
    />
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
    hands: meeting.canModerate ? { queue: pendingHands, callOn: meeting.resolveHandRaise } : undefined,
    messagePrivately: {
      people: meeting.connectedParticipants
        .filter((person) => person.identity !== meeting.currentIdentity)
        .map((person) => ({ id: person.identity, name: person.userName })),
      open: messagePrivately,
    },
    copyLink: () => void copyMeetingLink(),
    leave: leaveMeetingNow,
    endForEveryone: meeting.canManageMeeting ? endMeetingForEveryone : undefined,
  };

  return (
    <MeetingStageLayout
      mediaScope={mediaScope}
      code={meeting.code}
      meetingClock={meeting.meetingClock}
      meetingTitle={meeting.meetingTitle}
      spaceName={meeting.spaceName}
      isRecording={meeting.recording.isRecording}
      isStreaming={meeting.streaming.isStreaming}
      isScreenSharing={meeting.isScreenSharing}
      isPhone={meeting.isPhone}
      isLandscape={meeting.isLandscape}
      isNarrow={meeting.isNarrow}
      useBottomSheet={meeting.useBottomSheet}
      connectedParticipants={meeting.connectedParticipants}
      currentIdentity={meeting.currentIdentity}
      isConnecting={meeting.isLiveKitConnecting}
      isReconnecting={meeting.isLiveKitReconnecting}
      connectionOverlayLabel={meeting.connectionOverlayLabel}
      showScreenShareStage={showScreenShareStage}
      onStopPresenting={meeting.isScreenSharing ? toggleScreenShare : undefined}
      surface={surface}
      surfaceLabel={surfaceToolbar?.label}
      header={phoneHeader ?? desktopTopBar}
      dock={phoneDock}
      dockVisible={!meeting.isPhone || meeting.ui.controlsVisible}
      hasModeSwitch={Boolean(phoneModes) && !phoneLandscape}
      rail={phoneRail}
      panelWidth={phoneLandscape ? `${PHONE_RAIL_WIDTH_PX}px` : undefined}
      openPanel={openPanel}
      renderBelowPanel={() => renderPanel("below")}
      renderSideColumn={(facesColumn, sideColumnShown) =>
        meeting.useBottomSheet ? (
          <>
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
              <React.Suspense fallback={null}>
                {openPanel === "people"
                  ? peoplePanel({ hideHeader: true, sx: styles.sheetPanel })
                  : timelinePanel({ hideHeader: true, embeddedInSheet: true, sx: styles.sheetPanel })}
              </React.Suspense>
            </BottomSheet>
            <BottomSheet
              open={meeting.captions.showCaptionLanguagePicker}
              onClose={() => meeting.captions.setShowCaptionLanguagePicker(false)}
              title="My spoken language"
            >
              <React.Suspense fallback={null}>
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
              </React.Suspense>
            </BottomSheet>
          </>
        ) : (
          sideColumnShown && renderPanel("side", facesColumn)
        )
      }
      boardCaption={!meeting.isPhone && !showRequestTray ? caption("board") : undefined}
      stageCaption={!meeting.isPhone ? caption("stage") : undefined}
      phoneContentFootExtra={
        meeting.isPhone ? (
          <LazyConversationPeek
            entries={meeting.captions.captions}
            latestMessage={latestRoomMessage}
            newCount={meeting.ui.timelineUnreadCount}
            onOpen={openConversation}
          />
        ) : undefined
      }
      raisedHands={pendingHands}
      onShowEveryone={showEveryone}
      onCallOn={meeting.canModerate && openPanel !== "timeline" ? meeting.resolveHandRaise : undefined}
      videoDevices={meeting.camera.videoDevices}
      currentVideoDeviceId={meeting.camera.currentVideoDeviceId}
      onSelectVideoDevice={tileCameraSwitch}
      onRefreshVideoDevices={refreshVideoDevices}
      renderTileActions={tileActions.renderTileActions}
    >
      {/* Words-when-degraded: the bar carries no ambient health dot, so a poor
          connection announces itself in a sentence instead. Full disconnects
          are covered by the reconnecting overlay. */}
      {meeting.connectionQuality === "poor" && !showReconnecting && !meeting.isPhone && (
        <div {...stylex.props(styles.notice, styles.noticeBelowHeader)} role="status">
          Your connection is unstable — audio and video quality may drop for a moment.
        </div>
      )}

      <React.Suspense fallback={null}>
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
      </React.Suspense>

      {tileActions.dialog}

      {extensions?.leaveOverlay}

      {hasCommandPalette && commands.mounted && (
        <React.Suspense fallback={null}>
          <LazyCommandPalette
            open={commands.open}
            onOpenChange={commands.setOpen}
            commands={commandInput}
            onAskOrb={askOrbInRoom}
          />
        </React.Suspense>
      )}

      {/* On its side, a phone has no header: the room's name rides on the stage. */}
      {phoneLandscape && (
        <div {...stylex.props(styles.landscapeIdentity, inStage.top("0.5rem"))}>
          <span {...stylex.props(styles.landscapeTitle)}>{meeting.meetingTitle || meeting.code}</span>
        </div>
      )}
      {/* On a phone's board the bottom is the pager's: the caption is Talk's. */}
      {meeting.isPhone && !hasContent && <div {...stylex.props(styles.phoneCaption)}>{caption("card")}</div>}

      {extensions?.overlay}

      {showRequestTray && (
        <div {...stylex.props(styles.requestTray, onBoard.spanX, inStage.top(requestTrayTopGap))}>
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
    </MeetingStageLayout>
  );
}
/* oxlint-enable react/refs */
