import { ClientOnly, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { useMeetingClockSync } from "@/modules/meetings/client/use-meeting-elapsed-seconds";
import { spinner } from "@orbmeet/ui/styles/animations";
import { decor, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  loadRecorderModule as loadWhiteboardRecorderModule,
  type RecorderStatus,
} from "@/modules/whiteboards/client/meeting/whiteboard-recorder";
import { whiteboardServiceEndpoints } from "@/modules/whiteboards/client/whiteboard-service-endpoints";
import {
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, RoomEvent, Track, type Room } from "livekit-client";
import {
  isRecorderStartupBlockedByWhiteboardContent,
  isRecorderStartupBlockedByWhiteboard,
  shouldMountRecorderWhiteboard,
  shouldWaitForRecorderWhiteboard,
} from "@/modules/meetings/client/recorder-layout";
import { parseRecorderHashParams } from "@/modules/meetings/client/recorder-url-params";
import { selectRecorderStage, type RecorderStage } from "@/modules/meetings/client/recorder-stage";
import { useMeetingRoomState } from "@/modules/meetings/client/use-meeting-live-state";
import { RecorderAudioMixer } from "@/modules/meetings/client/recorder/recorder-audio";
import { configureLiveKitLogging } from "@/modules/meetings/client/livekit-logging";
import {
  LiveMeetingLayout,
  type MeetingExtensions,
} from "@/modules/meetings/client/components/live-meeting-layout";
import type { LiveMeetingState } from "@/modules/meetings/client/use-live-meeting";
import { useLiveKitConnections } from "@/modules/meetings/client/use-livekit-connections";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { RECORDER_ROOM_MEDIA_OPTIONS } from "@/modules/meetings/client/media-quality";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { ToastProvider } from "@orbmeet/ui/react";
import { TooltipProvider } from "@orbmeet/ui/react";

configureLiveKitLogging();

const WB_CONNECT_TIMEOUT_MS = 10_000;
const WB_CONTENT_TIMEOUT_MS = 3_000;
const RECORDER_BACKGROUND = "#f2f0ec";

const styles = stylex.create({
  /** Shown only while the recorder client boots; never appears in a capture. */
  bootScreen: {
    display: "flex",
    minHeight: "100vh",
    alignItems: "center",
    justifyContent: "center",
  },
  bootSpinner: { width: 24, height: 24, borderWidth: 2, borderTopColor: neutral.n600 },
  invalidScreen: { width: "100vw", height: "100vh", backgroundColor: decor.voidGround },
  recorderRoom: { width: "100vw", height: "100vh", backgroundColor: RECORDER_BACKGROUND },
  /** The captured surface. Opaque white, because the encoder records it. */
  stage: { height: "100%", width: "100%", backgroundColor: surface.raised },
});
type RecorderEgressMode = "recording" | "streaming" | null;
type RecorderStartupSnapshot = {
  elapsedMs: number;
  lkReady: boolean;
  connectionState: string;
  egressMode: RecorderEgressMode;
  hasWhiteboard: boolean;
  recorderStage: RecorderStage;
  wbStatus: RecorderStatus;
  wbTimedOut: boolean;
  wbHasContent: boolean;
  wbContentTimedOut: boolean;
  whiteboardStartupBlocked: boolean;
  whiteboardContentBlocked: boolean;
};

const LazyRecorderWhiteboard = React.lazy(async () => {
  const module = await loadWhiteboardRecorderModule();
  return {
    default: module.RecorderWhiteboard,
  };
});

export function RecorderPage() {
  return (
    <ClientOnly
      fallback={
        <div {...stylex.props(styles.bootScreen)}>
          <div {...stylex.props(spinner.ring, spinner.neutral, styles.bootSpinner)} />
        </div>
      }
    >
      <RecorderPageInner />
    </ClientOnly>
  );
}

function RecorderPageInner() {
  const router = useRouter();
  const hashParams = React.useMemo(
    () => parseRecorderHashParams(window.location.hash, window.location.search),
    [],
  );
  const livekitUrl = hashParams.get("url") || "";
  const livekitToken = hashParams.get("token") || "";
  const whiteboardUrl = hashParams.get("wb_url") || "";
  const recorderToken = hashParams.get("wb_recorder_token") || "";
  const meetingCode = hashParams.get("meeting_code") || "";
  const initialEgressMode = parseRecorderEgressMode(hashParams.get("egress_mode"));

  React.useEffect(() => {
    const secretUrlParts = `${window.location.search}${window.location.hash}`;
    const urlHasRecorderSecrets =
      secretUrlParts.includes("token=") ||
      secretUrlParts.includes("wb_recorder_token=");
    if (!urlHasRecorderSecrets) return;
    router.history.replace(
      window.location.pathname,
      router.history.location.state,
      { ignoreBlocker: true },
    );
  }, [router]);

  React.useEffect(() => {
    document.body.classList.add("meet-route");
    return () => document.body.classList.remove("meet-route");
  }, []);

  // The recorder route is only for the internal LiveKit egress bot, which
  // names its own node in the URL. Which hosts it may reach is enforced by the
  // meet-route CSP, whose connect-src lists exactly the configured media nodes
  // and the whiteboard domain, so an attacker-supplied URL cannot be connected
  // to. Here only the schemes are checked.
  const urlIsValid = isLiveKitSignalUrl(livekitUrl);
  const wbUrlIsValid = !whiteboardUrl || isWhiteboardSyncUrl(whiteboardUrl);

  if (!livekitUrl || !livekitToken || !urlIsValid || !wbUrlIsValid) {
    return <div {...stylex.props(styles.invalidScreen)} />;
  }

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={livekitToken}
      connect={true}
      audio={false}
      video={false}
      options={RECORDER_ROOM_MEDIA_OPTIONS}
      {...stylex.props(styles.recorderRoom)}
    >
      <ToastProvider>
        <TooltipProvider>
          <RecorderMeetingContent
            initialEgressMode={initialEgressMode}
            meetingCode={meetingCode}
            whiteboardUrl={whiteboardUrl}
            recorderToken={recorderToken}
          />
        </TooltipProvider>
      </ToastProvider>
    </LiveKitRoom>
  );
}

function RecorderMeetingContent({
  initialEgressMode,
  meetingCode,
  whiteboardUrl,
  recorderToken,
}: {
  initialEgressMode: RecorderEgressMode;
  meetingCode: string;
  whiteboardUrl: string;
  recorderToken: string;
}) {
  const room = useRoomContext();
  const responsive = useResponsive();
  const connectionState = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  const connectedParticipants = useLiveKitConnections(room);
  const screenShareTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true });
  // Connected once: a later reconnect does not hold the recording back again.
  const [lkReady, setLkReady] = React.useState(room.state === ConnectionState.Connected);
  if (!lkReady && connectionState === ConnectionState.Connected) setLkReady(true);
  const [wbStatus, setWbStatus] = React.useState<RecorderStatus>("loading");
  const [wbTimedOut, setWbTimedOut] = React.useState(false);
  const [wbHasContent, setWbHasContent] = React.useState(false);
  const [wbContentTimedOut, setWbContentTimedOut] = React.useState(false);
  // What the meeting shows everyone, from the room's own state.
  const surface = useMeetingRoomState(room)?.surface ?? null;
  const presentedWhiteboardId = surface?.whiteboardId ?? null;
  const recorderStage: RecorderStage = selectRecorderStage({
    hasScreenShare: screenShareTracks.length > 0,
    surface,
  });
  // A board that failed is tried again when the meeting shows a board anew.
  const presentedBoard = recorderStage === "whiteboard" ? surface?.whiteboardId ?? null : null;
  React.useEffect(() => {
    if (presentedBoard) setWbStatus((status) => (status === "error" ? "loading" : status));
  }, [presentedBoard]);
  const egressMode = useRecorderEgressMode(room, initialEgressMode);
  const startedRef = React.useRef(false);
  const [meetingStartTimeMs] = React.useState(() => Date.now());
  const [recorderServerNowMs] = React.useState(() => Date.now());
  // Both timestamps are sampled locally at mount, so the reconciled offset is
  // zero — but going through the same hook keeps one definition of the clock.
  const recorderClock = useMeetingClockSync({
    meetingStartedAtMs: meetingStartTimeMs,
    serverNowMs: recorderServerNowMs,
  });

  const hasWhiteboard = Boolean(whiteboardUrl && recorderToken);
  const showWhiteboard = shouldMountRecorderWhiteboard({
    hasWhiteboard,
    stage: recorderStage,
    wbStatus,
  });
  const shouldWaitForWhiteboard = shouldWaitForRecorderWhiteboard({
    egressMode,
    hasWhiteboard,
    stage: recorderStage,
  });
  const whiteboardStartupBlocked = isRecorderStartupBlockedByWhiteboard({
    egressMode,
    hasWhiteboard,
    stage: recorderStage,
    wbStatus,
    wbTimedOut,
  });
  const whiteboardContentBlocked = isRecorderStartupBlockedByWhiteboardContent({
    egressMode,
    hasWhiteboard,
    stage: recorderStage,
    wbStatus,
    wbHasContent,
    wbContentTimedOut,
  });

  React.useEffect(() => {
    if (!lkReady || !shouldWaitForWhiteboard || wbStatus !== "loading" || wbTimedOut) return;
    const t = setTimeout(() => setWbTimedOut(true), WB_CONNECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [lkReady, shouldWaitForWhiteboard, wbStatus, wbTimedOut]);

  React.useEffect(() => {
    if (
      !lkReady ||
      !shouldWaitForWhiteboard ||
      wbStatus !== "ready" ||
      wbHasContent ||
      wbContentTimedOut
    ) {
      return;
    }
    const t = setTimeout(() => setWbContentTimedOut(true), WB_CONTENT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [
    lkReady,
    shouldWaitForWhiteboard,
    wbStatus,
    wbHasContent,
    wbContentTimedOut,
  ]);

  React.useEffect(() => {
    if (!shouldWaitForWhiteboard) {
      setWbHasContent(false);
      setWbContentTimedOut(false);
      setWbTimedOut(false);
      return;
    }
    if (wbStatus !== "ready") {
      setWbContentTimedOut(false);
    }
  }, [shouldWaitForWhiteboard, wbStatus]);

  React.useEffect(() => {
    const endRecording = () => console.log("END_RECORDING");
    room.on(RoomEvent.Disconnected, endRecording);
    return () => { room.off(RoomEvent.Disconnected, endRecording); };
  }, [room]);

  React.useEffect(() => {
    if (startedRef.current) return;
    if (!lkReady) return;
    if (whiteboardStartupBlocked) return;
    if (whiteboardContentBlocked) return;
    startedRef.current = true;
    console.log("START_RECORDING");
  }, [lkReady, whiteboardStartupBlocked, whiteboardContentBlocked]);

  React.useEffect(() => {
    if (startedRef.current) return;

    const logStartupState = () => {
      const snapshot: RecorderStartupSnapshot = {
        elapsedMs: Date.now() - meetingStartTimeMs,
        lkReady,
        connectionState,
        egressMode,
        hasWhiteboard,
        recorderStage,
        wbStatus,
        wbTimedOut,
        wbHasContent,
        wbContentTimedOut,
        whiteboardStartupBlocked,
        whiteboardContentBlocked,
      };
      console.warn(`[Recorder] Waiting to signal START_RECORDING ${JSON.stringify(snapshot)}`);
    };

    logStartupState();
    const interval = window.setInterval(logStartupState, 5_000);
    return () => window.clearInterval(interval);
  }, [
    connectionState,
    egressMode,
    hasWhiteboard,
    lkReady,
    meetingStartTimeMs,
    recorderStage,
    wbContentTimedOut,
    wbHasContent,
    wbStatus,
    wbTimedOut,
    whiteboardContentBlocked,
    whiteboardStartupBlocked,
  ]);

  const noop = React.useCallback(() => {}, []);
  const noopAsync = React.useCallback(async () => {}, []);
  const noopToast = React.useCallback<LiveMeetingState["addToast"]>(() => "egress-toast", []);
  const egressUi = React.useMemo<LiveMeetingState["ui"]>(
    () => ({
      panel: null,
      openPanel: noop,
      togglePanel: noop,
      closePanel: noop,
      timelineUnreadCount: 0,
      controlsVisible: true,
      // A recording shows the board at full width; the faces stay a cluster.
      facesExpanded: false,
      showFaces: noop,
      foldFaces: noop,
      handleHandRaiseAction: noop,
    }),
    [noop],
  );

  const meeting = React.useMemo(
    () =>
      ({
        code: meetingCode || "orbmeet",
        meetingClock: recorderClock,
        showConnectingOverlay: false,
        recordingEnabled: false,
        meetingTitle: null,
        spaceName: null,
        joinPolicy: "open",
        admissionPolicyPending: false,
        isEgress: true,
        roomInstance: room,
        mediaScope: noop,
        currentUserId: localParticipant.identity,
        currentUserName: localParticipant.name || localParticipant.identity,
        connectionQuality:
          connectionState === ConnectionState.Connected ? "excellent" : "poor",
        handleLiveKitRoomUpdate: noop,
        disconnectMeetingNow: noopAsync,
        isPhone: responsive.isPhone,
        isTablet: responsive.isTablet,
        isLandscape: responsive.isLandscape,
        isNarrow: responsive.isPhone || (responsive.isTablet && !responsive.isLandscape),
        controlBarAutoHide: responsive.controlBarAutoHide,
        useBottomSheet: responsive.useBottomSheet,
        canModerate: false,
        canManageMeeting: false,
        connectedParticipants: connectedParticipants.filter(
          (participant) => participant.identity !== localParticipant.identity,
        ),
        participantsList: connectedParticipants
          .filter((participant) => participant.identity !== localParticipant.identity)
          .map((participant) => ({
            id: participant.identity,
            name: participant.userName,
            role: participant.role,
            isGuest: participant.isGuest,
          })),
        chatMessages: [],
        sendChatMessage: async () => true,
        handRaiseQueue: [],
        isHandRaised: false,
        raiseHand: noop,
        lowerHand: noop,
        approveHandRaise: noop,
        dismissHandRaise: noop,
        screenShare: {
          screenShareRequestState: "idle",
          isPreparingScreenShare: false,
          hasPreparedScreenShare: false,
          hasScreenSharePermission: false,
          handleToggleScreenShare: noopAsync,
          handleCancelScreenShareRequest: noop,
          handleDismissScreenShareDenied: noop,
          handleApproveScreenShare: noopAsync,
          handleDenyScreenShare: noopAsync,
          hostPermissionRequests: [],
        },
        handleApproveAdmission: noopAsync,
        handleDenyAdmission: noopAsync,
        handleToggleMeetingSecurity: noopAsync,
        hostPermissionRequests: [],
        recording: {
          isRecording: egressMode === "recording",
          recordingPending: false,
          handleToggleRecording: noopAsync,
        },
        streaming: {
          isStreaming: egressMode === "streaming",
          streamingPending: false,
          handleStartStreaming: noopAsync,
          handleStopStreaming: noopAsync,
        },
        captions: {
          showSpeech: false,
          showCaptionLanguagePicker: false,
          setShowCaptionLanguagePicker: noop,
          captionLanguage: "en-US",
          setCaptionLanguage: noop,
          captionLanguageLabel: "English",
          captionCountry: null,
          captions: [],
          toggleSpeech: noop,
          showCaptions: false,
          toggleCaptions: noop,
        },
        // The recorder neither shows nor changes transcription.
        transcription: {
          on: false,
          pending: false,
          setOn: noopAsync,
          asked: false,
          askToStop: noopAsync,
          takeBackAsk: noopAsync,
          requests: [],
          answerRequest: () => false,
        },
        hasScreenShare: screenShareTracks.length > 0,
        // A recording has no stage switch to name the sharer in.
        screenSharerName: null,
        isMicOn: false,
        isMicPending: false,
        handleToggleMic: noop,
        micInterruption: null,
        resumeMic: noop,
        isCameraOn: false,
        isScreenSharing: false,
        isLiveKitConnecting: connectionState === ConnectionState.Connecting,
        isLiveKitReconnecting:
          connectionState === ConnectionState.Reconnecting ||
          connectionState === ConnectionState.SignalReconnecting,
        connectionOverlayLabel: "Joining meeting...",
        ui: egressUi,
        bgEffect: {
          mode: "none",
          imagePath: null,
          isSupported: false,
          isProcessing: false,
          lastError: null,
          setBlur: noop,
          setImage: noop,
          clearEffect: noop,
        },
        audioDevice: {
          audioDevices: [],
          currentAudioDeviceId: undefined,
          activeAudioDeviceId: undefined,
          handleSelectAudioDevice: noopAsync,
          audioOutputDevices: [],
          currentAudioOutputDeviceId: undefined,
          activeAudioOutputDeviceId: undefined,
          handleSelectAudioOutputDevice: noopAsync,
          refreshAudioDevices: noopAsync,
        },
        camera: {
          videoDevices: [],
          currentVideoDeviceId: undefined,
          handleToggleCamera: noopAsync,
          handleSelectVideoDevice: noopAsync,
          refreshVideoDevices: noopAsync,
        },
        leaveEnd: {
          showEndConfirm: false,
          actionPending: false,
          setShowEndConfirm: noop,
          handleLeave: noopAsync,
          handleEnd: noopAsync,
          confirmLeave: noopAsync,
          confirmEnd: noopAsync,
        },
        addToast: noopToast,
      }) satisfies LiveMeetingState,
    [
      connectionState,
      egressUi,
      egressMode,
      localParticipant.identity,
      localParticipant.name,
      meetingCode,
      recorderClock,
      noop,
      noopAsync,
      noopToast,
      connectedParticipants,
      responsive.controlBarAutoHide,
      responsive.isLandscape,
      responsive.isPhone,
      responsive.isTablet,
      responsive.useBottomSheet,
      room,
      screenShareTracks.length,
    ],
  );

  const extensions = React.useMemo<MeetingExtensions>(
    () => ({
      surface: {
        show: showWhiteboard,
        canMount: hasWhiteboard,
        loading: showWhiteboard && wbStatus === "loading",
        error: showWhiteboard && wbStatus === "error",
        disabledByConfig: !hasWhiteboard,
        disabledReason: hasWhiteboard ? null : "Whiteboard is unavailable.",
        content: (
          <React.Suspense fallback={<div {...stylex.props(styles.stage)} />}>
            <div {...stylex.props(styles.stage)}>
              <LazyRecorderWhiteboard
                capabilities={getWhiteboardClientCapabilities()}
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
                whiteboardUrl={whiteboardUrl}
                recorderToken={recorderToken}
                whiteboardId={presentedWhiteboardId}
                serviceEndpoints={whiteboardServiceEndpoints}
                onStatusChange={setWbStatus}
                onContentStateChange={setWbHasContent}
              />
            </div>
          </React.Suspense>
        ),
      },
      surfaceToolbar: {
        label: "Whiteboard",
        active: showWhiteboard,
        onToggle: noop,
        disabled: !hasWhiteboard,
        disabledReason: hasWhiteboard ? null : "Whiteboard is unavailable.",
      },
    }),
    [hasWhiteboard, noop, presentedWhiteboardId, recorderToken, showWhiteboard, wbStatus, whiteboardUrl],
  );

  return (
    <>
      <RecorderAudioMixer />
      <LiveMeetingLayout meeting={meeting} extensions={extensions} />
    </>
  );
}

function parseRecorderEgressMode(value: string | null): RecorderEgressMode {
  return value === "recording" || value === "streaming" ? value : null;
}

/** The egress the room reports, or before it reports one, the mode the egress was started for. */
function useRecorderEgressMode(room: Room, initialEgressMode: RecorderEgressMode): RecorderEgressMode {
  const roomState = useMeetingRoomState(room);
  return roomState ? roomState.egressMode : initialEgressMode;
}

function isWhiteboardSyncUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isLiveKitSignalUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "wss:" || protocol === "ws:";
  } catch {
    return false;
  }
}

