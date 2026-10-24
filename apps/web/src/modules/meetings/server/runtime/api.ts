import type { NodeLatencies } from "@orbmeet/nodes";
import type { Command, Observation, ParticipantView, Reply, Subject } from "./protocol";

/**
 * The Worker's view of who is asking. A user is named only: the coordinator
 * reads their Space authority itself, in order with everything else the
 * meeting hears, so a role read before a change can never land after it. A
 * guest is named by the admission their cookie belongs to and that cookie's
 * raw secret; the coordinator checks it against the admission's stored hash.
 */
export type SubjectInput =
  | { kind: "user"; userId: string }
  | { kind: "guest"; admissionId: string | null; secret: string | null }
  | { kind: "system" };

type WithSubjectInput<C> = C extends { subject: Subject } ? Omit<C, "subject"> & { subject: SubjectInput } : C;

export type CoordinatorCommand =
  | WithSubjectInput<Exclude<Command, { kind: "join" } | { kind: "authority" }>>
  /** The user's Space authority changed: the coordinator re-reads it. */
  | { kind: "refreshAuthority"; userId: string; reason: string };

export interface JoinRequest {
  subject: SubjectInput;
  admissionId: string | null;
  clientAttemptId: string;
  displayName: string;
  captionLanguage: string;
  unreachableMediaUrl: string | null;
  /**
   * Each node's latency from the Cloudflare data centre the joiner came in
   * through: a Meeting placed by their join goes to a node fast for them.
   */
  nodeLatencies: NodeLatencies;
  replacesAttemptId: string | null;
  newGuestSecretHash: string | null;
  /** The guest's network key; null for a user or an unknown address. */
  guestNetworkKey: string | null;
}

export type CoordinatorRequest =
  /**
   * A join or a command is answered to someone waiting for it. `deadline` (ms
   * since the epoch) is when they stop waiting: a request still queued in the
   * room by then is refused (MEETING_BUSY) without being applied, so a
   * backlog does not grow with work nobody will read the answer to.
   */
  | { kind: "join"; meetingId: string; join: JoinRequest; deadline?: number }
  | { kind: "command"; meetingId: string; command: CoordinatorCommand; deadline?: number }
  | { kind: "observe"; meetingId: string; nodeId: string; observation: Observation }
  /** Let time pass for the meeting, creating its room state from D1 if it has none. */
  | { kind: "wake"; meetingId: string };

export type JoinReply =
  | {
      kind: "admitted";
      participant: ParticipantView;
      token: string;
      expiresIn: number;
      serverUrl: string;
      newGuestAdmission: boolean;
    }
  | { kind: "waiting"; admissionId: string; newGuestAdmission: boolean };

export type CoordinatorReply = JoinReply | Reply;
