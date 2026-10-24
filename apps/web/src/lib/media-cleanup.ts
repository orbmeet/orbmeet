import type { LocalTrack, Room } from "livekit-client";

function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export function stopMediaElementsInScope(scope: HTMLElement | null) {
  // The meeting subtree may already be unmounted when deferred cleanup runs.
  // Falling back to `document` would stop unrelated remote media elsewhere in
  // the application; local publications are cleaned up separately above.
  if (typeof document === "undefined" || !scope) return;
  scope
    .querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio")
    .forEach((element) => {
      if (element.srcObject && element.srcObject instanceof MediaStream) {
        stopMediaStream(element.srcObject);
        element.srcObject = null;
      }
    });
}

function disableLocalMedia(room: Room): Promise<unknown> {
  const localParticipant = room.localParticipant;
  return Promise.all([
    localParticipant.setCameraEnabled(false).catch(() => undefined),
    localParticipant.setMicrophoneEnabled(false).catch(() => undefined),
    localParticipant.setScreenShareEnabled(false).catch(() => undefined),
  ]);
}

function stopTrack(track: LocalTrack) {
  track.stop();
  track.mediaStreamTrack?.stop();
}

/** Stop every published local track. */
function stopPublishedTracks(room: Room) {
  room.localParticipant.trackPublications.forEach((publication) => {
    if (!publication.track) return;
    try {
      stopTrack(publication.track);
    } catch {
      // Track may already be stopped.
    }
  });
}

export async function stopAllLocalTracks(room: Room): Promise<void> {
  await disableLocalMedia(room);
  stopPublishedTracks(room);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** {@link stopAllLocalTracks} for teardown paths that cannot wait for it. */
export function stopAllLocalTracksSync(room: Room) {
  void disableLocalMedia(room);
  stopPublishedTracks(room);
}
