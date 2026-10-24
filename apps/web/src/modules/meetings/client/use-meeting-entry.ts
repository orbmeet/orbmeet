import * as React from "react";
import {
  isBrowserSupported,
  type MediaDeviceFailure,
  type RoomConnectOptions,
  type RoomOptions,
} from "livekit-client";
import { useCommittedRef } from "@orbmeet/ui/react";
import { isInAppBrowserDocument } from "@/app/shell/in-app-browser";
import { logError, logWarn } from "@/lib/logger";
import { markMeetingEntryMetric } from "@/modules/meetings/client/entry-metrics";
import {
  emitMeetingEntryDiagnostic,
  setMeetingDiagnosticScope,
} from "@/modules/meetings/client/entry/diagnostics";
import type { LocalMediaIntent } from "@/modules/meetings/client/entry/local-media-intent";
import {
  MeetingEntrySession,
  type MeetingEntryLink,
  type MeetingEntrySnapshot,
} from "@/modules/meetings/client/entry/meeting-entry-session";
import { settledNodeLatencies } from "@/modules/meetings/client/entry/node-latency";
import { joinMeeting } from "@/modules/meetings/server/lifecycle/join.functions";
import { releaseMeetingAccess } from "@/modules/meetings/server/runtime/live.functions";
import { loadStoredMeetingDisplayName } from "./display-name-storage";
import {
  getAudioCaptureOptions,
  getCameraCaptureOptions,
  getInteractiveRoomMediaOptions,
} from "./media-quality";
import { MeetingReconnectPolicy } from "./meeting-reconnect-policy";
import {
  clearReconnectAdmissionId,
  loadReconnectAdmissionId,
  persistReconnectAdmissionId,
} from "./reconnect-storage";

/**
 * How long a join waits for the pre-join screen's node measurement to finish.
 * It is usually done already; past this, the Worker measures instead.
 */
const JOIN_LATENCY_WAIT_MS = 1_500;

/**
 * Why this browser cannot join, or null when it can.
 *
 * There is no version floor here: the client bundle builds for Vite's default
 * target, and whether a browser can place a call is LiveKit's question. What
 * LiveKit cannot see is an in-app webview that ships `RTCPeerConnection` but
 * never grants the camera or microphone. The head script turns those away
 * before the app starts (app/shell/in-app-browser.ts); this is the fallback
 * should its escape page fail and the app start anyway.
 */
function getUnsupportedBrowserBlockReason(): string | null {
  if (typeof navigator === "undefined") return null;

  if (isInAppBrowserDocument()) {
    return "This in-app browser doesn't support video calls. Open this link in Safari or Chrome to join.";
  }

  if (!isBrowserSupported()) {
    return "This browser doesn't support video calls. Update it, or open this link in a current version of Chrome, Edge, Firefox, or Safari.";
  }

  return null;
}

function createSession(
  code: string,
  authenticatedUserName: { readonly current: string | undefined },
): MeetingEntrySession {
  return new MeetingEntrySession({
    joinMeeting: async (request) => {
      const nodeLatencies = await settledNodeLatencies(JOIN_LATENCY_WAIT_MS);
      return joinMeeting({ data: { code, ...request, ...(nodeLatencies && { nodeLatencies }) } });
    },
    releaseAccess: (access) => releaseMeetingAccess({ data: access }),
    admissionIds: {
      load: () => loadReconnectAdmissionId(code),
      persist: (admissionId) => persistReconnectAdmissionId(code, admissionId),
      clear: () => clearReconnectAdmissionId(code),
    },
    // The server prefers the authenticated or admitted name anyway; this only
    // shapes a first admission.
    defaultDisplayName: () =>
      loadStoredMeetingDisplayName() ?? authenticatedUserName.current ?? "Guest",
    unsupportedBrowserReason: getUnsupportedBrowserBlockReason,
    diagnostic: (event, detail) => emitMeetingEntryDiagnostic(event, { code, ...detail }),
    metric: (metric) => markMeetingEntryMetric(metric, { code }),
    logError,
    logWarn,
  });
}

/**
 * The entry session for the meeting at `code`: one per meeting page. A
 * different code gets a different session rather than a reset one.
 */
export function useMeetingEntry({
  code,
  authenticatedUserName,
}: {
  code: string;
  authenticatedUserName: string | undefined;
}): { session: MeetingEntrySession; entry: MeetingEntrySnapshot } {
  const nameRef = useCommittedRef(authenticatedUserName);
  const [current, setCurrent] = React.useState(() => ({
    code,
    session: createSession(code, nameRef),
  }));
  let session = current.session;
  if (current.code !== code) {
    session = createSession(code, nameRef);
    setCurrent({ code, session });
  }

  React.useEffect(() => {
    session.activate();
    return () => session.deactivate();
  }, [session]);

  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") session.pageShown();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [session]);

  const entry = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  // Diagnostics name the meeting and connection the server issued, so they
  // join up with the server's record of the same connection.
  const meetingId = entry.access?.meetingId;
  const connectionId = entry.access?.connectionId;
  React.useEffect(() => {
    if (!meetingId || !connectionId) return;
    setMeetingDiagnosticScope({ meetingId, connectionId });
    return () => setMeetingDiagnosticScope(null);
  }, [meetingId, connectionId]);

  return { session, entry };
}

// ── LiveKit configuration for one link ──────────────────────────────────────

const BASE_ROOM_OPTIONS: RoomOptions = {
  ...getInteractiveRoomMediaOptions(),
  disconnectOnPageLeave: true,
  reconnectPolicy: new MeetingReconnectPolicy(),
};

/**
 * Initial signaling owns its own bounded retries. There is deliberately no
 * competing application timer that tears down LiveKit mid-attempt. TURN and
 * STUN come from the LiveKit server during signaling.
 */
export const MEETING_ROOM_CONNECT_OPTIONS: RoomConnectOptions = {
  maxRetries: 4,
  websocketTimeout: 20_000,
  peerConnectionTimeout: 20_000,
};

/** Room options for a new link, from the participant's choices as they stand now. */
export function buildMeetingRoomOptions(
  intent: LocalMediaIntent,
  peer: MeetingEntryLink["peer"],
): RoomOptions {
  return {
    ...BASE_ROOM_OPTIONS,
    singlePeerConnection: peer === "standard",
    ...(intent.videoDeviceId
      ? { videoCaptureDefaults: getCameraCaptureOptions(intent.videoDeviceId) }
      : {}),
    ...(intent.audioDeviceId
      ? { audioCaptureDefaults: getAudioCaptureOptions(intent.audioDeviceId) }
      : {}),
    ...(intent.audioOutputDeviceId
      ? { audioOutput: { deviceId: intent.audioOutputDeviceId } }
      : {}),
  };
}

/**
 * Camera and microphone acquisition is not the meeting connection. LiveKit can
 * still establish RTC and the participant can recover or pick another device
 * from inside the room, so a media failure never tears down a healthy join;
 * the in-room device hooks own user-facing recovery. This only records it.
 */
export function reportMeetingMediaDeviceFailure(
  code: string,
  failure: MediaDeviceFailure | undefined,
  kind: MediaDeviceKind | undefined,
): void {
  emitMeetingEntryDiagnostic("media_device_failure", { code, failure, kind });
  logWarn("[Meeting] Recoverable media device failure:", { failure, kind });
}
