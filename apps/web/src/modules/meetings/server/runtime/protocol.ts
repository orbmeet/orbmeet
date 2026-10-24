import type { MeetingRole } from "@/modules/meetings/contract/constants";
import type {
  EgressMode,
  EndReason,
  JoinPolicy,
  MeetingSnapshot,
  ParticipantGrant,
  Placement,
  RoomMetadata,
  SpaceRole,
  SurfaceFocus,
} from "./model";
import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";
import type { WhiteboardGrantPrincipal } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";

/**
 * Who is asking. The Worker authenticates the session; the coordinator reads
 * a user's current Space authority from D1 while it holds the meeting, and
 * verifies a guest's cookie secret against the admission it names, before the
 * core sees the request.
 */
export type Subject =
  | { kind: "user"; userId: string; spaceRole: SpaceRole }
  | { kind: "guest"; admissionId: string | null; verified: boolean }
  | { kind: "system" };

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type Command =
  | {
      kind: "join";
      subject: Subject;
      admissionId: string | null;
      clientAttemptId: string;
      displayName: string;
      captionLanguage: string;
      /**
       * The attempt a removed client lost. A join that would take back a
       * seat another of the participant's tabs or devices took over is
       * refused, so the two do not keep removing each other.
       */
      replacesAttemptId: string | null;
      /** Ids and the guest secret hash for anything this join creates. */
      newAdmissionId: string;
      newAttemptId: string;
      newGuestSecretHash: string | null;
      /** A guest's network key (../access/guest-network.server.ts); null for a user. */
      guestNetworkKey: string | null;
    }
  | { kind: "release"; subject: Subject; attemptId: string }
  | { kind: "leave"; subject: Subject; attemptId: string }
  | { kind: "listPending"; subject: Subject }
  /**
   * Whether `subject` may act as a moderator or manager of this meeting now.
   * Changes nothing; work outside the room asks before it writes.
   */
  | { kind: "authorize"; subject: Subject }
  | { kind: "decideAdmission"; subject: Subject; admissionId: string; approve: boolean }
  | { kind: "setJoinPolicy"; subject: Subject; joinPolicy: JoinPolicy }
  /** Rename the occurrence, if its title is still the one the caller saw. */
  | { kind: "renameMeeting"; subject: Subject; title: string | null; expectedTitle: string | null }
  | { kind: "setModerator"; subject: Subject; identity: string; moderator: boolean }
  /** Take an admitted participant out of the meeting, and keep them out as far as it can. */
  | { kind: "removeParticipant"; subject: Subject; admissionId: string }
  | { kind: "raiseHand"; subject: Subject; attemptId: string; raiseId: string }
  | { kind: "lowerHand"; subject: Subject; attemptId: string }
  | { kind: "resolveHand"; subject: Subject; admissionId: string }
  | { kind: "requestScreenShare"; subject: Subject; attemptId: string }
  | { kind: "decideScreenShare"; subject: Subject; admissionId: string; allow: boolean }
  /** Let an attendee edit the meeting's boards, named as the board server names people. */
  | { kind: "grantBoardEdit"; subject: Subject; principal: WhiteboardGrantPrincipal }
  | { kind: "stopScreenShare"; subject: Subject; attemptId: string }
  /** An attendee asks for the board to open for everyone, or takes the ask back. */
  | { kind: "requestBoard"; subject: Subject; attemptId: string; requested: boolean }
  /** A moderator declines one attendee's ask. Opening the board answers every ask. */
  | { kind: "declineBoardRequest"; subject: Subject; admissionId: string }
  /** A host or co-host turns transcription on or off for everyone. */
  | { kind: "setTranscription"; subject: Subject; on: boolean }
  /** An attendee asks for transcription to stop, or takes the ask back. */
  | { kind: "requestTranscriptionStop"; subject: Subject; attemptId: string; requested: boolean }
  /** A moderator declines one attendee's ask. Turning transcription off answers every ask. */
  | { kind: "declineTranscriptionStop"; subject: Subject; admissionId: string }
  | { kind: "setCountdown"; subject: Subject; endsAt: number | null }
  | {
      kind: "setEgress";
      subject: Subject;
      mode: EgressMode;
      on: boolean;
      /** RTMP destination, already validated by the Worker. */
      target: string | null;
    }
  /**
   * Open the shared whiteboard for everyone, or close it. Opening shows the
   * board the meeting already presents, or `fallback` (a whiteboard the
   * Worker made sure of) when it presents none yet.
   */
  | { kind: "setSurface"; subject: Subject; open: boolean; fallback: SurfaceFocus | null }
  /** Present a whiteboard the Worker attached to the meeting, opening the surface. */
  | { kind: "present"; subject: Subject; focus: SurfaceFocus }
  | { kind: "end"; subject: Subject; reason: EndReason }
  /**
   * A user's Space authority as the coordinator read it at `readAt`, on its
   * own clock. Not applied over a role an admission took from a later read.
   */
  | { kind: "authority"; userId: string; spaceRole: SpaceRole; reason: string; readAt: number }
  | { kind: "revoke"; userId: string; reason: string };

export interface ObservedEgress {
  egressId: string;
  status: "starting" | "active" | "ending" | "complete" | "failed";
  /** For streaming: whether an RTMP output is live, or why it failed. */
  streamActive: boolean;
  streamFailure: string | null;
  error: string | null;
}

export interface ObservedParticipant {
  identity: string;
  sid: string;
  /** When LiveKit says this session joined (`joinedAtMs`), or null when it did not say. */
  joinedAt: number | null;
  /** Only standard participants are ours; agents and recorders are left alone. */
  standard: boolean;
}

export type Observation =
  | { kind: "participantJoined"; identity: string; sid: string | null; joinedAt: number | null; at: number }
  | { kind: "participantLeft"; identity: string; sid: string | null; at: number }
  | { kind: "roomStarted" }
  | { kind: "roomFinished" }
  /**
   * `placement` is the placement a listing was taken on; a webhook carries
   * none, since the Worker already checked the node it came from.
   */
  | { kind: "egressObserved"; egresses: ObservedEgress[]; complete: boolean; placement?: Placement };

/**
 * Results of effects on the media node carry the placement the effect was
 * planned for: one from a placement the meeting has since left says nothing
 * about the room it is in now, and is ignored.
 */
export type EffectResult =
  /** Placement chose `nodeId` for a meeting it saw on `from`. */
  | { kind: "placed"; nodeId: string; from: string | null }
  | { kind: "grantApplied"; placement: Placement; attemptId: string; sid: string | null; hash: string }
  | { kind: "removed"; placement: Placement; identity: string }
  /** The room as a listing requested at `requestedAt` saw it. */
  | {
      kind: "participantsListed";
      placement: Placement;
      requestedAt: number;
      participants: ObservedParticipant[];
      roomExists: boolean;
    }
  /** `room`: the instance of the LiveKit room the write was planned for. */
  | { kind: "metadataApplied"; placement: Placement; room: number; version: number }
  /** The Space authority of the users an `authority` check named, as read no earlier than `requestedAt`. */
  | { kind: "authorityChecked"; requestedAt: number; roles: Array<{ userId: string; spaceRole: SpaceRole }> }
  | { kind: "egressStartResult"; placement: Placement; opId: string; egressId: string | null; error: string | null }
  | { kind: "egressStopped"; placement: Placement; egressId: string; missing: boolean }
  | { kind: "roomDeleted"; placement: Placement }
  | { kind: "finalized" }
  | { kind: "postTasksDone" }
  | { kind: "whiteboardPinned"; usageId: string; commandId: string }
  | { kind: "whiteboardAuthorityApplied"; admissionId: string; hash: string }
  | { kind: "whiteboardCaptureStarted" }
  | { kind: "drained" }
  /** `placement`: the placement a failed effect on the media node was planned for. */
  | { kind: "effectFailed"; key: string; error: string; placement?: Placement };

/**
 * What running one effect produced, under the key it ran as: its result, or
 * for an egress listing the observation it made. A success ends that key's
 * retry backoff whatever the result says.
 */
export interface EffectSucceeded {
  kind: "effectSucceeded";
  key: string;
  result: Exclude<EffectResult, { kind: "effectFailed" }> | Observation;
}

export type Input =
  | { kind: "init"; snapshot: MeetingSnapshot }
  | Command
  | Observation
  | EffectResult
  | EffectSucceeded
  | { kind: "tick" };

// ─── Replies ─────────────────────────────────────────────────────────────────

export interface ParticipantView {
  meetingId: string;
  meetingStartedAt: number;
  attemptId: string;
  identity: string;
  admissionId: string;
  displayName: string;
  userId: string | null;
  role: MeetingRole;
  canModerate: boolean;
  canManageMeeting: boolean;
  joinPolicy: JoinPolicy;
  nodeId: string;
  captionLanguage: string;
  grant: ParticipantGrant;
  room: RoomMetadata;
  recordingEnabled: boolean;
  egress: EgressView;
}

export interface EgressView {
  recordingActive: boolean;
  streamingActive: boolean;
  /** Only for moderators. */
  egressId: string | null;
  mode: EgressMode | null;
  status: "starting" | "active" | "stopping" | null;
  revision: number;
  lastFailure: string | null;
}

export type Reply =
  | { kind: "admitted"; participant: ParticipantView; newGuestAdmission: boolean }
  | { kind: "waiting"; admissionId: string; newGuestAdmission: boolean }
  | {
      kind: "pending";
      joinPolicy: JoinPolicy;
      pending: Array<{ id: string; displayName: string; userId: string | null; createdAt: number }>;
    }
  | { kind: "egress"; egress: EgressView }
  | { kind: "surface"; surface: MeetingSurfaceState }
  | { kind: "role"; role: MeetingRole }
  | { kind: "joinPolicy"; joinPolicy: JoinPolicy }
  | { kind: "title"; title: string | null }
  | { kind: "transcription"; on: boolean }
  | { kind: "left"; found: boolean }
  /**
   * Who a removal keeps out: their account, the network a guest joined from,
   * or nobody (a guest whose network was unknown can come back as a new guest).
   */
  | { kind: "removed"; keptOut: KeptOut }
  | { kind: "ok" };

export type KeptOut = "account" | "network" | "none";

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * Work outside the coordinator's storage. Every effect but `livekit.startEgress`
 * is idempotent and derived from state by `plan`, so one lost to a crash is
 * simply planned again. A start is the only provider call that must not
 * repeat: it is issued once, in the commit that stores its operation id, and
 * a lost result is recovered by listing the room's egresses.
 */
export type Effect =
  | {
      key: `grant:${string}`;
      kind: "livekit.grant";
      placement: Placement;
      attemptId: string;
      /** The LiveKit session the grant is for. */
      sid: string | null;
      identity: string;
      grant: ParticipantGrant;
      hash: string;
    }
  | { key: `remove:${string}`; kind: "livekit.remove"; placement: Placement; identity: string }
  /** `requestedAt`: when the look was asked for; what it sees is no older. */
  | { key: "presence"; kind: "livekit.listParticipants"; placement: Placement; requestedAt: number }
  /** Re-read the Space authority of these seated users from D1, no earlier than `requestedAt`. */
  | { key: "authority"; kind: "space.authority"; userIds: string[]; requestedAt: number }
  | {
      key: "metadata";
      kind: "livekit.roomMetadata";
      placement: Placement;
      /** The LiveKit room instance it writes to; its result is ignored once the room was recreated. */
      room: number;
      version: number;
      metadata: RoomMetadata;
    }
  | {
      key: "egress.start";
      kind: "livekit.startEgress";
      placement: Placement;
      opId: string;
      mode: EgressMode;
      target: string | null;
    }
  | { key: "egress.list"; kind: "livekit.listEgress"; placement: Placement }
  | { key: `egress.stop:${string}`; kind: "livekit.stopEgress"; placement: Placement; egressId: string }
  | { key: "room.delete"; kind: "livekit.deleteRoom"; placement: Placement }
  | { key: "finalize"; kind: "meeting.finalize"; reason: EndReason }
  | { key: "post"; kind: "meeting.postTasks" }
  /** Checkpoint a presented board and pin that state as what the meeting shared. */
  | {
      key: `whiteboard.pin:${string}`;
      kind: "whiteboard.pin";
      meetingId: string;
      pin: WhiteboardPinEffect;
    }
  /** Have the presented board's sync room re-read an admission's authority. */
  | {
      key: `whiteboard.authority:${string}`;
      kind: "whiteboard.authority";
      admissionId: string;
      syncRoomId: string;
      principalKey: string;
      /** The admission lost whiteboard management: suspend its writes until re-read. */
      narrowed: boolean;
      hash: string;
    }
  /** Start the ended meeting's whiteboard capture job, once every pin settled. */
  | { key: "whiteboard.capture"; kind: "whiteboard.capture" }
  | { key: "discard"; kind: "meeting.discard" }
  | { key: "drain"; kind: "meeting.drain" };

interface WhiteboardPinEffect {
  usageId: string;
  whiteboardId: string;
  syncRoomId: string;
  commandId: string;
  /** Epoch ms after which the sync server must not start the pin. */
  startBefore: number;
}

export type EgressStartEffect = Extract<Effect, { kind: "livekit.startEgress" }>;

export interface Outcome {
  reply?: Reply;
  /** The egress start this input issued: the one effect never planned again. */
  once: EgressStartEffect[];
}
