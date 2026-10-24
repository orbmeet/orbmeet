// @vitest-environment jsdom
/**
 * Regression test for finding meetings-client-meetings-1:
 * "Recorder/egress video gallery renders permanently invisible: stage
 * measurement effect never attaches when the first render has zero tiles".
 *
 * VideoGrid's gallery-fit ResizeObserver effect (video-layout/video-grid.tsx) captures
 * `stageRef.current` once and only re-runs when `isPhone` changes. When the
 * first render takes the `gridTileCount === 0` early return (the "Waiting for
 * participants" card has no stage div), the effect bails on `!element`. When
 * tiles appear later the stage div mounts, but the effect never re-runs:
 * `stageSize` stays {0,0}, `galleryFit` stays null, and `awaitingMeasurement`
 * keeps the whole tile container at `opacity-0` permanently. For an egress
 * recorder (`excludeLocalParticipant`), the first render deterministically has
 * zero tiles because `useRemoteParticipants` initializes its state to `[]`.
 *
 * This test asserts the CORRECT behavior: once a remote participant appears
 * (state-update re-render of the same component instance, no remount), the
 * measurement observer must attach to the now-mounted stage element and the
 * tile container must not be stuck invisible.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoGrid } from "./video-layout";

const harness = vi.hoisted(() => ({
  participants: [] as Array<Record<string, unknown>>,
  tracks: [] as Array<Record<string, unknown>>,
  useTracks: vi.fn(),
  useParticipants: vi.fn(),
  observe: vi.fn(),
}));

vi.mock("@livekit/components-react", () => ({
  useTracks: harness.useTracks,
  useParticipants: harness.useParticipants,
  useIsMuted: () => false,
  useParticipantAttribute: () => undefined,
  VideoTrack: () => null,
}));

vi.mock("@/lib/hooks/use-responsive", () => ({
  useResponsive: () => ({
    mode: "desktop",
    orientation: "landscape",
    isPhone: false,
    isTablet: false,
    isDesktop: true,
    isLandscape: true,
    isNarrow: false,
    isCompact: false,
    controlBarAutoHide: false,
    useBottomSheet: false,
  }),
}));

harness.useTracks.mockImplementation(() => harness.tracks);
harness.useParticipants.mockImplementation(() => harness.participants);

const RECORDER = {
  identity: "recorder",
  name: "Recorder",
  isLocal: true,
  isSpeaking: false,
  isMicrophoneEnabled: true,
  audioLevel: 0,
};

const HOST = {
  identity: "host",
  name: "Host",
  isLocal: false,
  isSpeaking: false,
  isMicrophoneEnabled: true,
  audioLevel: 0,
};

class ResizeObserverStub {
  observe = harness.observe;
  disconnect = vi.fn();
  unobserve = vi.fn();
}

let originalRaf: typeof requestAnimationFrame | undefined;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderGrid() {
  act(() => {
    root!.render(<VideoGrid excludeLocalParticipant />);
  });
}

describe("VideoGrid gallery measurement (egress: first render has zero tiles)", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // The voice-glow rAF loop is irrelevant here; keep the test hermetic.
    originalRaf = globalThis.requestAnimationFrame;
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      top: 0,
      right: 1280,
      bottom: 720,
      left: 0,
      toJSON: () => ({}),
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (originalRaf) globalThis.requestAnimationFrame = originalRaf;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    root = undefined;
    container = undefined;
    harness.observe.mockClear();
    harness.useTracks.mockClear();
    harness.useParticipants.mockClear();
  });

  it("attaches the stage measurement observer once tiles appear after an empty first render", () => {
    // Frame 1: egress recorder connects; useParticipants() = [local] (remote
    // list still []), and the local participant is excluded, so zero tiles.
    harness.participants = [RECORDER];
    harness.tracks = [];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderGrid();

    // Sanity: the empty-grid early return committed (no stage div exists).
    expect(container.textContent).toContain("Waiting for participants");
    // Nothing to observe yet — correct on both buggy and fixed code.
    expect(harness.observe).not.toHaveBeenCalled();

    // Frame 2: the host's participant events land; `useRemoteParticipants`
    // populates via a state update, re-rendering the SAME component instance.
    harness.participants = [RECORDER, HOST];
    harness.tracks = [];
    renderGrid();

    // The real stage tree (with the `stageRef` div) must have mounted...
    expect(container.textContent).toContain("Host");
    expect(container.textContent).not.toContain("Waiting for participants");

    // ...and therefore the measurement effect must have attached to it.
    // BUG: the effect deps are [isPhone] and refs don't trigger re-runs, so
    // observe() is never called and stageSize stays {0,0}.
    expect(harness.observe).toHaveBeenCalled();
  });

  it("does not leave the tile container permanently invisible (opacity-0) after tiles appear", () => {
    harness.participants = [RECORDER];
    harness.tracks = [];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderGrid();

    // Same-component state update: remotes arrive one frame later.
    harness.participants = [RECORDER, HOST];
    harness.tracks = [];
    renderGrid();

    // The host avatar tile rendered into the gallery container...
    expect(container.textContent).toContain("Host");
    // ...but with no measurement the `awaitingMeasurement` wrapper keeps the
    // whole tile container at opacity-0 forever. BUG: this element exists.
    expect(container.querySelector(".opacity-0")).toBeNull();
  });
});
