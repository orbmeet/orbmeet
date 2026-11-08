import * as React from "react";
import {
  LocalVideoTrack,
  RoomEvent,
  Track,
  type Room,
  type LocalTrack,
  type LocalTrackPublication,
  type TrackPublishOptions,
} from "livekit-client";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-inspection";
import {
  getScreenShareCaptureOptions,
  SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
  SCREEN_SHARE_PUBLISH_OPTIONS,
} from "./media-quality";
import { adaptScreenShareToContent } from "./screen-share-content";
import { ScreenShareCapture, type ScreenShareNotice } from "./screen-share-capture";
import { useLiveKitScreenShare } from "./use-livekit-screen-share";
import {
  requestScreenShare,
  stopScreenShare,
} from "@/modules/meetings/server/runtime/live.functions";
import type { HostPermissionRequest } from "./types";
import { useCommittedRef, type useToast } from "@orbmeet/ui/react";
import { canCaptureDisplay, getPlatformEnvironment } from "@/lib/browser-capabilities";

type AddToast = ReturnType<typeof useToast>["add"];

const NOTICES: Record<ScreenShareNotice, Parameters<AddToast>[0]> = {
  unsupported: {
    title: "Screen sharing not available on this device",
    description: "iPhone and iPad only support sharing the current browser tab, which isn't useful in a meeting. Use a desktop browser to share your screen.",
    data: { variant: "info" },
  },
  "start-failed": {
    title: "Screen share failed",
    description: "Could not start screen sharing. Try again.",
    data: { variant: "error" },
  },
  "capture-failed": {
    title: "Screen share failed",
    description: "Could not capture your screen. Try again.",
    data: { variant: "error" },
  },
  "publish-failed": {
    title: "Screen share failed",
    description: "Could not start sharing your screen. Try again.",
    data: { variant: "error" },
  },
  "request-failed": {
    title: "Screen share request failed",
    description: "Could not send the request. Check your connection and try again.",
    data: { variant: "error" },
  },
  "decision-timed-out": {
    title: "Screen share request timed out",
    description: "No moderator responded. Request screen share again.",
    data: { variant: "error" },
  },
  "permission-timed-out": {
    title: "Screen share approval timed out",
    description: "The grant did not reach your browser. Request screen share again.",
    data: { variant: "error" },
  },
};

function hasScreenSharePublishPermission(
  participant: { permissions?: { canPublishSources?: number[] } } | null | undefined,
) {
  return (
    participant?.permissions?.canPublishSources?.includes(
      Track.sourceToProto(Track.Source.ScreenShare),
    ) ?? false
  );
}

/**
 * Publish a set of screen-share tracks with the correct per-kind options.
 *
 * Screen-share audio is media (a video's soundtrack, slide audio), not voice,
 * so it must use the music preset (48 kbps, RED, no DTX) — distinct from the
 * video track's options. `setScreenShareEnabled(enabled, capture, publishOpts)`
 * applies a *single* `publishOpts` to every track, which would force the audio
 * track onto the speech preset. Publishing tracks individually lets each kind
 * get its intended options. This is the single source of truth used by both the
 * prepared (host-approved) and direct (immediate) screen-share start paths.
 *
 * The video then follows what it shows — sharp for a document, smooth for a
 * video — without the presenter choosing (`adaptScreenShareToContent`).
 *
 * On failure any tracks that were published are unpublished and all are stopped
 * so no orphaned `getDisplayMedia` track lingers.
 */
export async function publishScreenTracksPerKind(
  participant: {
    publishTrack: (track: LocalTrack, options?: TrackPublishOptions) => Promise<LocalTrackPublication>;
    unpublishTrack: (track: LocalTrack) => void | Promise<unknown>;
  },
  tracks: LocalTrack[],
): Promise<void> {
  const published: LocalTrack[] = [];
  try {
    for (const track of tracks) {
      const options =
        track.kind === Track.Kind.Video
          ? SCREEN_SHARE_PUBLISH_OPTIONS
          : SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS;
      await participant.publishTrack(track, options);
      published.push(track);
      if (track instanceof LocalVideoTrack) adaptScreenShareToContent(track);
    }
  } catch (err) {
    await Promise.allSettled(
      published.map(async (track) => {
        try {
          await participant.unpublishTrack(track);
        } catch {
          /* best-effort cleanup */
        }
      }),
    );
    throw err;
  }
}

function createCapture(
  room: Room | undefined,
  meetingId: string,
  connectionId: string,
  addToast: React.RefObject<AddToast>,
): ScreenShareCapture {
  const participant = () => {
    if (!room) throw new Error("Not connected to the meeting room.");
    return room.localParticipant;
  };
  const data = { meetingId, connectionId };
  return new ScreenShareCapture({
    isSharing: () => room?.localParticipant.isScreenShareEnabled ?? false,
    stopSharing: async () => {
      await participant().setScreenShareEnabled(false);
    },
    canCaptureDisplay: () => canCaptureDisplay(getPlatformEnvironment()),
    capture: () => participant().createScreenTracks(getScreenShareCaptureOptions()),
    publish: (tracks) => publishScreenTracksPerKind(participant(), tracks),
    request: () => requestScreenShare({ data }),
    withdraw: () => stopScreenShare({ data }),
    notify: (notice) => addToast.current(NOTICES[notice]),
    logError,
  });
}

export function useMeetingScreenShare({
  roomInstance,
  canModerate,
  meetingId,
  connectionId,
  addToast,
}: {
  roomInstance: Room | undefined;
  canModerate: boolean;
  meetingId: string;
  connectionId: string;
  addToast: AddToast;
}) {
  const {
    pendingRequests: screenShareRequests,
    ownAsk,
    approveRequest: approveScreenShareRequest,
    denyRequest: denyScreenShareRequest,
  } = useLiveKitScreenShare({ room: roomInstance, meetingId, connectionId, isAdmin: canModerate });

  const addToastRef = useCommittedRef(addToast);
  // One capture per room connection; later props reach it through the setters
  // below. A new connection replaces it during render, React's pattern for
  // state derived from a changed prop.
  const [current, setCurrent] = React.useState(() => ({
    room: roomInstance,
    capture: createCapture(roomInstance, meetingId, connectionId, addToastRef),
  }));
  let capture = current.capture;
  if (current.room !== roomInstance) {
    capture = createCapture(roomInstance, meetingId, connectionId, addToastRef);
    setCurrent({ room: roomInstance, capture });
  }

  // Everything the capture reads is set before it starts converging on it.
  React.useEffect(() => capture.setCanModerate(canModerate), [capture, canModerate]);
  const ownAskState = ownAsk?.state ?? null;
  const ownAskRevision = ownAsk?.revision ?? null;
  React.useEffect(() => {
    capture.setAsk(ownAskState === null || ownAskRevision === null ? null : { state: ownAskState, revision: ownAskRevision });
  }, [capture, ownAskRevision, ownAskState]);
  React.useEffect(() => {
    if (!roomInstance) {
      capture.setPermission(false);
      return;
    }
    const local = roomInstance.localParticipant;
    const sync = () => capture.setPermission(hasScreenSharePublishPermission(local));
    const handlePermissionsChanged = (_previous: unknown, participant: { identity: string }) => {
      if (participant.identity === local.identity) sync();
    };
    sync();
    roomInstance.on(RoomEvent.ParticipantPermissionsChanged, handlePermissionsChanged);
    return () => {
      roomInstance.off(RoomEvent.ParticipantPermissionsChanged, handlePermissionsChanged);
    };
  }, [capture, roomInstance]);
  React.useEffect(() => {
    capture.activate();
    return () => capture.deactivate();
  }, [capture]);

  React.useEffect(() => {
    if (!roomInstance) return;
    const handleLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        capture.giveBack();
      }
    };
    const handleDisconnected = () => capture.disconnected();
    roomInstance.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    roomInstance.on(RoomEvent.Disconnected, handleDisconnected);
    return () => {
      roomInstance.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
      roomInstance.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [capture, roomInstance]);

  const snapshot = React.useSyncExternalStore(capture.subscribe, capture.getSnapshot, capture.getSnapshot);

  const [pendingDecisionIdentities, setPendingDecisionIdentities] = React.useState<Set<string>>(
    () => new Set(),
  );
  const pendingDecisionIdentitiesRef = React.useRef<Set<string>>(new Set());
  const setDecisionPending = React.useCallback((identity: string, pending: boolean) => {
    if (pending) pendingDecisionIdentitiesRef.current.add(identity);
    else pendingDecisionIdentitiesRef.current.delete(identity);
    setPendingDecisionIdentities(new Set(pendingDecisionIdentitiesRef.current));
  }, []);
  React.useEffect(() => {
    if (canModerate) return;
    pendingDecisionIdentitiesRef.current.clear();
    setPendingDecisionIdentities(new Set());
  }, [canModerate]);

  const hostPermissionRequests = React.useMemo<HostPermissionRequest[]>(
    () =>
      screenShareRequests.map((request) => ({
        kind: "screen-share" as const,
        id: `screen-${request.identity}`,
        userId: request.identity,
        userName: request.userName,
        decisionPending: pendingDecisionIdentities.has(request.identity),
      })),
    [pendingDecisionIdentities, screenShareRequests],
  );

  const handleToggleScreenShare = React.useCallback(
    () => (roomInstance ? capture.toggle() : Promise.resolve()),
    [capture, roomInstance],
  );

  const handleApproveScreenShare = React.useCallback(
    async (targetUserIdentity: string) => {
      if (pendingDecisionIdentitiesRef.current.has(targetUserIdentity)) return;
      setDecisionPending(targetUserIdentity, true);
      try {
        await approveScreenShareRequest(targetUserIdentity);
      } catch (err) {
        logError("[Meeting] Failed to grant screen share:", err);
        addToast({
          title: "Screen share decision failed",
          description: getErrorMessage(err, "Could not approve this request."),
          data: { variant: "error" },
        });
      } finally {
        setDecisionPending(targetUserIdentity, false);
      }
    },
    [addToast, approveScreenShareRequest, setDecisionPending],
  );

  const handleDenyScreenShare = React.useCallback(
    async (targetUserIdentity: string) => {
      if (pendingDecisionIdentitiesRef.current.has(targetUserIdentity)) return;
      setDecisionPending(targetUserIdentity, true);
      try {
        await denyScreenShareRequest(targetUserIdentity);
      } catch (err) {
        logError("[Meeting] Failed to revoke screen share:", err);
        addToast({
          title: "Screen share decision failed",
          description: getErrorMessage(err, "Could not deny this request."),
          data: { variant: "error" },
        });
      } finally {
        setDecisionPending(targetUserIdentity, false);
      }
    },
    [addToast, denyScreenShareRequest, setDecisionPending],
  );

  return {
    screenShareRequestState: snapshot.requestState,
    isPreparingScreenShare: snapshot.isPreparing,
    hasPreparedScreenShare: snapshot.hasPrepared,
    hasScreenSharePermission: snapshot.hasPermission,
    handleToggleScreenShare,
    handleCancelScreenShareRequest: capture.cancel,
    handleDismissScreenShareDenied: capture.dismissDenied,
    handleApproveScreenShare,
    handleDenyScreenShare,
    hostPermissionRequests,
  };
}
