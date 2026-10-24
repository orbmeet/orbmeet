import {
  type TrackReference,
  type TrackReferenceOrPlaceholder,
  useTracks,
} from "@livekit/components-react";
import {
  byLabel,
  chainComparators,
  isLocalTrack,
  isScreenShareTrack,
  preferFlag,
  trackLabel,
} from "../participant-order";
import { Track } from "livekit-client";

function hasTrackPublication(
  trackRef: TrackReferenceOrPlaceholder,
): trackRef is TrackReference {
  return "publication" in trackRef && trackRef.publication !== undefined;
}

function filterActiveTracks(
  tracks: TrackReferenceOrPlaceholder[],
  options: { includeScreenShare?: boolean } = {},
): TrackReference[] {
  const { includeScreenShare = true } = options;
  return tracks.filter(hasTrackPublication).filter((trackRef) => {
    if (!includeScreenShare && trackRef.source === Track.Source.ScreenShare)
      return false;
    if (trackRef.source === Track.Source.ScreenShare) return true;
    if (trackRef.publication) return !trackRef.publication.isMuted;
    return false;
  });
}

function prioritizeTracks(tracks: TrackReference[]) {
  // Screen share first, then the local user, then alphabetical.
  return [...tracks].sort(
    chainComparators<TrackReference>(
      preferFlag(isScreenShareTrack),
      preferFlag(isLocalTrack),
      byLabel(trackLabel),
    ),
  );
}

export function useActiveVideoTracks(
  options: { includeScreenShare?: boolean } = {},
) {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: false,
  });
  return prioritizeTracks(filterActiveTracks(tracks, options));
}

export function useActiveScreenShareTracks() {
  const tracks = useTracks([Track.Source.ScreenShare], {
    onlySubscribed: false,
  });
  return prioritizeTracks(filterActiveTracks(tracks));
}


export type VideoTrackRef = TrackReference;
export function getTrackRenderKey(track: VideoTrackRef) {
  return (
    track.publication?.trackSid ||
    `${track.participant.identity}-${track.source}`
  );
}
