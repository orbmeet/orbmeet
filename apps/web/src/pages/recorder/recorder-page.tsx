import { ClientOnly, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { LIVE_CALL_PAGE_CLASS } from "@/modules/meetings/client/use-live-call-page";
import type { MeetingClockSync } from "@/modules/meetings/client/meeting-clock";
import { spinner } from "@orbmeet/ui/styles/animations";
import { decor, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  loadRecorderModule as loadWhiteboardRecorderModule,
  type RecorderStatus,
} from "@/modules/whiteboards/client/meeting/whiteboard-recorder";
import {
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, RoomEvent, Track } from "livekit-client";
import {
  isRecorderStartupBlockedByWhiteboard,
  isRecorderStartupBlockedByWhiteboardContent,
  parseRecorderHashParams,
  selectRecorderStage,
  shouldMountRecorderWhiteboard,
  shouldWaitForRecorderWhiteboard,
  type RecorderEgressMode,
  type RecorderStage,
} from "@/modules/meetings/client/recorder-state";
import { useMeetingRoomState } from "@/modules/meetings/client/use-meeting-live-state";
import { RecorderAudioMixer } from "@/modules/meetings/client/recorder/recorder-audio";
import { configureLiveKitLogging } from "@/modules/meetings/client/livekit-logging";
import {
  MeetingStageLayout,
  type MeetingStageSurface,
} from "@/modules/meetings/client/components/meeting-stage-layout";
import { useLiveKitConnections } from "@/modules/meetings/client/use-livekit-connections";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { RECORDER_ROOM_MEDIA_OPTIONS } from "@/modules/meetings/client/media-quality";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { ToastProvider, TooltipProvider } from "@orbmeet/ui/react";

configureLiveKitLogging();

const WB_CONNECT_TIMEOUT_MS = 10_000;
const WB_CONTENT_TIMEOUT_MS = 3_000;
const RECORDER_BACKGROUND = "#f2f0ec";
const RECORDER_WHITEBOARD_AUTH_URL = "/api/whiteboard/recorder-auth";

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
    document.documentElement.classList.add(LIVE_CALL_PAGE_CLASS);
    return () => document.documentElement.classList.remove(LIVE_CALL_PAGE_CLASS);
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
  // Single room-metadata subscription for both surface state and egress mode.
  const roomState = useMeetingRoomState(room);
  const surface = roomState?.surface ?? null;
  const egressMode: RecorderEgressMode = roomState ? roomState.egressMode : initialEgressMode;
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
  const startedRef = React.useRef(false);
  // The recording's own clock: it starts at mount, on this machine's time.
  const [recorderClock] = React.useState<MeetingClockSync>(() => {
    const now = Date.now();
    return { meetingStartedAtMs: now, serverClockOffsetMs: 0, receivedAtMs: now };
  });
  const meetingStartTimeMs = recorderClock.meetingStartedAtMs;

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

  const remoteParticipants = React.useMemo(
    () => connectedParticipants.filter((participant) => participant.identity !== localParticipant.identity),
    [connectedParticipants, localParticipant.identity],
  );

  const stageSurface = React.useMemo<MeetingStageSurface>(
    () => ({
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
              recorderAuthUrl={RECORDER_WHITEBOARD_AUTH_URL}
              onStatusChange={setWbStatus}
              onContentStateChange={setWbHasContent}
            />
          </div>
        </React.Suspense>
      ),
    }),
    [hasWhiteboard, presentedWhiteboardId, recorderToken, showWhiteboard, wbStatus, whiteboardUrl],
  );

  return (
    <>
      <RecorderAudioMixer />
      <MeetingStageLayout
        code={meetingCode || "orbmeet"}
        meetingClock={recorderClock}
        isRecording={egressMode === "recording"}
        isStreaming={egressMode === "streaming"}
        readOnly
        isPhone={responsive.isPhone}
        isLandscape={responsive.isLandscape}
        isNarrow={responsive.isPhone || (responsive.isTablet && !responsive.isLandscape)}
        useBottomSheet={responsive.useBottomSheet}
        connectedParticipants={remoteParticipants}
        currentIdentity={localParticipant.identity}
        isConnecting={connectionState === ConnectionState.Connecting}
        isReconnecting={
          connectionState === ConnectionState.Reconnecting ||
          connectionState === ConnectionState.SignalReconnecting
        }
        showScreenShareStage={screenShareTracks.length > 0}
        surface={stageSurface}
        surfaceLabel="Whiteboard"
      />
    </>
  );
}

function parseRecorderEgressMode(value: string | null): RecorderEgressMode {
  return value === "recording" || value === "streaming" ? value : null;
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
