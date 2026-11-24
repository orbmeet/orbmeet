import { describe, expect, it } from "vitest";
import { ABSENT_GRACE_MS } from "./model";
import type { Subject } from "./protocol";
import { Meeting } from "./step-test-support";

const chen: Subject = { kind: "user", userId: "chen", spaceRole: "member" };
const dana: Subject = { kind: "user", userId: "dana", spaceRole: "member" };

function sharedMeeting() {
  // dana organizes, chen started: dana stands in as host while seated.
  return new Meeting({ spaceKind: "shared", allowGuests: false, startedByUserId: "chen", organizerUserId: "dana" });
}

describe("endedRole when several attempts end in one change", () => {
  it("presence listing ending both the stand-in and the starter at once", () => {
    const m = sharedMeeting();
    const d = m.admitted(dana);
    m.joined(d.identity);
    const c = m.admitted(chen);
    m.joined(c.identity);
    // Both drop.
    m.apply({ kind: "participantLeft", identity: d.identity, sid: `sid-${d.identity}`, at: m.now });
    m.apply({ kind: "participantLeft", identity: c.identity, sid: `sid-${c.identity}`, at: m.now });
    m.advance(ABSENT_GRACE_MS + 1);
    m.listed([]);

    console.log("listing:", {
      dana: m.state.attempts[d.attemptId].endedRole,
      chen: m.state.attempts[c.attemptId].endedRole,
    });
    expect(m.state.attempts[d.attemptId].endedRole).toBe("host");
    expect(m.state.attempts[c.attemptId].endedRole).toBe("attendee");
  });

  it("abandoning the node ends both at once", () => {
    const m = sharedMeeting();
    const d = m.admitted(dana);
    m.joined(d.identity);
    const c = m.admitted(chen);
    m.joined(c.identity);

    m.admitted({ kind: "user", userId: "eli", spaceRole: "member" }, { placement: { nodeId: "node-b", from: "node-a" } });

    console.log("abandon:", {
      dana: m.state.attempts[d.attemptId].endedRole,
      chen: m.state.attempts[c.attemptId].endedRole,
    });
    expect(m.state.attempts[d.attemptId].endedRole).toBe("host");
    expect(m.state.attempts[c.attemptId].endedRole).toBe("attendee");
  });

  it("the end of the meeting (already fixed) for comparison", () => {
    const m = sharedMeeting();
    const d = m.admitted(dana);
    m.joined(d.identity);
    const c = m.admitted(chen);
    m.joined(c.identity);
    m.apply({ kind: "end", subject: dana, reason: "host" });
    expect(m.state.attempts[d.attemptId].endedRole).toBe("host");
    expect(m.state.attempts[c.attemptId].endedRole).toBe("attendee");
  });
});
