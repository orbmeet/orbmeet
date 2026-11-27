import * as React from "react";
import {
  isBrowserSupported,
  type MediaDeviceFailure,
  type RoomConnectOptions,
  type RoomOptions,
} from "livekit-client";
import { useCommittedRef } from "@orbmeet/ui/react";
import { joinMeeting } from "@/app/rpc/meeting-join.functions";
import { isInAppBrowserDocument } from "@/lib/in-app-browser";
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
import { releaseMeetingAccess } from "@/modules/meetings/server/runtime/live.functions";
import { loadStoredMeetingDisplayName } from "@/modules/meetings/client/display-name-storage";
import {
  getAudioCaptureOptions,
  getCameraCaptureOptions,
  getInteractiveRoomMediaOptions,
} from "@/modules/meetings/client/media-quality";
import { MeetingReconnectPolicy } from "@/modules/meetings/client/meeting-reconnect-policy";
import {
  clearReconnectAdmissionId,
  loadReconnectAdmissionId,
  persistReconnectAdmissionId,
} from "@/modules/meetings/client/reconnect-storage";

/**
 * How long a join waits for the pre-join screen's node measurement to finish.
 * It is usually done already; past this, the Worker measures instead.
 */
const JOIN_LATENCY_WAIT_MS = 1_500;

/**
 * Why this browser cannot join, or null when it can.
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
    defaultDisplayName: () =>
      loadStoredMeetingDisplayName() ?? authenticatedUserName.current ?? "Guest",
    unsupportedBrowserReason: getUnsupportedBrowserBlockReason,
    isOnline: () => navigator.onLine !== false,
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
    const handleOnline = () => session.networkRestored();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [session]);

  const entry = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

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
  disconnectOnPageLeave: false,
  reconnectPolicy: new MeetingReconnectPolicy(),
};

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

export function reportMeetingMediaDeviceFailure(
  code: string,
  failure: MediaDeviceFailure | undefined,
  kind: MediaDeviceKind | undefined,
): void {
  emitMeetingEntryDiagnostic("media_device_failure", { code, failure, kind });
  logWarn("[Meeting] Recoverable media device failure:", { failure, kind });
}
