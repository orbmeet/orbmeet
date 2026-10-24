import { useMemo } from "react";
import { useIsSpeaking, useParticipants } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import * as stylex from "@stylexjs/stylex";
import { Avatar } from "@orbmeet/ui/react";
import { accent, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { MeetingVideoTrack } from "./meeting-video-track";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import {
  byLabel,
  chainComparators,
  isLocalParticipant,
  participantLabel,
  preferFlag,
} from "./participant-order";
import { useActiveVideoTracks, type VideoTrackRef } from "./video-layout/tracks";

/** Faces shown before the count says the rest. */
const MAX_FACES = 3;
const FACE_PX = 24;

const styles = stylex.create({
  pile: { display: "flex", alignItems: "center" },
  face: {
    position: "relative",
    display: "flex",
    width: FACE_PX,
    height: FACE_PX,
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: radii.pill,
    // The bar's own white, so overlapping faces read as separate people.
    boxShadow: `0 0 0 2px ${surface.raised}`,
    transitionProperty: "box-shadow",
    transitionDuration: { default: "160ms", [env.reducedMotion]: "0s" },
  },
  overlap: { marginInlineStart: -5 },
  /** The room's one "this person is talking" colour, as a ring. */
  speaking: { boxShadow: `0 0 0 2px ${surface.raised}, 0 0 0 3.5px ${accent.a500}` },
  stack: (index: number) => ({ zIndex: MAX_FACES - index }),
});

/**
 * The people in the room as a few faces in the top bar, while a board or a
 * shared screen has the stage and the People panel is closed.
 *
 * Small on purpose: it says who is here, whose camera is on — their video
 * plays inside the circle — and who is speaking, at no cost to the content.
 * The People panel, one press away, is where faces are big enough to read.
 * Everyone else comes before you, and cameras before avatars, in the room's
 * usual stable order, so the pile does not reshuffle as people talk.
 */
export function PeopleFacepile() {
  const participants = useParticipants();
  const cameraTracks = useActiveVideoTracks({ includeScreenShare: false });
  const cameraByIdentity = useMemo(() => {
    const map = new Map<string, VideoTrackRef>();
    for (const track of cameraTracks) {
      if (track.source === Track.Source.Camera) map.set(track.participant.identity, track);
    }
    return map;
  }, [cameraTracks]);
  const shown = useMemo(() => {
    const others = participants.some((participant) => !participant.isLocal);
    return [...participants]
      .filter((participant) => !others || !participant.isLocal)
      .sort(
        chainComparators<Participant>(
          preferFlag((participant) => cameraByIdentity.has(participant.identity)),
          preferFlag((participant) => !isLocalParticipant(participant)),
          byLabel(participantLabel),
        ),
      )
      .slice(0, MAX_FACES);
  }, [participants, cameraByIdentity]);

  return (
    <span aria-hidden="true" {...stylex.props(styles.pile)}>
      {shown.map((participant, index) => (
        <Face
          key={participant.identity}
          participant={participant}
          track={cameraByIdentity.get(participant.identity)}
          index={index}
        />
      ))}
    </span>
  );
}

function Face({
  participant,
  track,
  index,
}: {
  participant: Participant;
  track: VideoTrackRef | undefined;
  index: number;
}) {
  const speaking = useIsSpeaking(participant);
  return (
    <span
      {...stylex.props(
        styles.face,
        index > 0 && styles.overlap,
        speaking && styles.speaking,
        styles.stack(index),
      )}
    >
      {track ? (
        <MeetingVideoTrack
          trackRef={track}
          {...stylex.props(videoTrack.fill, participant.isLocal && videoTrack.mirrored)}
        />
      ) : (
        <Avatar name={participant.name || participant.identity} sizePx={FACE_PX} />
      )}
    </span>
  );
}
