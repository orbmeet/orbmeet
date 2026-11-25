// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EventEmitter } from "events";
import { Track, TrackEvent, type Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useBackgroundEffect } from "./use-background-effect";

class FakeProcessor {
  canvas = new EventTarget();
  switchTo = vi.fn(async () => {});
  destroy = vi.fn(async () => {});
}
const created: FakeProcessor[] = [];

vi.mock("@livekit/track-processors", () => ({
  supportsBackgroundProcessors: () => true,
  BackgroundProcessor: () => {
    const processor = new FakeProcessor();
    created.push(processor);
    return processor;
  },
}));

/** A live camera track whose processor slot behaves like LiveKit's. */
class FakeCameraTrack extends EventEmitter {
  kind = Track.Kind.Video;
  isMuted = false;
  mediaStreamTrack = { readyState: "live" };
  processor: FakeProcessor | undefined;
  setProcessor = vi.fn(async (processor: FakeProcessor) => {
    await this.processor?.destroy();
    this.processor = processor;
  });
  getProcessor = () => this.processor;
  stopProcessor = vi.fn(async () => {
    await this.processor?.destroy();
    this.processor = undefined;
  });
}

function fakeRoom(track: FakeCameraTrack): Room {
  const room = new EventEmitter() as EventEmitter & { localParticipant: unknown };
  room.localParticipant = {
    getTrackPublication: (source: Track.Source) =>
      source === Track.Source.Camera ? { source, track } : undefined,
  };
  return room as unknown as Room;
}

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  created.length = 0;
});

async function mountWithBlur() {
  const track = new FakeCameraTrack();
  let effect: ReturnType<typeof useBackgroundEffect> | null = null;
  function Probe() {
    effect = useBackgroundEffect(fakeRoom(track), { mode: "none", imagePath: null });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
  await act(async () => {
    await effect!.setBlur();
  });
  return track;
}

const loseContext = (processor: FakeProcessor) => processor.canvas.dispatchEvent(new Event("webglcontextlost"));

describe("useBackgroundEffect when the GPU context is lost", () => {
  it("puts a new processor on the camera in place of the dead one", async () => {
    const track = await mountWithBlur();
    const [first] = created;
    expect(track.processor).toBe(first);

    await act(async () => {
      loseContext(first);
    });

    expect(created).toHaveLength(2);
    expect(track.processor).toBe(created[1]);
    expect(first.destroy).toHaveBeenCalled();
  });

  it("follows the processor onto the canvas a LiveKit restart gives it", async () => {
    const track = await mountWithBlur();
    const [first] = created;
    const before = first.canvas;
    first.canvas = new EventTarget();
    track.emit(TrackEvent.Restarted, track);

    await act(async () => {
      before.dispatchEvent(new Event("webglcontextlost"));
    });
    expect(created).toHaveLength(1);

    await act(async () => {
      loseContext(first);
    });
    expect(created).toHaveLength(2);
    expect(track.processor).toBe(created[1]);
  });
});

describe("useBackgroundEffect when the choice changes while an effect is starting", () => {
  it("keeps the newer effect on the camera rather than stripping it", async () => {
    // The processor takes a while to start (MediaPipe loading): a second
    // choice made meanwhile must end on the camera, not only in the picker.
    const track = new FakeCameraTrack();
    let started!: () => void;
    track.setProcessor = vi.fn(async (processor: FakeProcessor) => {
      await new Promise<void>((resolve) => void (started = resolve));
      track.processor = processor;
    });
    let effect: ReturnType<typeof useBackgroundEffect> | null = null;
    function Probe() {
      effect = useBackgroundEffect(fakeRoom(track), { mode: "none", imagePath: null });
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<Probe />));

    let blur!: Promise<void>;
    let image!: Promise<void>;
    await act(async () => {
      blur = effect!.setBlur();
      await vi.waitFor(() => expect(track.setProcessor).toHaveBeenCalled());
    });
    await act(async () => {
      image = effect!.setImage("/backgrounds/office.jpg");
    });
    await act(async () => {
      started();
      await Promise.all([blur, image]);
    });

    expect(effect!.mode).toBe("image");
    expect(effect!.lastError).toBeNull();
    expect(track.processor).toBe(created[0]);
    expect(created[0].switchTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "virtual-background", imagePath: "/backgrounds/office.jpg" }),
    );
  });
});
