import {
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrack,
  type LocalTrackPublication,
  type Room,
} from "livekit-client";

const MEETING_MICROPHONE_CONTENT_HINT = "speech";

/**
 * Ask the browser and its encoder to prioritize intelligible speech.
 *
 * `contentHint` is deliberately best-effort: older engines may not expose it,
 * and an engine is allowed to reject a value it does not implement. Capture
 * must still succeed in either case.
 */
export function applySpeechContentHint(
  mediaTrack: Pick<MediaStreamTrack, "contentHint">,
): boolean {
  if (!("contentHint" in mediaTrack)) return false;

  try {
    mediaTrack.contentHint = MEETING_MICROPHONE_CONTENT_HINT;
    return mediaTrack.contentHint === MEETING_MICROPHONE_CONTENT_HINT;
  } catch {
    return false;
  }
}

/**
 * Keeps the speech hint attached to every microphone track owned by a room.
 *
 * LiveKit can replace the underlying MediaStreamTrack without republishing the
 * LocalAudioTrack when a microphone changes, recovery restarts capture, or
 * WebKit reacquires a stopped-on-mute track. TrackEvent.Restarted is therefore
 * as important as RoomEvent.LocalTrackPublished here.
 */
export function installMeetingMicrophoneSpeechHint(room: Room): () => void {
  const boundTracks = new Set<LocalTrack>();

  const applyToTrack = (track: LocalTrack) => {
    applySpeechContentHint(track.mediaStreamTrack);
  };

  const handleRestarted = (track: LocalTrack) => {
    applyToTrack(track);
  };

  const bindPublication = (publication: LocalTrackPublication) => {
    const track = publication.track;
    if (
      publication.source !== Track.Source.Microphone ||
      !track ||
      track.kind !== Track.Kind.Audio ||
      boundTracks.has(track)
    ) {
      return;
    }

    boundTracks.add(track);
    applyToTrack(track);
    track.on(TrackEvent.Restarted, handleRestarted);
  };

  const unbindPublication = (publication: LocalTrackPublication) => {
    const track = publication.track;
    if (!track || !boundTracks.delete(track)) return;
    track.off(TrackEvent.Restarted, handleRestarted);
  };

  for (const publication of room.localParticipant.trackPublications.values()) {
    bindPublication(publication);
  }

  room
    .on(RoomEvent.LocalTrackPublished, bindPublication)
    .on(RoomEvent.LocalTrackUnpublished, unbindPublication);

  return () => {
    room
      .off(RoomEvent.LocalTrackPublished, bindPublication)
      .off(RoomEvent.LocalTrackUnpublished, unbindPublication);
    for (const track of boundTracks) {
      track.off(TrackEvent.Restarted, handleRestarted);
    }
    boundTracks.clear();
  };
}
