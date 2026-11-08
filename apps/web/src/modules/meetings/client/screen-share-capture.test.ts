import type { LocalTrack } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ATTRIBUTE, parseScreenShareAsk, type ScreenShareAsk } from "@/modules/meetings/contract/live-state";
import { grantFor } from "@/modules/meetings/server/runtime/model";
import { ada, host, Meeting } from "@/modules/meetings/server/runtime/step-test-support";
import {
  SCREEN_SHARE_DECISION_TIMEOUT_MS,
  SCREEN_SHARE_DENIED_NOTICE_MS,
  SCREEN_SHARE_PERMISSION_TIMEOUT_MS,
  ScreenShareCapture,
  type ScreenShareCapturePort,
  type ScreenShareRequestState,
} from "./screen-share-capture";

function fakeTrack() {
  const mediaStreamTrack = new EventTarget();
  return { kind: "video", mediaStreamTrack, stop: vi.fn() };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakePort(overrides: Partial<ScreenShareCapturePort> = {}) {
  const track = fakeTrack();
  const port = {
    isSharing: vi.fn(() => false),
    stopSharing: vi.fn(async () => {}),
    canCaptureDisplay: vi.fn(() => true),
    capture: vi.fn(async () => [track as unknown as LocalTrack]),
    publish: vi.fn(async () => {}),
    request: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    notify: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
  return { port, track };
}

function started(overrides: Partial<ScreenShareCapturePort> = {}) {
  const { port, track } = fakePort(overrides);
  const capture = new ScreenShareCapture(port);
  capture.setAsk(null);
  capture.activate();
  return { capture, port, track, state: () => capture.getSnapshot().requestState };
}

describe("ScreenShareCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on an unanswered request and releases the capture", async () => {
    const { capture, port, track, state } = started();
    await capture.toggle();
    expect(state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(SCREEN_SHARE_DECISION_TIMEOUT_MS);
    expect(state()).toBe("idle");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(port.withdraw).toHaveBeenCalledTimes(1);
    expect(port.notify).toHaveBeenCalledWith("decision-timed-out");
    capture.deactivate();
  });

  it("gives up when an approval's permission never arrives", async () => {
    const { capture, port, track, state } = started();
    await capture.toggle();
    capture.setAsk({ state: "granted", revision: 2 });
    expect(state()).toBe("approved");
    await vi.advanceTimersByTimeAsync(SCREEN_SHARE_PERMISSION_TIMEOUT_MS);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(port.notify).toHaveBeenCalledWith("permission-timed-out");
    capture.deactivate();
  });

  it("withdraws a request the room holds with no capture behind it, once", async () => {
    const { capture, port, state } = started();
    capture.setAsk({ state: "requested", revision: 3 });
    capture.setAsk({ state: "requested", revision: 3 });
    expect(port.withdraw).toHaveBeenCalledTimes(1);
    expect(state()).toBe("idle");
    capture.deactivate();
  });

  it("lets a new attempt start after such a request was cleared up", async () => {
    const { capture, port } = started();
    capture.setAsk({ state: "requested", revision: 3 });
    capture.setAsk({ state: "none", revision: 4 });
    await capture.toggle();
    expect(port.capture).toHaveBeenCalledTimes(1);
    expect(port.request).toHaveBeenCalledTimes(1);
    capture.deactivate();
  });

  it("shows a refusal, releases the capture, and clears the notice", async () => {
    const { capture, track, state } = started();
    await capture.toggle();
    capture.setAsk({ state: "declined", revision: 2 });
    expect(state()).toBe("denied");
    expect(track.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SCREEN_SHARE_DENIED_NOTICE_MS);
    expect(state()).toBe("idle");
    capture.deactivate();
  });

  it("does not replay a refusal that was standing when this client arrived", () => {
    const { port } = fakePort();
    const capture = new ScreenShareCapture(port);
    capture.setAsk({ state: "declined", revision: 5 });
    capture.activate();
    expect(capture.getSnapshot().requestState).toBe("idle");
    capture.deactivate();
  });

  it("drops a report older than one already seen", () => {
    const { capture, state } = started();
    capture.setAsk({ state: "declined", revision: 4 });
    capture.setAsk({ state: "requested", revision: 3 });
    expect(state()).toBe("denied");
    capture.deactivate();
  });

  it("releases a held capture and withdraws when the room goes away", async () => {
    const { capture, port, track } = started();
    await capture.toggle();
    capture.deactivate();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(port.withdraw).toHaveBeenCalledTimes(1);
  });

  it("stops a capture whose picker resolves after the room went away", async () => {
    const track = fakeTrack();
    let answer!: (tracks: LocalTrack[]) => void;
    const { capture, port } = started({
      capture: vi.fn(() => new Promise<LocalTrack[]>((resolve) => { answer = resolve; })),
    });
    const toggling = capture.toggle();
    await vi.advanceTimersByTimeAsync(0);
    capture.deactivate();
    answer([track as unknown as LocalTrack]);
    await toggling;
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(port.request).not.toHaveBeenCalled();
  });

  it("cancels the request when the browser ends the capture", async () => {
    const { capture, port, track, state } = started();
    await capture.toggle();
    track.mediaStreamTrack.dispatchEvent(new Event("ended"));
    expect(state()).toBe("idle");
    expect(port.withdraw).toHaveBeenCalledTimes(1);
    capture.deactivate();
  });
});

/**
 * A client and the real meeting reducer, joined by channels that can deliver
 * in any order: requests on their way to the server, and attribute updates on
 * their way back. Permissions stay in order, as their own LiveKit event.
 */
class World {
  readonly m = new Meeting();
  readonly admissionId: string;
  readonly attemptId: string;
  readonly track = fakeTrack();
  readonly seen = new Set<ScreenShareRequestState>();
  readonly capture: ScreenShareCapture;
  readonly port: ReturnType<typeof fakePort>["port"];
  private readonly requests: Array<() => void> = [];
  private readonly asks: Array<ScreenShareAsk | null> = [];
  private readonly permissions: boolean[] = [];
  private lastAsk: string | undefined;
  private lastPermission = false;

  constructor(private readonly script: Array<(world: World) => void>) {
    this.m.joined(this.m.admitted(host).identity);
    const attendee = this.m.admitted(ada);
    this.m.joined(attendee.identity);
    this.admissionId = attendee.admissionId;
    this.attemptId = attendee.attemptId;
    const apply = (input: Parameters<Meeting["apply"]>[0]) => {
      this.m.apply(input);
      this.report();
    };
    const send = (input: Parameters<Meeting["apply"]>[0]) => new Promise<void>((resolve) => {
      this.requests.push(() => {
        apply(input);
        resolve();
      });
    });
    this.port = fakePort({
      capture: vi.fn(async () => [this.track as unknown as LocalTrack]),
      request: () => send({ kind: "requestScreenShare", subject: ada, attemptId: this.attemptId }),
      withdraw: () => send({ kind: "stopScreenShare", subject: ada, attemptId: this.attemptId }),
    }).port;
    this.capture = new ScreenShareCapture(this.port);
    this.capture.subscribe(() => this.seen.add(this.state));
    this.capture.setAsk(null);
    this.capture.activate();
  }

  get state() {
    return this.capture.getSnapshot().requestState;
  }

  get server() {
    return this.m.state.admissions[this.admissionId].screenShare;
  }

  decide(allow: boolean) {
    this.m.apply({ kind: "decideScreenShare", subject: host, admissionId: this.admissionId, allow });
    this.report();
  }

  private report() {
    const grant = grantFor(this.m.state, this.m.state.admissions[this.admissionId]);
    const ask = grant.attributes[PARTICIPANT_ATTRIBUTE.screenShare];
    if (ask !== this.lastAsk) {
      this.lastAsk = ask;
      this.asks.push(parseScreenShareAsk(ask));
    }
    if (grant.canScreenShare !== this.lastPermission) {
      this.lastPermission = grant.canScreenShare;
      this.permissions.push(grant.canScreenShare);
    }
  }

  /** Everything that could happen next. */
  options(): Array<() => void> {
    const options: Array<() => void> = [];
    if (this.script.length > 0) options.push(() => this.script.shift()!(this));
    this.requests.forEach((_, index) => options.push(() => this.requests.splice(index, 1)[0]()));
    this.asks.forEach((_, index) => options.push(() => this.capture.setAsk(this.asks.splice(index, 1)[0])));
    if (this.permissions.length > 0) options.push(() => this.capture.setPermission(this.permissions.shift()!));
    return options;
  }
}

/** Runs every ordering of one scenario, checking each once it has settled. */
async function everyOrdering(
  script: () => Array<(world: World) => void>,
  check: (world: World) => void,
): Promise<number> {
  const path: number[] = [];
  let orderings = 0;
  for (;;) {
    const world = new World(script());
    void world.capture.toggle();
    await flush();
    const widths: number[] = [];
    for (let depth = 0; ; depth += 1) {
      const options = world.options();
      if (options.length === 0) break;
      if (depth > 40) throw new Error("the scenario did not settle");
      path[depth] ??= 0;
      widths[depth] = options.length;
      options[path[depth]]();
      await flush();
    }
    check(world);
    world.capture.deactivate();
    orderings += 1;

    let last = widths.length - 1;
    while (last >= 0 && path[last] + 1 >= widths[last]) last -= 1;
    if (last < 0) return orderings;
    path.length = last + 1;
    path[last] += 1;
  }
}

describe("ScreenShareCapture, whatever arrives first", () => {
  it("never reads a cancel as a refusal, and leaves nothing open", async () => {
    const orderings = await everyOrdering(
      () => [(world) => world.capture.cancel()],
      (world) => {
        expect(world.seen).not.toContain("denied");
        expect(world.state).toBe("idle");
        expect(world.server).not.toBe("requested");
        expect(world.track.stop).toHaveBeenCalledTimes(1);
      },
    );
    expect(orderings).toBeGreaterThan(5);
  });

  it("publishes exactly once when a moderator approves", async () => {
    await everyOrdering(
      () => [(world) => world.decide(true)],
      (world) => {
        const outcome = {
          server: world.server,
          state: world.state,
          published: vi.mocked(world.port.publish).mock.calls.length,
          stopped: world.track.stop.mock.calls.length,
        };
        expect(outcome).toEqual(
          world.server === "granted"
            ? { server: "granted", state: "approved", published: 1, stopped: 0 }
            // Decided before the request reached the server: nothing to answer yet.
            : { server: "requested", state: "pending", published: 0, stopped: 0 },
        );
      },
    );
  });

  it("shows a refusal and releases the capture when a moderator declines", async () => {
    await everyOrdering(
      () => [(world) => world.decide(false)],
      (world) => {
        const outcome = {
          server: world.server,
          sawRefusal: world.seen.has("denied"),
          stopped: world.track.stop.mock.calls.length,
        };
        expect(outcome).toEqual(
          world.server === "declined"
            ? { server: "declined", sawRefusal: true, stopped: 1 }
            : { server: "requested", sawRefusal: false, stopped: 0 },
        );
      },
    );
  });

  it("settles a cancel racing a moderator's approval with no capture left behind", async () => {
    await everyOrdering(
      () => [(world) => world.capture.cancel(), (world) => world.decide(true)],
      (world) => {
        expect(world.server).not.toBe("requested");
        expect(world.track.stop).toHaveBeenCalledTimes(1);
        expect(world.capture.getSnapshot().hasPrepared).toBe(false);
      },
    );
  });
});
