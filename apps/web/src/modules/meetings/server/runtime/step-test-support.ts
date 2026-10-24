// Shared construction for the meeting core's step tests.
import { AppError } from "@/lib/app-errors";
import {
  placementOf,
  type Placement,
  type MeetingSnapshot,
  type MeetingState,
} from "./model";
import { plan } from "./plan";
import type { Effect, Input, ObservedParticipant, Outcome, Subject } from "./protocol";
import { applyInputs, step } from "./step";

export const T0 = 1_800_000_000_000;

export const snapshot: MeetingSnapshot = {
  meetingId: "meeting_1",
  title: null,
  spaceId: "space_1",
  spaceKind: "personal",
  allowGuests: true,
  startedByUserId: "host",
  organizerUserId: null,
  startedAt: T0,
  joinPolicy: "open",
  transcription: true,
  maxParticipants: null,
  recordingEnabled: true,
  maxDurationMs: null,
  nodeId: "node-a",
  firstJoinedAt: null,
};

export const host: Subject = { kind: "user", userId: "host", spaceRole: "admin" };
export const ada: Subject = { kind: "user", userId: "ada", spaceRole: "visitor" };
export const bob: Subject = { kind: "user", userId: "bob", spaceRole: "visitor" };

/** Applies inputs through `applyInputs`, exactly as the room commits them. */
export class Meeting {
  state: MeetingState;
  now = T0;
  private seq = 0;

  constructor(overrides: Partial<MeetingSnapshot> = {}) {
    this.state = step(null, { kind: "init", snapshot: { ...snapshot, ...overrides } }, T0).state;
  }

  apply(input: Input): Outcome {
    const applied = applyInputs(this.state, [input], this.now);
    this.state = applied.state;
    if (applied.refusal !== undefined) throw applied.refusal;
    return { reply: applied.reply, once: applied.once };
  }

  refuse(input: Input): AppError {
    // A refusal keeps nothing it did: the state is what time alone makes it.
    const ticked = applyInputs(this.state, [{ kind: "tick" }], this.now).state;
    try {
      this.apply(input);
    } catch (error) {
      if (JSON.stringify(this.state) !== JSON.stringify(ticked)) throw new Error(`${input.kind} changed state`);
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new Error(`${input.kind} was not refused`);
  }

  join(
    subject: Subject,
    options: {
      admissionId?: string;
      clientAttemptId?: string;
      replacesAttemptId?: string;
      guestSecretHash?: string;
      guestNetworkKey?: string;
    } = {},
  ) {
    this.seq += 1;
    const outcome = this.apply({
      kind: "join",
      subject,
      admissionId: options.admissionId ?? null,
      clientAttemptId: options.clientAttemptId ?? `client-${this.seq}`,
      displayName: subject.kind === "user" ? subject.userId : "Guest",
      captionLanguage: "en-US",
      replacesAttemptId: options.replacesAttemptId ?? null,
      newAdmissionId: `admission_${this.seq}`,
      newAttemptId: `connection_${this.seq}`,
      newGuestSecretHash: subject.kind === "guest" ? options.guestSecretHash ?? "hash" : null,
      guestNetworkKey: subject.kind === "guest" ? options.guestNetworkKey ?? null : null,
    });
    return outcome.reply!;
  }

  admitted(subject: Subject, options?: Parameters<Meeting["join"]>[1]) {
    const reply = this.join(subject, options);
    if (reply.kind !== "admitted") throw new Error(`expected admitted, got ${reply.kind}`);
    return reply.participant;
  }

  joined(identity: string) {
    return this.apply({ kind: "participantJoined", identity, sid: `sid-${identity}`, joinedAt: this.now, at: this.now });
  }

  /** A look at the room, requested at `requestedAt` (now by default), landing now. */
  listed(participants: ObservedParticipant[], requestedAt = this.now) {
    return this.apply({
      kind: "effectSucceeded",
      key: "presence",
      result: { kind: "participantsListed", placement: this.here(), requestedAt, participants, roomExists: true },
    });
  }

  /** The placement the meeting is on now, as its effects are planned for. */
  here(): Placement {
    const placement = placementOf(this.state);
    if (!placement) throw new Error("the meeting has no placement");
    return placement;
  }

  advance(ms: number) {
    this.now += ms;
    return this.apply({ kind: "tick" });
  }

  plan(): Effect[] {
    return plan(this.state, this.now);
  }
}

export function kinds(effects: Effect[]) {
  return effects.map((effect) => effect.kind);
}
