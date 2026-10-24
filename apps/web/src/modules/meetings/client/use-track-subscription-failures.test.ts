import { describe, expect, it } from "vitest";
import { Track, type RemoteParticipant } from "livekit-client";
import {
  decideSubscriptionFailureToast,
  describeSubscriptionFailureKind,
  SUBSCRIPTION_FAILURE_TOAST_COOLDOWN_MS,
} from "./use-track-subscription-failures";

function makeParticipant(opts: {
  identity: string;
  sidKind?: Track.Kind;
}): RemoteParticipant {
  const pub =
    opts.sidKind === undefined
      ? undefined
      : { kind: opts.sidKind };
  return {
    identity: opts.identity,
    getTrackPublicationBySid: () => pub,
  } as unknown as RemoteParticipant;
}

describe("describeSubscriptionFailureKind", () => {
  it("classifies an audio track publication as audio", () => {
    const p = makeParticipant({ identity: "alice", sidKind: Track.Kind.Audio });
    expect(describeSubscriptionFailureKind(p, "TR_abc")).toBe("audio");
  });

  it("classifies a video track publication as video", () => {
    const p = makeParticipant({ identity: "alice", sidKind: Track.Kind.Video });
    expect(describeSubscriptionFailureKind(p, "TR_abc")).toBe("video");
  });

  it("returns unknown when no publication is found for the sid", () => {
    const p = makeParticipant({ identity: "alice" }); // sidKind undefined → no pub
    expect(describeSubscriptionFailureKind(p, "TR_missing")).toBe("unknown");
  });
});

describe("decideSubscriptionFailureToast", () => {
  it("toasts for a first-time failure and records the timestamp", () => {
    const { toast, nextLastToastedAt } = decideSubscriptionFailureToast(
      new Map(),
      "alice:TR_1",
      1_000,
    );
    expect(toast).toBe(true);
    expect(nextLastToastedAt.get("alice:TR_1")).toBe(1_000);
  });

  it("suppresses a repeat failure for the same participant+track within the cooldown", () => {
    const initial = new Map([["alice:TR_1", 1_000]]);
    const { toast } = decideSubscriptionFailureToast(
      initial,
      "alice:TR_1",
      1_000 + SUBSCRIPTION_FAILURE_TOAST_COOLDOWN_MS - 1,
    );
    expect(toast).toBe(false);
  });

  it("toasts again after the cooldown elapses", () => {
    const initial = new Map([["alice:TR_1", 1_000]]);
    const { toast } = decideSubscriptionFailureToast(
      initial,
      "alice:TR_1",
      1_000 + SUBSCRIPTION_FAILURE_TOAST_COOLDOWN_MS,
    );
    expect(toast).toBe(true);
  });

  it("does not conflate failures across participants or tracks", () => {
    const initial = new Map([["alice:TR_1", 1_000]]);
    const { toast } = decideSubscriptionFailureToast(initial, "bob:TR_1", 1_100);
    expect(toast).toBe(true);
  });

  it("does not mutate the input map", () => {
    const initial = new Map<string, number>();
    decideSubscriptionFailureToast(initial, "alice:TR_1", 1_000);
    expect(initial.size).toBe(0);
  });
});
