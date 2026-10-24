import * as React from "react";
import { useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import type { RemoteTrackPublication } from "livekit-client";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({ hidden: { display: "none" } });

type AudioTrack = {
  attach: (el?: HTMLAudioElement) => HTMLAudioElement;
  detach: (el?: HTMLAudioElement) => HTMLAudioElement[];
};

function AudioElement({ track }: { track: AudioTrack }) {
  const ref = React.useRef<HTMLAudioElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);

  return <audio ref={ref} autoPlay playsInline {...stylex.props(styles.hidden)} />;
}

const RECORDER_AUDIO_SOURCES: Track.Source[] = [
  Track.Source.Microphone,
  Track.Source.ScreenShareAudio,
  Track.Source.Unknown,
];

/** Subscribes to room audio tracks so the browser-based egress page captures them. */
export function RecorderAudioMixer() {
  const tracks = useTracks(RECORDER_AUDIO_SOURCES, { onlySubscribed: true })
    .filter((ref) => ref.publication?.kind === Track.Kind.Audio);

  return (
    <>
      {tracks.map((ref) => {
        const pub = ref.publication as RemoteTrackPublication | undefined;
        if (!pub?.track) return null;
        return (
          <AudioElement
            key={`${ref.participant.identity}:${pub.trackSid}`}
            track={pub.track}
          />
        );
      })}
    </>
  );
}
