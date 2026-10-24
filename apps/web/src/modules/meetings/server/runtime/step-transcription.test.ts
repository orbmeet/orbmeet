import { describe, expect, it } from "vitest";
import { roomAllowsTranscription } from "@orbmeet/caption-protocol/room-transcription";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { grantFor, roomMetadataFor, upgradeState, type MeetingState } from "./model";
import { ada, bob, host, kinds, Meeting } from "./step-test-support";

describe("transcription", () => {
  function meeting(transcription = true) {
    const m = new Meeting({ transcription });
    const h = m.admitted(host);
    m.joined(h.identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    return { m, a };
  }

  /** What the transcription agent reads from the room. */
  const agentTranscribes = (m: Meeting) => roomAllowsTranscription(JSON.stringify(roomMetadataFor(m.state)));
  const asks = (m: Meeting, admissionId: string) =>
    grantFor(m.state, m.state.admissions[admissionId]).attributes[PARTICIPANT_ATTRIBUTE.transcriptionStop];

  it("starts as the starter's account setting left it", () => {
    expect(agentTranscribes(meeting(true).m)).toBe(true);
    expect(agentTranscribes(meeting(false).m)).toBe(false);
  });

  it("is turned off and on by a host, for everyone, through the room", () => {
    const { m } = meeting();
    const off = m.apply({ kind: "setTranscription", subject: host, on: false });
    expect(off.reply).toEqual({ kind: "transcription", on: false });
    expect(agentTranscribes(m)).toBe(false);
    expect(kinds(m.plan())).toContain("livekit.roomMetadata");

    m.apply({ kind: "setTranscription", subject: host, on: true });
    expect(agentTranscribes(m)).toBe(true);
  });

  it("is turned off by a co-host too, and by nobody else", () => {
    const { m, a } = meeting();
    expect(m.refuse({ kind: "setTranscription", subject: ada, on: false }).code).toBe("FORBIDDEN");

    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    m.apply({ kind: "setTranscription", subject: ada, on: false });
    expect(agentTranscribes(m)).toBe(false);
  });

  describe("an attendee asking for it to stop", () => {
    it("shows the ask to every moderator, kept on the participant", () => {
      const { m, a } = meeting();
      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true });
      expect(asks(m, a.admissionId)).toBe("requested");
      expect(kinds(m.plan())).toContain("livekit.grant");

      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: false });
      expect(asks(m, a.admissionId)).toBe("");
    });

    it("is answered for everyone when it is turned off, and asks for nothing while off", () => {
      const { m, a } = meeting();
      const b = m.admitted(bob);
      m.joined(b.identity);
      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true });
      m.apply({ kind: "requestTranscriptionStop", subject: bob, attemptId: b.attemptId, requested: true });

      m.apply({ kind: "setTranscription", subject: host, on: false });
      expect(asks(m, a.admissionId)).toBe("");
      expect(asks(m, b.admissionId)).toBe("");

      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true });
      expect(m.state.admissions[a.admissionId].transcriptionStopRequested).toBe(false);
    });

    it("is declined by a moderator only, and leaves transcription on", () => {
      const { m, a } = meeting();
      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true });
      expect(
        m.refuse({ kind: "declineTranscriptionStop", subject: ada, admissionId: a.admissionId }).code,
      ).toBe("FORBIDDEN");

      m.apply({ kind: "declineTranscriptionStop", subject: host, admissionId: a.admissionId });
      expect(asks(m, a.admissionId)).toBe("");
      expect(agentTranscribes(m)).toBe(true);
    });

    it("is hidden while the attendee is a co-host, who can turn it off themselves", () => {
      const { m, a } = meeting();
      m.apply({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true });
      const shown = () => grantFor(m.state, m.state.admissions[a.admissionId]).attributes[PARTICIPANT_ATTRIBUTE.transcriptionStop];
      m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
      expect(shown()).toBe("");
      m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: false });
      expect(shown()).toBe("requested");
    });
  });

  it("reads a meeting stored before the switch existed as transcribing, with nobody asking", () => {
    const { m, a } = meeting();
    const stored = JSON.parse(JSON.stringify(m.state)) as MeetingState;
    delete (stored.meta as Partial<MeetingState["meta"]>).transcription;
    delete (stored.admissions[a.admissionId] as Partial<(typeof stored.admissions)[string]>).transcriptionStopRequested;

    const upgraded = upgradeState(stored);
    expect(upgraded.meta.transcription).toBe(true);
    expect(upgraded.admissions[a.admissionId].transcriptionStopRequested).toBe(false);
  });
});
