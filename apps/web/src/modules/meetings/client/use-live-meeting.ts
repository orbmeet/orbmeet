import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ConnectionQuality,
  ConnectionState,
  Track,
  type Participant,
} from "livekit-client";
import {
  useConnectionQualityIndicator,
  useConnectionState,
  useLocalParticipant,
  useParticipantAttribute,
  useTracks,
} from "@livekit/components-react";
import { isModerationRole } from "@/modules/meetings/contract/constants";
import { PARTICIPANT_ATTRIBUTE, parseParticipantRole } from "@/modules/meetings/contract/live-state";

import {
  useLiveKitChat,
  useLiveKitConnections,
  useHandRaises,
  type ParticipantConnection,
  type LiveKitChatMessage,
  type HandRaise,
} from "@/modules/meetings/client";
import { useBackgroundEffect, type BackgroundMode } from "@/modules/meetings/client/use-background-effect";
import { logError } from "@/lib/logger";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { useToast } from "@orbmeet/ui/react";
import { useMeetingLifecycle } from "@/modules/meetings/client/use-meeting-lifecycle";
import { useMeetingUI } from "@/modules/meetings/client/use-meeting-ui";
import { useMeetingScreenShare } from "@/modules/meetings/client/use-meeting-screen-share";
import { useMeetingAdmissions } from "@/modules/meetings/client/use-meeting-admissions";
import { setMeetingJoinPolicy } from "@/modules/meetings/server/runtime/live.functions";
import { useMeetingRoomState } from "@/modules/meetings/client/use-meeting-live-state";
import { useMeetingRecording } from "@/modules/meetings/client/use-meeting-recording";
import { useMeetingStreaming } from "@/modules/meetings/client/use-meeting-streaming";
import { useMeetingCaptions } from "@/modules/meetings/client/captions/use-meeting-captions";
import { useMeetingCamera } from "@/modules/meetings/client/use-meeting-camera";
import { useMeetingAudioDevice } from "@/modules/meetings/client/use-meeting-audio-device";
import { useTrackSubscriptionFailures } from "@/modules/meetings/client/use-track-subscription-failures";
import { useMeetingLeaveEnd } from "@/modules/meetings/client/use-meeting-leave-end";
import { useMeetingMicrophone } from "@/modules/meetings/client/use-meeting-microphone";
import { useMeetingTranscription } from "@/modules/meetings/client/use-meeting-transcription";
import type { MicrophoneInterruptionCause } from "@/modules/meetings/client/audio/microphone-interruption";
import { useMeetingAudioNetworkHealth } from "@/modules/meetings/client/use-meeting-audio-network-health";
import { useSharedCountdown } from "@/modules/meetings/client/use-shared-countdown";
import { useMeetingModerators } from "@/modules/meetings/client/use-meeting-moderators";
import { useMeetingRemovals } from "@/modules/meetings/client/use-meeting-removals";
import { configureLiveKitLogging } from "@/modules/meetings/client/livekit-logging";
import type { MeetingClockSync } from "@/modules/meetings/client/meeting-clock";
import { useMeetingClockSync } from "@/modules/meetings/client/use-meeting-elapsed-seconds";
import type { JoinResult } from "@/modules/meetings/contract/types";
import type { MeetingLifecycleHooks, HostPermissionRequest } from "@/modules/meetings/client/types";
import type { MeetingEntrySession } from "@/modules/meetings/client/entry/meeting-entry-session";
import type { LocalMediaIntent } from "@/modules/meetings/client/entry/local-media-intent";

configureLiveKitLogging();

// Re-export types consumed by components that import from this module
export type { MeetingLifecycleHooks, HostPermissionRequest };

export interface LiveMeetingProps {
  code: string;
  joinResult: JoinResult;
  /**
   * The entry session this connection belongs to. The meeting reports what
   * happens to the participant's access here, and records every media choice
   * in `entry.intent` so the next connection starts from it.
   */
  entry: MeetingEntrySession;
  showConnectingOverlay: boolean;
  isAuthenticated: boolean;
}

export interface LiveMeetingState {
  // ── Route/context props ──
  code: string;
  meetingClock: MeetingClockSync;
  showConnectingOverlay: boolean;
  recordingEnabled: boolean;
  meetingTitle: string | null;
  spaceName: string | null;
  joinPolicy: "open" | "approval_required" | "closed";
  admissionPolicyPending: boolean;
  isEgress?: boolean;

  // ── Core lifecycle ──
  roomInstance: ReturnType<typeof useMeetingLifecycle>["roomInstance"];
  mediaScope: ReturnType<typeof useMeetingLifecycle>["mediaScope"];
  currentUserId: string;
  currentUserName: string;
  connectionQuality: "excellent" | "good" | "poor" | "disconnected";
  handleLiveKitRoomUpdate: ReturnType<typeof useMeetingLifecycle>["handleLiveKitRoomUpdate"];
  disconnectMeetingNow: () => Promise<void>;

  // ── Responsive ──
  isPhone: boolean;
  isTablet: boolean;
  isLandscape: boolean;
  isNarrow: boolean;
  controlBarAutoHide: boolean;
  useBottomSheet: boolean;

  // ── Connection / auth ──
  canModerate: boolean;
  canManageMeeting: boolean;
  countdown?: ReturnType<typeof useSharedCountdown>;

  // ── Connections & participants ──
  connectedParticipants: ParticipantConnection[];
  participantsList: Array<{
    id: string;
    name: string;
    role: ParticipantConnection["role"];
    isGuest: boolean;
    isMicOn?: boolean;
  }>;
  moderators?: ReturnType<typeof useMeetingModerators>;
  removals?: ReturnType<typeof useMeetingRemovals>;

  // ── Chat ──
  chatMessages: LiveKitChatMessage[];
  /**
   * Sends to everyone, or — with `to` — only to that one person. Anything
   * that wraps this must pass `to` on: dropping it would send a private
   * message to the whole room.
   */
  sendChatMessage: (text: string, to: { id: string; name: string } | undefined) => Promise<boolean>;

  // ── Hand raises ──
  handRaiseQueue: HandRaise[];
  isHandRaised: boolean;
  raiseHand: () => void;
  lowerHand: () => void;
  approveHandRaise: (identity: string) => void;
  dismissHandRaise: (identity: string) => void;

  // ── Screen share (slice from useMeetingScreenShare) ──
  screenShare: ReturnType<typeof useMeetingScreenShare>;

  // ── Admissions / security ──
  handleApproveAdmission: (admissionId: string) => Promise<void>;
  handleDenyAdmission: (admissionId: string) => Promise<void>;
  handleToggleMeetingSecurity: () => Promise<void>;
  hostPermissionRequests: HostPermissionRequest[];

  // ── Recording / Streaming / Captions / Camera / Leave-End slices ──
  recording: ReturnType<typeof useMeetingRecording>;
  streaming: ReturnType<typeof useMeetingStreaming>;
  captions: ReturnType<typeof useMeetingCaptions>;
  transcription: ReturnType<typeof useMeetingTranscription>;

  // ── Track state from LiveKit ──
  hasScreenShare: boolean;
  /**
   * Who is sharing their screen: their name, or null while it is this
   * participant's own screen, or nobody's.
   */
  screenSharerName: string | null;
  isMicOn: boolean;
  isMicPending: boolean;
  handleToggleMic: () => void;
  /** Why the microphone that is on is not reaching the meeting, or null while it is. */
  micInterruption: MicrophoneInterruptionCause | null;
  /** Restart a stopped microphone from inside a click. */
  resumeMic: () => void;
  isCameraOn: boolean;
  isScreenSharing: boolean;

  // ── Connection overlay ──
  isLiveKitConnecting: boolean;
  isLiveKitReconnecting: boolean;
  connectionOverlayLabel: string;

  // ── UI state (from useMeetingUI) ──
  ui: ReturnType<typeof useMeetingUI>;

  // ── Background effect ──
  bgEffect: {
    mode: BackgroundMode;
    imagePath: string | null;
    isSupported: boolean;
    isProcessing: boolean;
    lastError: string | null;
    setBlur: () => void;
    setImage: (path: string) => void;
    clearEffect: () => void;
  };

  // ── Media device switching (slices) ──
  audioDevice: ReturnType<typeof useMeetingAudioDevice>;
  camera: ReturnType<typeof useMeetingCamera>;

  // ── Leave / End (slice) ──
  leaveEnd: ReturnType<typeof useMeetingLeaveEnd>;

  // ── Toast helper ──
  addToast: ReturnType<typeof useToast>["add"];
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useLiveMeeting(
  props: LiveMeetingProps,
  lifecycleHooks?: MeetingLifecycleHooks,
): LiveMeetingState {
  const {
    code,
    joinResult,
    entry,
    showConnectingOverlay,
    isAuthenticated,
  } = props;

  // What this connection starts from. Later choices go back into the store and
  // reach the next connection; this one is already running with them.
  const [initialIntent] = React.useState(() => requireIntent(entry));
  const recordChoice = React.useCallback(
    (choice: Partial<LocalMediaIntent>) => entry.intent.update(choice),
    [entry],
  );
  const onJoinResultUpdate = React.useCallback(
    (updates: Partial<JoinResult>) => entry.accessUpdated(updates),
    [entry],
  );
  const onCaptionLanguageConfirmed = React.useCallback(
    (language: string) => recordChoice({ captionLanguage: language }),
    [recordChoice],
  );
  const onIntentionalDisconnect = React.useCallback(() => entry.beginLeave(), [entry]);

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { add: addToast } = useToast();
  // Reconciled here, not in the header: this hook owns the join result and
  // outlives every layout change, so the offset is sampled exactly once per
  // server response.
  const meetingClock = useMeetingClockSync({
    meetingStartedAtMs: joinResult.meetingStartedAtMs,
    serverNowMs: joinResult.serverNowMs,
  });
  const {
    isPhone,
    isTablet,
    isLandscape,
    isNarrow,
    controlBarAutoHide,
    useBottomSheet,
  } = useResponsive();

  // ── Core lifecycle ──
  const {
    roomInstance,
    mediaScope,
    handleLiveKitRoomUpdate,
    disconnectMeetingNow,
  } = useMeetingLifecycle();
  const { localParticipant } = useLocalParticipant();
  const currentUserId = localParticipant.identity;
  const currentUserName = localParticipant.name || localParticipant.identity;
  const connectionQuality = useLocalConnectionQuality(localParticipant);

  // ── Captions ──
  const captions = useMeetingCaptions({
    roomInstance,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    initialCaptionLanguage: initialIntent.captionLanguage,
    onCaptionLanguageConfirmed,
  });

  // ── Live authority projection ──
  // Once LiveKit shows the coordinator's role attribute it is the authority,
  // so a revoked moderator loses controls the moment the room says so. Until
  // then the join response stands in.
  const liveRole = parseParticipantRole(
    useParticipantAttribute(PARTICIPANT_ATTRIBUTE.role, { participant: localParticipant }),
  );
  const canModerate = liveRole ? isModerationRole(liveRole) : joinResult.canModerate;
  const canManageMeeting = liveRole ? liveRole === "host" : joinResult.canManageMeeting;
  // The coordinator publishes the join policy in room metadata, so a change by
  // any manager reaches every moderator at once.
  const roomState = useMeetingRoomState(roomInstance);
  const joinPolicy = roomState?.joinPolicy ?? joinResult.joinPolicy;
  // The coordinator says the meeting ended before it removes anyone, so the
  // removal that follows is never taken for a kick to rejoin from.
  const meetingEnded = roomState?.ended ?? false;
  React.useEffect(() => {
    if (meetingEnded) entry.meetingEnded();
  }, [entry, meetingEnded]);
  const [admissionPolicyPending, setAdmissionPolicyPending] = React.useState(false);

  // ── Connections, chat, hand raises, reactions ──
  const connectedParticipants = useLiveKitConnections(roomInstance);

  const handleSendError = React.useCallback(() => {
    logError("[Meeting] Failed to send message");
  }, []);

  const countdown = useSharedCountdown({
    room: roomInstance,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    canControl: canModerate,
    meetingClock,
  });

  const {
    messages: chatMessages,
    remoteMessageCount: remoteChatMessageCount,
    sendMessage: sendChatMessage,
  } = useLiveKitChat(
    roomInstance,
    currentUserId,
    currentUserName,
    100,
    handleSendError,
  );

  const {
    handRaiseQueue,
    isHandRaised,
    raiseHand,
    lowerHand,
    approveHandRaise,
    dismissHandRaise,
  } = useHandRaises({
    room: roomInstance,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    canModerate,
    serverClockOffsetMs: meetingClock.serverClockOffsetMs,
  });

  // ── Screen share ──
  const screenShare = useMeetingScreenShare({
    roomInstance,
    canModerate,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    addToast,
  });

  const admissions = useMeetingAdmissions({
    meetingId: joinResult.meetingId,
    managerConnectionId: joinResult.connectionId,
    canModerate,
    room: roomInstance,
    addToast,
  });
  const moderators = useMeetingModerators({
    meetingId: joinResult.meetingId,
    canManageMeeting,
    addToast,
  });
  const removals = useMeetingRemovals({
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    canModerate,
    room: roomInstance,
    addToast,
  });

  const handleToggleMeetingSecurity = React.useCallback(async () => {
    if (!canManageMeeting || admissionPolicyPending) return;
    const nextJoinPolicy = joinPolicy === "approval_required" ? "open" : "approval_required";
    setAdmissionPolicyPending(true);
    try {
      const result = await setMeetingJoinPolicy({
        data: { meetingId: joinResult.meetingId, joinPolicy: nextJoinPolicy },
      });
      onJoinResultUpdate({ joinPolicy: result.joinPolicy });
      addToast({
        title: result.joinPolicy === "approval_required" ? "Approval required" : "Meeting active",
        description: result.joinPolicy === "approval_required"
          ? "New joiners now need host approval."
          : "New joiners can enter without approval.",
        data: { variant: "success" },
      });
    } catch (err) {
      logError("[Meeting] Failed to update meeting admission policy:", err);
      addToast({
        title: "Security update failed",
        description: "Could not update who needs approval to join.",
        data: { variant: "error" },
      });
    } finally {
      setAdmissionPolicyPending(false);
    }
  }, [
    addToast,
    admissionPolicyPending,
    canManageMeeting,
    joinResult.meetingId,
    joinPolicy,
    onJoinResultUpdate,
  ]);

  // ── LiveKit track state ──
  const screenShareTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const hasScreenShare = screenShareTracks.length > 0;
  const remoteSharer = screenShareTracks.find((track) => !track.participant.isLocal)?.participant;
  const screenSharerName = remoteSharer ? remoteSharer.name || remoteSharer.identity : null;

  const liveKitConnectionState = useConnectionState();
  const isLiveKitConnecting = liveKitConnectionState === ConnectionState.Connecting;
  const isLiveKitReconnecting =
    liveKitConnectionState === ConnectionState.Reconnecting ||
    liveKitConnectionState === ConnectionState.SignalReconnecting;
  const connectionOverlayLabel = isLiveKitReconnecting ? "Reconnecting meeting..." : "Joining meeting...";

  const isCameraOn = localParticipant.isCameraEnabled;
  const isScreenSharing = localParticipant.isScreenShareEnabled;
  const microphone = useMeetingMicrophone({
    roomInstance,
    code,
    addToast,
    onChoice: recordChoice,
  });
  // Intent, not the published track: the control reflects what the user asked
  // for and stays responsive while reconciliation catches up.
  const isMicOn = microphone.isMicOn;
  useMeetingAudioNetworkHealth({ room: roomInstance, isMicOn, code });

  // ── Recording ──
  const recording = useMeetingRecording({
    meetingId: joinResult.meetingId,
    recordingActive: joinResult.recordingActive ?? false,
    egressStateRevision: joinResult.egressStateRevision,
    roomInstance,
    addToast,
  });

  // ── Streaming ──
  const streaming = useMeetingStreaming({
    meetingId: joinResult.meetingId,
    streamingActive: joinResult.streamingActive ?? false,
    egressStateRevision: joinResult.egressStateRevision,
    roomInstance,
    addToast,
  });

  // ── UI state ──
  const ui = useMeetingUI({
    remoteChatMessageCount,
    controlBarAutoHide,
    canModerate,
    isHandRaised,
    raiseHand,
    lowerHand,
  });

  /*
   * Announce a raised hand to the people who can act on it.
   *
   * The queue recorded raises correctly, but nothing outside the queue panel
   * ever mentioned them — no toast, no tile marker, no count. A host had to
   * open the panel on a hunch to discover someone had been waiting, which in a
   * real meeting means the hand is never seen at all. The dock badge covers the
   * steady state; this covers the moment of arrival.
   */
  const announcedRaisesRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!canModerate) return;
    const pending = handRaiseQueue.filter((raise) => raise.status === "pending");
    const seen = announcedRaisesRef.current;

    for (const raise of pending) {
      if (seen.has(raise.nonce)) continue;
      seen.add(raise.nonce);
      // Sync replies reconstruct existing participant-owned state when a
      // moderator joins or is promoted. The queue badge is sufficient for
      // that snapshot; treating every replay as a new event causes a toast
      // storm proportional to the number of waiting hands.
      if (raise.replayed) continue;
      // Suppress the toast while the queue is on screen — the entry lands there
      // in the same tick, so a toast would only repeat it.
      if (ui.panel === "timeline") continue;
      addToast({
        title: `${raise.userName} raised their hand`,
        description: "It is waiting at the top of the conversation.",
      });
    }

    // Forget resolved raises so the same person raising again is announced.
    const stillPending = new Set(pending.map((raise) => raise.nonce));
    for (const nonce of seen) {
      if (!stillPending.has(nonce)) seen.delete(nonce);
    }
  }, [handRaiseQueue, canModerate, ui.panel, addToast]);

  // ── Background effect ──
  // Seeded from the pre-join selection so blur / virtual background survives
  // the pre-join → room handoff (the preview track's processor is released at
  // join and LiveKit publishes a fresh, unprocessed capture).
  const initialBgPreference = React.useMemo(
    () => ({ mode: initialIntent.bgMode, imagePath: initialIntent.bgImagePath }),
    [initialIntent],
  );
  const bgEffect = useBackgroundEffect(roomInstance, initialBgPreference, recordChoice);

  React.useEffect(() => {
    if (!bgEffect.lastError) return;
    addToast({
      title: "Background effect failed",
      description: bgEffect.lastError,
      data: { variant: "error" },
    });
  }, [bgEffect.lastError, addToast]);

  // ── Camera ──
  const camera = useMeetingCamera({
    roomInstance,
    isCameraOn,
    initialVideoDeviceId: initialIntent.videoDeviceId,
    addToast,
    onChoice: recordChoice,
  });
  const audioDevice = useMeetingAudioDevice({
    roomInstance,
    initialAudioDeviceId: initialIntent.audioDeviceId,
    initialAudioOutputDeviceId: initialIntent.audioOutputDeviceId,
    addToast,
    onChoice: recordChoice,
  });

  // ── Remote track subscription failures ──
  // Surfaces + best-effort recovers when a remote participant's audio/video
  // track fails to subscribe (server-side "track not bound after timeout").
  useTrackSubscriptionFailures({ roomInstance, addToast, code });

  // ── Leave / End ──
  const leaveEnd = useMeetingLeaveEnd({
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    admissionId: joinResult.admissionId,
    code,
    isAuthenticated,
    navigate,
    queryClient,
    onIntentionalDisconnect,
    lifecycleHooks,
    disconnectMeetingNow,
    addToast,
  });

  // ── Derived ──
  const participantsList = React.useMemo(
    () =>
      connectedParticipants.map((p) => ({
        id: p.identity,
        name: p.userName,
        role: p.role,
        isGuest: p.isGuest,
        isMicOn: p.isMicrophoneEnabled,
      })),
    [connectedParticipants],
  );
  const transcription = useMeetingTranscription({
    room: roomInstance,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    canModerate,
    initiallyOn: joinResult.transcription ?? true,
    addToast,
  });
  const hostPermissionRequests = React.useMemo(
    () => [
      ...screenShare.hostPermissionRequests,
      ...admissions.hostPermissionRequests,
      ...transcription.requests,
    ],
    [screenShare.hostPermissionRequests, admissions.hostPermissionRequests, transcription.requests],
  );

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------
  return {
    // Route/context props
    code,
    meetingClock,
    showConnectingOverlay,
    recordingEnabled: joinResult.recordingEnabled ?? false,
    meetingTitle: joinResult.meetingTitle,
    spaceName: joinResult.spaceName ?? null,
    joinPolicy,
    admissionPolicyPending,

    // Core lifecycle
    roomInstance,
    mediaScope,
    currentUserId,
    currentUserName,
    connectionQuality,
    handleLiveKitRoomUpdate,
    disconnectMeetingNow,

    // Responsive
    isPhone,
    isTablet,
    isLandscape,
    isNarrow,
    controlBarAutoHide,
    useBottomSheet,

    // Connection / auth
    canModerate,
    canManageMeeting,
    countdown,

    // Connections & participants
    connectedParticipants,
    participantsList,
    moderators,
    removals,

    // Chat
    chatMessages,
    sendChatMessage,

    // Hand raises
    handRaiseQueue,
    isHandRaised,
    raiseHand,
    lowerHand,
    approveHandRaise,
    dismissHandRaise,

    // Cohesive sub-hook slices (exposed directly, matching ui/bgEffect)
    screenShare,
    recording,
    streaming,
    captions,
    transcription,

    // Admissions / security
    handleApproveAdmission: admissions.handleApproveAdmission,
    handleDenyAdmission: admissions.handleDenyAdmission,
    handleToggleMeetingSecurity,
    hostPermissionRequests,

    // Track state from LiveKit
    hasScreenShare,
    screenSharerName,
    isMicOn,
    isMicPending: microphone.isMicPending,
    handleToggleMic: microphone.handleToggleMic,
    micInterruption: microphone.micInterruption,
    resumeMic: microphone.resumeMic,
    isCameraOn,
    isScreenSharing,

    // Connection overlay
    isLiveKitConnecting,
    isLiveKitReconnecting,
    connectionOverlayLabel,

    // UI state
    ui,

    // Audio cancellation

    // Background effect
    bgEffect,

    // Media device switching + Leave/End slices
    audioDevice,
    camera,
    leaveEnd,

    // Toast helper
    addToast,
  };
}

/**
 * The local connection's quality as the meeting shows it. LiveKit reports
 * Unknown until its first stats report, a few seconds after join; showing
 * that as poor flashed the unstable banner at everyone on entry, so the last
 * known value is held instead.
 */
function useLocalConnectionQuality(participant: Participant): LiveMeetingState["connectionQuality"] {
  const { quality } = useConnectionQualityIndicator({ participant });
  const [known, setKnown] = React.useState(ConnectionQuality.Excellent);
  if (quality !== ConnectionQuality.Unknown && quality !== known) setKnown(quality);
  switch (known) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Lost:
      return "disconnected";
    default:
      return "poor";
  }
}

function requireIntent(entry: MeetingEntrySession): LocalMediaIntent {
  const intent = entry.intent.get();
  // The session records the pre-join choices before it can issue access, so
  // a mounted meeting always has them.
  if (!intent) throw new Error("A meeting connection was mounted before the participant joined");
  return intent;
}
