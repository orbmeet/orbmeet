import { describe, expect, it } from "vitest";
import { EGRESS_START_RESULT_TIMEOUT_MS, PRESENCE_CHECK_MS, roomMetadataFor } from "./model";

import { T0, host, ada, Meeting, kinds } from "./step-test-support";

describe("egress", () => {
  function recording() {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    return { m, h };
  }

  it("removes everyone at the end without waiting for the egress to stop", () => {
    const { m, h } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    m.apply({ kind: "egressStartResult", placement: m.here(), opId: started.once[0].opId, egressId: "EG_1", error: null });
    const a = m.admitted(ada);
    m.joined(a.identity);

    m.apply({ kind: "end", subject: host, reason: "host" });
    // The room is told it ended first; then everyone goes.
    const notice = m.plan().find((effect) => effect.kind === "livekit.roomMetadata");
    if (notice?.kind !== "livekit.roomMetadata") throw new Error("no end notice planned");
    expect(notice.metadata.ended).toBe(true);
    m.apply({ kind: "metadataApplied", placement: notice.placement, room: notice.room, version: notice.version });
    const planned = m.plan();
    expect(planned).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: h.identity }));
    expect(planned).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));
    expect(planned).toContainEqual(expect.objectContaining({ kind: "livekit.stopEgress", egressId: "EG_1" }));
    // The room itself waits for the recording to finish.
    expect(kinds(planned)).not.toContain("livekit.deleteRoom");
  });

  it("starts once, reports active, and stops", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    expect(kinds(started.once)).toEqual(["livekit.startEgress"]);
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    expect(kinds(m.apply({ kind: "tick" }).once)).toEqual([]);

    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_1", status: "active", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(m.state.egress.status).toBe("active");
    expect(m.state.egress.transition).toBe("started");

    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: false, target: null });
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.stopEgress", egressId: "EG_1" }));
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_1", status: "complete", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(m.state.egress.transition).toBe("stopped");
  });

  it("recovers a start whose result was lost by adopting what it created", () => {
    const { m } = recording();
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    m.now += EGRESS_START_RESULT_TIMEOUT_MS;
    expect(kinds(m.plan())).toContain("livekit.listEgress");
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_9", status: "starting", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(m.state.egress.egressId).toBe("EG_9");
    expect(m.state.egress.op).toBeNull();
  });

  it("stops an egress it no longer tracks instead of stopping everything on an error", () => {
    const { m } = recording();
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_stray", status: "active", streamActive: false, streamFailure: null, error: null },
    ] });
    const stops = () => m.plan().filter((effect) => effect.kind === "livekit.stopEgress");
    expect(stops()).toEqual([expect.objectContaining({ egressId: "EG_stray" })]);
    // Kept until a stop lands, however many ticks that takes.
    m.advance(1_000);
    expect(stops()).toEqual([expect.objectContaining({ egressId: "EG_stray" })]);
    m.apply({ kind: "egressStopped", placement: m.here(), egressId: "EG_stray", missing: false });
    expect(stops()).toEqual([]);
  });

  it("keeps the egress its unanswered start created when a webhook reports it first", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    // LiveKit's egress_started webhook lands before the start call's reply.
    const observed = m.apply({ kind: "egressObserved", complete: false, egresses: [
      { egressId: "EG_1", status: "starting", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(observed.once).toEqual([]);
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    expect(m.state.egress.egressId).toBe("EG_1");
    expect(m.plan()).not.toContainEqual(expect.objectContaining({ kind: "livekit.stopEgress" }));
  });

  it("gives up a start the provider refused, without looping", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: null, error: "quota" });
    expect(m.state.egress.desired).toBeNull();
    expect(m.state.egress.transition).toBe("failed");
    expect(kinds(m.apply({ kind: "tick" }).once)).toEqual([]);
  });

  it("stops what a start created when the host switched modes before it answered", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: true, target: "rtmps://a/key" });
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: false, target: null });
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });

    const answered = m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_stream", error: null });
    expect(m.state.egress.egressId).toBeNull();
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.stopEgress", egressId: "EG_stream" }));
    // The recording the host asks for now is started in its place.
    expect(answered.once).toContainEqual(expect.objectContaining({ kind: "livekit.startEgress", mode: "recording" }));
  });

  it("does not adopt a stream to a destination the host replaced", () => {
    const { m } = recording();
    m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: true, target: "rtmps://a/key" });
    m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: false, target: null });
    m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: true, target: "rtmps://b/key" });
    m.now += EGRESS_START_RESULT_TIMEOUT_MS;
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_to_a", status: "active", streamActive: true, streamFailure: null, error: null },
    ] });
    expect(m.state.egress.egressId).toBeNull();
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.stopEgress", egressId: "EG_to_a" }));
  });

  it("does not fail what the host wants now when an earlier start is refused", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: true, target: "rtmps://a/key" });
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    m.apply({ kind: "setEgress", subject: host, mode: "streaming", on: false, target: null });
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: null, error: "bad stream key" });
    expect(m.state.egress.desired).toBe("recording");
    expect(m.state.egress.lastFailure).toBeNull();
  });

  it("keeps looking up an active egress, and notices one that ended unseen", () => {
    const { m } = recording();
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    const opId = started.once[0].kind === "livekit.startEgress" ? started.once[0].opId : "";
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_1", status: "active", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(kinds(m.plan())).not.toContain("livekit.listEgress");

    // Its egress_ended webhook is lost; the slow lookup still comes due.
    m.now += PRESENCE_CHECK_MS;
    expect(kinds(m.plan())).toContain("livekit.listEgress");
    m.apply({ kind: "egressObserved", complete: true, egresses: [
      { egressId: "EG_1", status: "complete", streamActive: false, streamFailure: null, error: null },
    ] });
    expect(m.state.egress.egressId).toBeNull();
    expect(m.state.egress.transition).toBe("failed");
  });

  it("fails the egress and ends old-node attempts when the meeting moves", () => {
    const { m, h } = recording();
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    m.apply({ kind: "placed", nodeId: "node-b", from: "node-a" });
    expect(m.state.attempts[h.attemptId].endReason).toBe("media_node_moved");
    expect(m.state.egress.lastFailure).toMatch(/unreachable/);
    expect(m.state.meta.phase).toBe("live");
  });
});

describe("results from a placement the meeting has left", () => {
  function moved() {
    const m = new Meeting();
    const a = m.admitted(host);
    m.joined(a.identity);
    m.apply({ kind: "setCountdown", subject: host, endsAt: T0 + 300_000 });
    const onA = m.here();
    const metadata = m.plan().find((effect) => effect.kind === "livekit.roomMetadata");
    if (metadata?.kind !== "livekit.roomMetadata") throw new Error("expected a metadata push");
    m.apply({ kind: "placed", nodeId: "node-b", from: "node-a" });
    const b = m.admitted(host, { admissionId: a.admissionId });
    m.joined(b.identity);
    return { m, onA, metadata, b };
  }

  it("does not mark the new room's metadata applied by the old room's late acknowledgement", () => {
    const { m, onA, metadata } = moved();
    m.apply({
      kind: "effectSucceeded",
      key: "metadata",
      result: { kind: "metadataApplied", placement: onA, room: metadata.room, version: metadata.version },
    });
    expect(m.state.room.appliedVersion).toBe(0);
    expect(m.plan()).toContainEqual(
      expect.objectContaining({ kind: "livekit.roomMetadata", placement: m.here() }),
    );
  });

  it("does not take the old room's listing for the new room", () => {
    const { m, onA, b } = moved();
    m.apply({
      kind: "effectSucceeded",
      key: "presence",
      result: { kind: "participantsListed", placement: onA, requestedAt: m.now, participants: [], roomExists: true },
    });
    expect(m.state.attempts[b.attemptId].absentSince).toBeNull();
  });

  it("tells a return to the same node from the placement it left", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const first = m.here();
    m.apply({ kind: "placed", nodeId: "node-b", from: "node-a" });
    m.apply({ kind: "placed", nodeId: "node-a", from: "node-b" });
    expect(m.here()).toMatchObject({ nodeId: "node-a" });
    expect(m.here().generation).not.toBe(first.generation);
  });

  it("does not count the old room's failed looks toward giving up the new one", () => {
    const { m, onA } = moved();
    m.apply({ kind: "effectFailed", key: "presence", error: "timeout", placement: onA });
    expect(m.state.room.unreachableSince).toBeNull();
  });

  it("acts on the node each effect was planned for", () => {
    const { m } = moved();
    const placements = m.plan().flatMap((effect) => ("placement" in effect ? [effect.placement] : []));
    expect(placements.length).toBeGreaterThan(0);
    expect(placements).toEqual(placements.map(() => m.here()));
  });
});

describe("egress, late and failed", () => {
  function recording() {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const started = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    const op = started.once[0];
    if (op?.kind !== "livekit.startEgress") throw new Error("expected a start");
    return { m, opId: op.opId };
  }
  const active = (egressId: string) =>
    ({ egressId, status: "active" as const, streamActive: false, streamFailure: null, error: null });

  it("keeps a recording a late start reply names after the room lookup adopted it", () => {
    const { m, opId } = recording();
    m.advance(EGRESS_START_RESULT_TIMEOUT_MS);
    m.apply({ kind: "egressObserved", placement: m.here(), complete: true, egresses: [active("EG_1")] });
    expect(m.state.egress.egressId).toBe("EG_1");
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    expect(m.state.egress.strays).toEqual([]);
    expect(kinds(m.plan())).not.toContain("livekit.stopEgress");
  });

  it("does not adopt an egress it is already stopping", () => {
    const { m, opId } = recording();
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: false, target: null });
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    expect(m.state.egress.strays).toEqual(["EG_1"]);
    const again = m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    if (again.once[0]?.kind !== "livekit.startEgress") throw new Error("expected a start");
    m.advance(EGRESS_START_RESULT_TIMEOUT_MS);
    m.apply({
      kind: "egressObserved",
      placement: m.here(),
      complete: true,
      egresses: [active("EG_1"), active("EG_2")],
    });
    expect(m.state.egress.egressId).toBe("EG_2");
    expect(m.state.egress.strays).toEqual(["EG_1"]);
  });

  it("reports a failure once, and still stops showing the egress when it ends", () => {
    const { m, opId } = recording();
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    m.apply({ kind: "egressObserved", placement: m.here(), complete: true, egresses: [active("EG_1")] });
    m.apply({
      kind: "egressObserved",
      complete: false,
      egresses: [{ ...active("EG_1"), streamFailure: "The destination hung up." }],
    });
    expect(m.state.egress).toMatchObject({ transition: "failed", lastFailure: "The destination hung up." });
    const failedRevision = m.state.egress.revision;
    const versionAtFailure = m.state.room.version;

    m.apply({
      kind: "egressObserved",
      placement: m.here(),
      complete: true,
      egresses: [{ ...active("EG_1"), status: "complete" }],
    });
    expect(m.state.egress).toMatchObject({
      egressId: null,
      transition: "failed",
      revision: failedRevision,
      lastFailure: "The destination hung up.",
    });
    expect(m.state.room.version).toBeGreaterThan(versionAtFailure);
    expect(roomMetadataFor(m.state).egressMode).toBeNull();
  });

  it("reports a stop the host asked for as stopped", () => {
    const { m, opId } = recording();
    m.apply({ kind: "egressStartResult", placement: m.here(), opId, egressId: "EG_1", error: null });
    m.apply({ kind: "egressObserved", placement: m.here(), complete: true, egresses: [active("EG_1")] });
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: false, target: null });
    m.apply({
      kind: "egressObserved",
      placement: m.here(),
      complete: true,
      egresses: [{ ...active("EG_1"), status: "complete" }],
    });
    expect(m.state.egress.transition).toBe("stopped");
  });

  it("refuses a different destination for a stream already wanted, and repeats the same one", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const stream = (target: string) =>
      ({ kind: "setEgress", subject: host, mode: "streaming", on: true, target }) as const;
    m.apply(stream("rtmps://a.example/live/key"));
    expect(m.apply(stream("rtmps://a.example/live/key")).once).toEqual([]);
    expect(m.refuse(stream("rtmps://b.example/live/key")).code).toBe("VALIDATION_ERROR");
    expect(m.state.egress.target).toBe("rtmps://a.example/live/key");
  });
});
