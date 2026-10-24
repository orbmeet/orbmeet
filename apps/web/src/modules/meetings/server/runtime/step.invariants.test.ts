import { describe, expect, it } from "vitest";
import { ADMISSION_PENDING_TTL_MS, EMPTY_MEETING_GRACE_MS, type MeetingSnapshot, type MeetingState, type SpaceRole } from "./model";
import { plan } from "./plan";
import type { Input, Subject } from "./protocol";
import { applyInputs, step } from "./step";

/**
 * The rules a meeting's state keeps whatever happens to it, checked after
 * every input of many random runs. Example tests show one path to a state;
 * these hold for every path the vocabulary below can take, including the
 * interleavings nobody thought to write down.
 */

const T0 = 1_800_000_000_000;
const RUNS = 400;
const STEPS = 80;

const snapshot: MeetingSnapshot = {
  meetingId: "meeting_1",
  title: null,
  spaceId: "space_1",
  spaceKind: "shared",
  allowGuests: true,
  startedByUserId: "host",
  organizerUserId: null,
  startedAt: T0,
  joinPolicy: "open",
  transcription: true,
  maxParticipants: null,
  recordingEnabled: true,
  maxDurationMs: 90 * 60_000,
  nodeId: "node-a",
  firstJoinedAt: null,
};

const USERS = ["host", "ada", "bob", "carol"] as const;
const NETWORKS = ["net-1", "net-2", null] as const;
const ROLES: SpaceRole[] = ["admin", "member", "visitor"];

/** mulberry32: a small seeded generator, so a failing run can be replayed by its seed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

/**
 * One run: the meeting, the world it reads (each user's Space role as of the
 * last change), and the inputs a room would send it — including reads that
 * were taken earlier and arrive late.
 */
class Run {
  state: MeetingState;
  now = T0;
  seq = 0;
  /** What D1 has said each user's Space role is over time, oldest first. */
  history = new Map<string, Array<{ role: SpaceRole; since: number }>>(
    USERS.map((userId) => [userId, [{ role: userId === "host" ? "admin" : "member", since: T0 }]]),
  );

  /** The role D1 shows now, and since when. */
  truth(userId: string) {
    return this.history.get(userId)!.at(-1)!;
  }

  /** The role a read taken at `at` saw. */
  roleAt(userId: string, at: number): SpaceRole {
    const history = this.history.get(userId)!;
    return ([...history].reverse().find((entry) => entry.since <= at) ?? history[0]).role;
  }
  /** Guest admissions this run created, with the secret hash and network each came from. */
  guests: Array<{ admissionId: string; network: string | null }> = [];
  log: string[] = [];

  constructor(readonly rng: ReturnType<typeof random>) {
    this.state = step(null, { kind: "init", snapshot }, T0).state;
  }

  apply(inputs: Input[]) {
    this.log.push(inputs.map((input) => JSON.stringify(input)).join(" + "));
    const applied = applyInputs(this.state, inputs, this.now);
    this.state = applied.state;
    return applied;
  }

  userSubject(userId: string): { subject: Subject; authority: Input } {
    const { role } = this.truth(userId);
    return {
      subject: { kind: "user", userId, spaceRole: role },
      // The room reads authority inside the commit, just before it applies it.
      authority: { kind: "authority", userId, spaceRole: role, reason: "space_membership_removed", readAt: this.now },
    };
  }

  liveAttempts() {
    return Object.values(this.state.attempts).filter((attempt) => attempt.endedAt === null);
  }

  move(): { inputs: Input[]; check?: (before: MeetingState) => void } {
    const { rng } = this;
    this.seq += 1;
    const ids = { newAdmissionId: `adm_${this.seq}`, newAttemptId: `att_${this.seq}`, clientAttemptId: `c_${this.seq}` };
    const base = { displayName: "x", captionLanguage: "en", replacesAttemptId: null };
    switch (rng.int(12)) {
      case 0:
      case 1: {
        const userId = rng.pick(USERS);
        const { subject, authority } = this.userSubject(userId);
        const own = Object.values(this.state.admissions).filter((admission) => admission.userId === userId);
        const admissionId = own.length > 0 && rng.chance(0.4) ? rng.pick(own).id : null;
        return {
          inputs: [authority, { kind: "join", subject, admissionId, ...ids, ...base, newGuestSecretHash: null, guestNetworkKey: null }],
          check: (before) => {
            const reply = this.lastReply;
            if (!reply || (reply.kind !== "admitted" && reply.kind !== "waiting")) return;
            const barred = before.barred?.userIds.includes(userId) ?? false;
            const manager = this.truth(userId).role === "admin";
            if (barred && !manager) throw new Error(`barred user ${userId} was let back in`);
          },
        };
      }
      case 2: {
        const network = rng.pick(NETWORKS);
        const existing = this.guests.length > 0 && rng.chance(0.5) ? rng.pick(this.guests) : null;
        const subject: Subject = existing
          ? { kind: "guest", admissionId: existing.admissionId, verified: true }
          : { kind: "guest", admissionId: null, verified: false };
        if (!existing) this.guests.push({ admissionId: ids.newAdmissionId, network });
        return {
          inputs: [{
            kind: "join", subject, admissionId: existing?.admissionId ?? null, ...ids, ...base,
            newGuestSecretHash: existing ? null : `secret_${this.seq}`, guestNetworkKey: network,
          }],
          check: (before) => {
            const reply = this.lastReply;
            if (!reply || (reply.kind !== "admitted" && reply.kind !== "waiting") || !network) return;
            if (!before.barred?.guestNetworks.includes(network)) return;
            const admission = this.state.admissions[reply.kind === "admitted" ? reply.participant.admissionId : reply.admissionId];
            if (!admission.moderator) throw new Error(`attendee guest let in from barred ${network}`);
          },
        };
      }
      case 3: {
        const attempts = Object.values(this.state.attempts);
        if (attempts.length === 0) return { inputs: [{ kind: "tick" }] };
        const attempt = rng.pick(attempts);
        return { inputs: [{ kind: "participantJoined", identity: attempt.identity, sid: `sid_${attempt.id}`, joinedAt: this.now, at: this.now }] };
      }
      case 4: {
        const admissions = Object.values(this.state.admissions);
        if (admissions.length === 0) return { inputs: [{ kind: "tick" }] };
        const actor = this.userSubject(rng.pick(USERS));
        return { inputs: [actor.authority, { kind: "removeParticipant", subject: actor.subject, admissionId: rng.pick(admissions).id }] };
      }
      case 5: {
        const attempts = this.liveAttempts();
        if (attempts.length === 0) return { inputs: [{ kind: "tick" }] };
        const actor = this.userSubject(rng.pick(USERS));
        return {
          inputs: [actor.authority, { kind: "setModerator", subject: actor.subject, identity: rng.pick(attempts).identity, moderator: rng.chance(0.7) }],
        };
      }
      case 6: {
        // A Space role change: D1 changes now, and the room hears of it now.
        const userId = rng.pick(USERS.slice(1));
        const role = rng.pick(ROLES);
        this.history.get(userId)!.push({ role, since: this.now });
        return { inputs: [{ kind: "authority", userId, spaceRole: role, reason: "space_role_changed", readAt: this.now }] };
      }
      case 7: {
        // A read taken some time ago, of whatever the role was then, lands now.
        const userId = rng.pick(USERS.slice(1));
        const readAt = this.now - rng.int(5_000);
        const role = this.roleAt(userId, readAt);
        return { inputs: [{ kind: "authority", userId, spaceRole: role, reason: "space_membership_removed", readAt }] };
      }
      case 8: {
        const pending = Object.values(this.state.admissions).filter((admission) => admission.status === "pending");
        if (pending.length === 0) {
          const actor = this.userSubject("host");
          return { inputs: [actor.authority, { kind: "setJoinPolicy", subject: actor.subject, joinPolicy: rng.pick(["open", "approval_required", "closed"] as const) }] };
        }
        const actor = this.userSubject(rng.pick(USERS));
        return { inputs: [actor.authority, { kind: "decideAdmission", subject: actor.subject, admissionId: rng.pick(pending).id, approve: rng.chance(0.6) }] };
      }
      case 9: {
        const roomEvent = rng.pick(["roomStarted", "roomFinished"] as const);
        const write = plan(this.state, this.now).find((effect) => effect.kind === "livekit.roomMetadata");
        if (write?.kind === "livekit.roomMetadata" && rng.chance(0.5)) {
          // A write outstanding across a room restart, acknowledged after it.
          this.pendingAck = { kind: "metadataApplied", placement: write.placement, room: write.room, version: write.version };
        }
        return { inputs: [{ kind: roomEvent }] };
      }
      case 10: {
        if (this.pendingAck) {
          const ack = this.pendingAck;
          this.pendingAck = null;
          return { inputs: [{ kind: "effectSucceeded", key: "metadata", result: ack }] };
        }
        const write = plan(this.state, this.now).find((effect) => effect.kind === "livekit.roomMetadata");
        if (write?.kind !== "livekit.roomMetadata") return { inputs: [{ kind: "tick" }] };
        return { inputs: [{ kind: "effectSucceeded", key: "metadata", result: { kind: "metadataApplied", placement: write.placement, room: write.room, version: write.version } }] };
      }
      default: {
        this.now += rng.pick([1, 1_000, 30_000, ADMISSION_PENDING_TTL_MS, EMPTY_MEETING_GRACE_MS]);
        return { inputs: [{ kind: "tick" }] };
      }
    }
  }

  pendingAck: Extract<Input, { kind: "metadataApplied" }> | null = null;
  lastReply: ReturnType<typeof applyInputs>["reply"];
}

/** Rules about the state alone. */
function checkState(run: Run): void {
  const { state } = run;
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.endedAt !== null) continue;
    const admission = state.admissions[attempt.admissionId];
    if (!admission || admission.status !== "approved") {
      throw new Error(`live attempt ${attempt.id} on a ${admission?.status ?? "missing"} admission`);
    }
    if (state.meta.phase !== "provisional" && state.meta.phase !== "live") {
      throw new Error(`live attempt ${attempt.id} in a ${state.meta.phase} meeting`);
    }
  }
  for (const admission of Object.values(state.admissions)) {
    if (admission.moderator && admission.status !== "approved") {
      throw new Error(`${admission.status} admission ${admission.id} is still a moderator`);
    }
    if (admission.userId && admission.status === "approved") {
      // The newest read wins, whatever order reads arrive in.
      const truth = run.truth(admission.userId);
      if ((admission.spaceRoleAt ?? 0) >= truth.since && admission.spaceRole !== truth.role) {
        throw new Error(`${admission.userId} holds ${admission.spaceRole}; their Space says ${truth.role}`);
      }
    }
  }
  if (state.meta.phase === "ended" || state.meta.phase === "drained") {
    if (state.meta.firstJoinedAt === null && state.meta.endReason !== "discarded") {
      throw new Error(`a meeting nobody joined ended as ${state.meta.endReason}`);
    }
  }
  if (state.room.appliedVersion > state.room.version) {
    throw new Error(`applied room version ${state.room.appliedVersion} is ahead of ${state.room.version}`);
  }
}

describe("meeting invariants under random inputs", () => {
  it(`hold after every input of ${RUNS} runs`, () => {
    let failure: string | null = null;
    for (let seed = 1; seed <= RUNS && failure === null; seed += 1) {
      const run = new Run(random(seed));
      try {
        for (let i = 0; i < STEPS; i += 1) {
          const before = run.state;
          const { inputs, check } = run.move();
          run.lastReply = run.apply(inputs).reply;
          check?.(before);
          checkState(run);
        }
      } catch (error) {
        // The seed replays the run; the tail shows what led up to the break.
        failure = `seed ${seed}: ${(error as Error).message}\n  …\n  ${run.log.slice(-8).join("\n  ")}`;
      }
    }
    expect(failure).toBeNull();
  });
});
