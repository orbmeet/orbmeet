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
import { useLiveKitScreenShare } from "./use-livekit-screen-share";
import { stopScreenShare } from "@/modules/meetings/server/runtime/live.functions";
import type { HostPermissionRequest } from "./types";
import type { useToast } from "@orbmeet/ui/react";
import { canCaptureDisplay, getPlatformEnvironment } from "@/lib/browser-capabilities";
import { MediaOperationQueue } from "./media-operation-queue";

const SCREEN_SHARE_REQUEST_TIMEOUT_MS = 15_000;

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
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const {
    pendingRequests: screenShareRequests,
    requestState: screenShareRequestState,
    requestScreenShare,
    withdrawRequest: withdrawScreenShareRequest,
    dismissDenied: dismissScreenShareDenied,
    approveRequest: approveScreenShareRequest,
    denyRequest: denyScreenShareRequest,
  } = useLiveKitScreenShare({ room: roomInstance, meetingId, connectionId, isAdmin: canModerate });
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

  const [hasScreenSharePermission, setHasScreenSharePermission] = React.useState(() =>
    roomInstance ? hasScreenSharePublishPermission(roomInstance.localParticipant) : false,
  );
  const preparedScreenShareTracksRef = React.useRef<LocalTrack[] | null>(null);
  const preparedTrackCleanupRef = React.useRef<Array<() => void>>([]);
  // Invalidated on unmount and room replacement. `createScreenTracks` awaits a
  // browser picker that can resolve *after* either event — without this fence
  // the freshly-captured tracks would never be stopped and the browser would
  // keep capturing the screen after the user left the meeting.
  const captureGenRef = React.useRef(0);
  const isClearingPreparedTracksRef = React.useRef(false);
  const revokeInFlightRef = React.useRef(false);
  const isPreparingScreenShareRef = React.useRef(false);
  const isPublishingPreparedScreenShareRef = React.useRef(false);
  const screenShareActionQueueRef = React.useRef(new MediaOperationQueue());
  const [hasPreparedScreenShare, setHasPreparedScreenShare] = React.useState(false);
  const [isPreparingScreenShare, setIsPreparingScreenShare] = React.useState(false);

  const enqueueScreenShareAction = React.useCallback((action: () => Promise<void>) => {
    return screenShareActionQueueRef.current.enqueue(action);
  }, []);

  const revokeScreenShareGrant = React.useCallback(() => {
    if (canModerate || revokeInFlightRef.current) return;
    revokeInFlightRef.current = true;
    stopScreenShare({
      data: { meetingId, connectionId },
    })
      .catch((err) => logError("[Meeting] Failed to revoke screen share permission:", err))
      .finally(() => {
        revokeInFlightRef.current = false;
      });
  }, [canModerate, meetingId, connectionId]);

  const clearPreparedTrackListeners = React.useCallback(() => {
    for (const cleanup of preparedTrackCleanupRef.current) cleanup();
    preparedTrackCleanupRef.current = [];
  }, []);

  const stopPreparedScreenShareTracks = React.useCallback(() => {
    const tracks = preparedScreenShareTracksRef.current;
    preparedScreenShareTracksRef.current = null;
    setHasPreparedScreenShare(false);
    isClearingPreparedTracksRef.current = true;
    clearPreparedTrackListeners();
    tracks?.forEach((track) => track.stop());
    isClearingPreparedTracksRef.current = false;
  }, [clearPreparedTrackListeners]);

  const handlePreparedTrackEnded = React.useCallback(() => {
    if (isClearingPreparedTracksRef.current) return;
    stopPreparedScreenShareTracks();
    withdrawScreenShareRequest();
  }, [stopPreparedScreenShareTracks, withdrawScreenShareRequest]);

  const setPreparedScreenShareTracks = React.useCallback((tracks: LocalTrack[] | null) => {
    clearPreparedTrackListeners();
    preparedScreenShareTracksRef.current = tracks;
    setHasPreparedScreenShare(Boolean(tracks && tracks.length > 0));
    if (!tracks) return;
    for (const track of tracks) {
      const mediaTrack = track.mediaStreamTrack;
      mediaTrack.addEventListener("ended", handlePreparedTrackEnded, { once: true });
      preparedTrackCleanupRef.current.push(() => {
        mediaTrack.removeEventListener("ended", handlePreparedTrackEnded);
      });
    }
  }, [clearPreparedTrackListeners, handlePreparedTrackEnded]);

  const handleCancelScreenShareRequest = React.useCallback(() => {
    stopPreparedScreenShareTracks();
    withdrawScreenShareRequest();
  }, [stopPreparedScreenShareTracks, withdrawScreenShareRequest]);

  const publishPreparedScreenShareTracks = React.useCallback(async () => {
    if (!roomInstance || isPublishingPreparedScreenShareRef.current) return false;
    const tracks = preparedScreenShareTracksRef.current;
    if (!tracks || tracks.length === 0) return false;

    isPublishingPreparedScreenShareRef.current = true;
    try {
      await publishScreenTracksPerKind(roomInstance.localParticipant, tracks);
      // The grant stays: it is what lets this participant keep sharing, until
      // they stop or a moderator takes it back.
      setPreparedScreenShareTracks(null);
      return true;
    } catch (err) {
      stopPreparedScreenShareTracks();
      withdrawScreenShareRequest();
      logError("[Meeting] Failed to publish prepared screen share:", err);
      addToast({
        title: "Screen share failed",
        description: "Could not start sharing your screen. Try again.",
        data: { variant: "error" },
      });
      return false;
    } finally {
      isPublishingPreparedScreenShareRef.current = false;
    }
  }, [
    roomInstance,
    setPreparedScreenShareTracks,
    stopPreparedScreenShareTracks,
    withdrawScreenShareRequest,
    addToast,
  ]);

  // Sync screen share permission from room events
  React.useEffect(() => {
    if (!roomInstance) {
      setHasScreenSharePermission(false);
      return;
    }

    const lp = roomInstance.localParticipant;
    const syncPermission = () => {
      setHasScreenSharePermission(hasScreenSharePublishPermission(lp));
    };
    const handlePermissionsChanged = (_prev: unknown, participant: { identity: string }) => {
      if (participant.identity !== lp.identity) return;
      syncPermission();
    };

    syncPermission();
    roomInstance.on(RoomEvent.ParticipantPermissionsChanged, handlePermissionsChanged);
    return () => {
      roomInstance.off(RoomEvent.ParticipantPermissionsChanged, handlePermissionsChanged);
    };
  }, [roomInstance]);

  // Cleanup prepared tracks on unmount
  React.useEffect(() => {
    return () => {
      captureGenRef.current += 1;
      stopPreparedScreenShareTracks();
    };
  }, [stopPreparedScreenShareTracks]);

  React.useEffect(() => {
    return () => {
      captureGenRef.current += 1;
      stopPreparedScreenShareTracks();
    };
  }, [roomInstance, stopPreparedScreenShareTracks]);

  const handleToggleScreenShare = React.useCallback(
    () => enqueueScreenShareAction(async () => {
      if (!roomInstance) return;
      const lp = roomInstance.localParticipant;
    const startSharing = async () => {
      // Create the screen tracks, then publish each with its correct per-kind
      // options (video vs. the music-preset audio). setScreenShareEnabled's
      // single publishOptions arg would force the audio track onto the speech
      // preset, so publish individually — same path the prepared flow uses.
      let tracks: LocalTrack[] = [];
      const captureGen = captureGenRef.current;
      try {
        tracks = await lp.createScreenTracks(getScreenShareCaptureOptions());
        if (captureGen !== captureGenRef.current) {
          // The picker resolved after unmount/room replacement; stop the
          // capture instead of publishing into a dead connection.
          for (const track of tracks) track.stop();
          return;
        }
        await publishScreenTracksPerKind(lp, tracks);
        tracks = []; // ownership transferred to the published tracks on success
      } catch (err) {
        // NotAllowedError = user cancelled the system picker; no feedback needed.
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          for (const track of tracks) track.stop();
          return;
        }
        for (const track of tracks) track.stop();
        logError("[Meeting] Screen share error:", err);
        addToast({
          title: "Screen share failed",
          description: "Could not start screen sharing. Try again.",
          data: { variant: "error" },
        });
      }
    };

    if (lp.isScreenShareEnabled) {
      try {
        await lp.setScreenShareEnabled(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "NotAllowedError") return;
        logError("[Meeting] Screen share error:", err);
      }
      stopPreparedScreenShareTracks();
      // Non-host: give the grant back so approval is not sticky.
      withdrawScreenShareRequest();
      return;
    }

    // iOS and iPadOS have no useful full-screen getDisplayMedia path. The
    // browser either auto-rejects or the user dismisses the tab-picker; both
    // produce NotAllowedError which the catch block below silently swallows,
    // leaving the user with no feedback. Show a clear message instead.
    if (!canCaptureDisplay(getPlatformEnvironment())) {
      addToast({
        title: "Screen sharing not available on this device",
        description: "iPhone and iPad only support sharing the current browser tab, which isn't useful in a meeting. Use a desktop browser to share your screen.",
        data: { variant: "info" },
      });
      return;
    }

    // Host can share directly
    if (canModerate) {
      await startSharing();
      return;
    }

    if (hasScreenSharePermission) {
      if (preparedScreenShareTracksRef.current) {
        await publishPreparedScreenShareTracks();
        return;
      }
      // Already granted: only a stale denial notice is cleared. The grant
      // itself is what lets the share publish.
      dismissScreenShareDenied();
      await startSharing();
      return;
    }

    if (
      isPreparingScreenShareRef.current ||
      isPublishingPreparedScreenShareRef.current ||
      screenShareRequestState === "pending" ||
      screenShareRequestState === "approved" ||
      hasPreparedScreenShare ||
      preparedScreenShareTracksRef.current !== null
    ) {
      return;
    }

    isPreparingScreenShareRef.current = true;
    setIsPreparingScreenShare(true);
    const captureGen = captureGenRef.current;
    try {
      const tracks = await lp.createScreenTracks(getScreenShareCaptureOptions());
      if (captureGen !== captureGenRef.current) {
        // Picker resolved after unmount/room replacement — the cleanup effects
        // have already run and will never see these tracks, so stop them here.
        for (const track of tracks) track.stop();
        return;
      }
      if (tracks.length === 0) return;
      setPreparedScreenShareTracks(tracks);
      const requestSent = await requestScreenShare();
      if (!requestSent && preparedScreenShareTracksRef.current === tracks) {
        stopPreparedScreenShareTracks();
        addToast({
          title: "Screen share request failed",
          description: "Could not send the request. Check your connection and try again.",
          data: { variant: "error" },
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      logError("[Meeting] Screen share capture error:", err);
      addToast({
        title: "Screen share failed",
        description: "Could not capture your screen. Try again.",
        data: { variant: "error" },
      });
    } finally {
      isPreparingScreenShareRef.current = false;
      setIsPreparingScreenShare(false);
    }
    }), [
    roomInstance,
    canModerate,
    hasScreenSharePermission,
    hasPreparedScreenShare,
    screenShareRequestState,
    requestScreenShare,
    publishPreparedScreenShareTracks,
    setPreparedScreenShareTracks,
    stopPreparedScreenShareTracks,
    withdrawScreenShareRequest,
    dismissScreenShareDenied,
    addToast,
    enqueueScreenShareAction,
  ]);

  // A successful data-channel write is not an admission decision. Bound the
  // time we retain browser-owned capture tracks while waiting for a moderator,
  // including when no moderator is present or the application message is lost.
  React.useEffect(() => {
    if (
      screenShareRequestState !== "pending" ||
      canModerate ||
      hasScreenSharePermission ||
      !hasPreparedScreenShare
    ) {
      return;
    }
    const timer = setTimeout(() => {
      handleCancelScreenShareRequest();
      addToast({
        title: "Screen share request timed out",
        description: "No moderator responded. Request screen share again.",
        data: { variant: "error" },
      });
    }, SCREEN_SHARE_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [
    screenShareRequestState,
    canModerate,
    hasScreenSharePermission,
    hasPreparedScreenShare,
    handleCancelScreenShareRequest,
    addToast,
  ]);

  // Timeout approved screen share if permission update is slow
  React.useEffect(() => {
    if (
      screenShareRequestState !== "approved" ||
      canModerate ||
      hasScreenSharePermission ||
      !hasPreparedScreenShare
    ) {
      return;
    }
    const timer = setTimeout(() => {
      logError("[Meeting] Screen share permission update timed out");
      handleCancelScreenShareRequest();
      addToast({
        title: "Screen share approval timed out",
        description: "The grant did not reach your browser. Request screen share again.",
        data: { variant: "error" },
      });
    }, 10_000);
    return () => clearTimeout(timer);
  }, [
    screenShareRequestState,
    canModerate,
    hasScreenSharePermission,
    hasPreparedScreenShare,
    handleCancelScreenShareRequest,
    addToast,
  ]);

  // Auto-publish prepared tracks once permission arrives
  React.useEffect(() => {
    if (
      (screenShareRequestState !== "approved" && screenShareRequestState !== "pending") ||
      canModerate ||
      !hasScreenSharePermission ||
      !hasPreparedScreenShare
    ) {
      return;
    }
    void publishPreparedScreenShareTracks();
  }, [
    screenShareRequestState,
    canModerate,
    hasScreenSharePermission,
    hasPreparedScreenShare,
    publishPreparedScreenShareTracks,
  ]);

  // Auto-dismiss denied state after 3 seconds
  React.useEffect(() => {
    if (screenShareRequestState !== "denied") return;
    // The server already cleared the request; only local state is left.
    stopPreparedScreenShareTracks();
    const timer = setTimeout(() => dismissScreenShareDenied(), 3000);
    return () => clearTimeout(timer);
  }, [screenShareRequestState, stopPreparedScreenShareTracks, dismissScreenShareDenied]);

  React.useEffect(() => {
    if (!roomInstance || canModerate) return;

    const handleLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        revokeScreenShareGrant();
      }
    };
    const handleDisconnected = () => {
      if (hasScreenSharePermission) revokeScreenShareGrant();
    };

    roomInstance.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    roomInstance.on(RoomEvent.Disconnected, handleDisconnected);
    return () => {
      roomInstance.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
      roomInstance.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [roomInstance, canModerate, hasScreenSharePermission, revokeScreenShareGrant]);

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
    screenShareRequestState,
    isPreparingScreenShare,
    hasPreparedScreenShare,
    hasScreenSharePermission,
    handleToggleScreenShare,
    handleCancelScreenShareRequest,
    handleDismissScreenShareDenied: dismissScreenShareDenied,
    handleApproveScreenShare,
    handleDenyScreenShare,
    hostPermissionRequests,
  };
}
