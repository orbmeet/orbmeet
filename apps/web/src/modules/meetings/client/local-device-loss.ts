import {
  RoomEvent,
  TrackEvent,
  type LocalTrack,
  type LocalTrackPublication,
  type Room,
  type Track,
} from "livekit-client";

/**
 * Remembers whether a local microphone or camera lost its device.
 *
 * When a capture's device goes away (unplugged, a dock or Bluetooth flap)
 * LiveKit gets `TrackEvent.Ended`, tries the default device, and if that fails
 * too mutes the track. The `TrackMuted` that follows looks exactly like a mute
 * the participant or a moderator chose; only the `Ended` before it says
 * otherwise. This keeps that fact until the capture is live again (restarted
 * or unmuted), so whoever handles the mute can ask why it happened.
 */
export interface LocalDeviceLoss {
  /** The track's device ended and nothing has been captured since. */
  readonly lost: boolean;
  dispose(): void;
}

export function watchLocalDeviceLoss(
  room: Room,
  source: Track.Source.Microphone | Track.Source.Camera,
): LocalDeviceLoss {
  let lost = false;
  let bound: LocalTrack | null = null;

  const markLost = () => {
    lost = true;
  };
  const markLive = () => {
    lost = false;
  };

  const bind = () => {
    const track = room.localParticipant.getTrackPublication(source)?.track ?? null;
    if (track === bound) return;
    bound?.off(TrackEvent.Ended, markLost).off(TrackEvent.Restarted, markLive).off(TrackEvent.Unmuted, markLive);
    bound = track;
    lost = false;
    bound?.on(TrackEvent.Ended, markLost).on(TrackEvent.Restarted, markLive).on(TrackEvent.Unmuted, markLive);
  };
  const handlePublicationChanged = (publication: LocalTrackPublication) => {
    if (publication.source === source) bind();
  };

  room
    .on(RoomEvent.LocalTrackPublished, handlePublicationChanged)
    .on(RoomEvent.LocalTrackUnpublished, handlePublicationChanged);
  bind();

  return {
    get lost() {
      return lost;
    },
    dispose() {
      room
        .off(RoomEvent.LocalTrackPublished, handlePublicationChanged)
        .off(RoomEvent.LocalTrackUnpublished, handlePublicationChanged);
      bound?.off(TrackEvent.Ended, markLost).off(TrackEvent.Restarted, markLive).off(TrackEvent.Unmuted, markLive);
      bound = null;
    },
  };
}
