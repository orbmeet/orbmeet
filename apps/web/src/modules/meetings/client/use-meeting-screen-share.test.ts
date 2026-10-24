import { describe, expect, it, vi } from "vitest";
import {
  Track,
  type LocalTrack,
  type LocalTrackPublication,
  type TrackPublishOptions,
} from "livekit-client";
import { publishScreenTracksPerKind } from "./use-meeting-screen-share";
import { SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS, SCREEN_SHARE_PUBLISH_OPTIONS } from "./media-quality";

function makeTrack(kind: Track.Kind): LocalTrack {
  // Only the fields the helper reads; publishTrack/unpublishTrack are spied.
  return { kind } as unknown as LocalTrack;
}

function makeParticipant(behaviour: {
  publishThrowOn?: Track.Kind;
  published?: LocalTrack[];
  unpublished?: LocalTrack[];
}) {
  const published = behaviour.published ?? [];
  const unpublished = behaviour.unpublished ?? [];
  return {
    async publishTrack(
      track: LocalTrack,
      options?: TrackPublishOptions,
    ): Promise<LocalTrackPublication> {
      if (behaviour.publishThrowOn && track.kind === behaviour.publishThrowOn) {
        throw new Error(`publish failed for ${track.kind}`);
      }
      published.push(track);
      // Record the options used so tests can assert per-kind routing.
      (track as unknown as { __options?: TrackPublishOptions }).__options = options;
      return {} as LocalTrackPublication;
    },
    unpublishTrack(track: LocalTrack) {
      unpublished.push(track);
    },
    published,
    unpublished,
  };
}

describe("publishScreenTracksPerKind", () => {
  it("publishes video and audio tracks with their respective per-kind options", async () => {
    const video = makeTrack(Track.Kind.Video);
    const audio = makeTrack(Track.Kind.Audio);
    const participant = makeParticipant({});

    await publishScreenTracksPerKind(participant, [video, audio]);

    expect(participant.published).toEqual([video, audio]);
    expect((video as unknown as { __options: TrackPublishOptions }).__options).toBe(
      SCREEN_SHARE_PUBLISH_OPTIONS,
    );
    expect((audio as unknown as { __options: TrackPublishOptions }).__options).toBe(
      SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
    );
    expect(participant.unpublished).toEqual([]);
  });

  it("unpublishes the tracks that succeeded when a later track fails, then rethrows", async () => {
    const video = makeTrack(Track.Kind.Video);
    const audio = makeTrack(Track.Kind.Audio); // will throw
    const participant = makeParticipant({ publishThrowOn: Track.Kind.Audio });

    await expect(publishScreenTracksPerKind(participant, [video, audio])).rejects.toThrow(
      "publish failed",
    );

    // Video published first, then audio failed → video must be unpublished.
    expect(participant.published).toEqual([video]);
    expect(participant.unpublished).toEqual([video]);
  });

  it("rejects when the first track fails without publishing anything", async () => {
    const video = makeTrack(Track.Kind.Video);
    const participant = makeParticipant({ publishThrowOn: Track.Kind.Video });

    await expect(publishScreenTracksPerKind(participant, [video])).rejects.toThrow();

    expect(participant.published).toEqual([]);
    expect(participant.unpublished).toEqual([]);
  });

  it("swallows errors thrown by unpublishTrack during cleanup so it never masks the real failure", async () => {
    const video = makeTrack(Track.Kind.Video);
    const audio = makeTrack(Track.Kind.Audio);
    const participant = makeParticipant({ publishThrowOn: Track.Kind.Audio });
    const unpublishSpy = vi.spyOn(participant, "unpublishTrack");
    unpublishSpy.mockImplementation(() => {
      throw new Error("unpublish exploded");
    });

    // The original publish failure must propagate, not the cleanup error.
    await expect(publishScreenTracksPerKind(participant, [video, audio])).rejects.toThrow(
      "publish failed",
    );
    expect(unpublishSpy).toHaveBeenCalledWith(video);
  });
});
