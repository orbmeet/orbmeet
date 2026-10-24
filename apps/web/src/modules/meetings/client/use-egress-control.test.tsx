// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLOSED_MEETING_SURFACE, type MeetingRoomState } from "@/modules/meetings/contract/live-state";
import { useEgressControl, type EgressCopy } from "./use-egress-control";

let roomState: MeetingRoomState | null = null;
vi.mock("./use-meeting-live-state", () => ({
  useMeetingRoomState: () => roomState,
}));

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  roomState = null;
});

const COPY: EgressCopy = {
  started: { title: "started", description: "" },
  stopped: { title: "stopped", description: "" },
  failedToStart: "failed to start",
  failedToStop: "failed to stop",
  interrupted: { title: "interrupted", description: "" },
};

function state(overrides: Partial<MeetingRoomState>): MeetingRoomState {
  return {
    version: 1,
    ended: false,
    joinPolicy: "open",
    transcription: true,
    egressMode: null,
    egressRevision: 0,
    egressTransition: "sync",
    countdown: { endsAt: null, version: 0 },
    admissionsVersion: 0,
    surface: CLOSED_MEETING_SURFACE,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Toggle = Parameters<typeof useEgressControl>[0]["toggle"];

function mount(toggle: Toggle, options: { initiallyActive?: boolean } = {}) {
  const addToast = vi.fn();
  let latest: ReturnType<typeof useEgressControl> | null = null;
  function Probe() {
    latest = useEgressControl({
      mode: "recording",
      initiallyActive: options.initiallyActive ?? false,
      initialRevision: 0,
      roomInstance: undefined,
      addToast,
      copy: COPY,
      toggle,
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
  return {
    addToast,
    get control() {
      return latest!;
    },
    /** The room reports a new state. */
    report(next: MeetingRoomState) {
      roomState = next;
      act(() => root!.render(<Probe />));
    },
  };
}

describe("useEgressControl", () => {
  it("settles a start whose room update beats the reply", async () => {
    const reply = deferred<Awaited<ReturnType<Toggle>>>();
    const view = mount(() => reply.promise);

    let running!: Promise<void>;
    act(() => {
      running = view.control.run(true);
    });
    // The egress goes live before the start request's reply comes back.
    view.report(state({ version: 2, egressMode: "recording", egressRevision: 1, egressTransition: "started" }));
    await act(async () => {
      reply.resolve({ status: "starting", lastFailure: null, revision: 0 });
      await running;
    });

    expect(view.control).toMatchObject({ active: true, pending: false });
    expect(view.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "started" }));
  });

  it("stays pending until the room reports the start", async () => {
    const view = mount(async () => ({ status: "starting", lastFailure: null, revision: 0 }));
    await act(async () => {
      await view.control.run(true);
    });
    expect(view.control).toMatchObject({ active: false, pending: true });

    view.report(state({ version: 2, egressMode: "recording", egressRevision: 1, egressTransition: "started" }));
    expect(view.control).toMatchObject({ active: true, pending: false });
  });

  it("warns when a running recording ends on its own", () => {
    const view = mount(async () => ({ status: null, lastFailure: null, revision: 0 }));
    view.report(state({ version: 2, egressMode: "recording", egressRevision: 1, egressTransition: "started" }));
    expect(view.control.active).toBe(true);

    view.report(state({ version: 3, egressMode: null, egressRevision: 2, egressTransition: "failed" }));
    expect(view.control.active).toBe(false);
    expect(view.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "interrupted" }));
  });

  it("does not warn about a failure that interrupted nothing of this control's", () => {
    const view = mount(async () => ({ status: null, lastFailure: null, revision: 0 }));
    view.report(state({ version: 2, egressMode: null, egressRevision: 1, egressTransition: "failed" }));
    expect(view.addToast).not.toHaveBeenCalled();
  });
});
