/**
 * The live state of one meeting, owned by its coordinator.
 *
 * Every record here only moves forward. An attempt goes issued → joined →
 * ended and is never reissued; the meeting goes provisional → live → ended →
 * drained. Facts that a destructive decision reads (`firstJoinedAt`, an
 * attempt's `joinedAt`) are written once. Held and stored by the meeting's
 * MeetingRoom Durable Object (./room.server.ts), its only writer.
 */

import type { MeetingRole } from "@/modules/meetings/contract/constants";
import type { SurfaceFocus } from "@/modules/meetings/contract/live-state";
import type { MeetingEndReason } from "@orbmeet/domain-model";
import {
  PARTICIPANT_ATTRIBUTE,
  formatRaisedHand,
  type MeetingRoomState,
} from "@/modules/meetings/contract/live-state";

// ─── Timing ──────────────────────────────────────────────────────────────────

/**
 * How long an issued attempt's token may take to reach the room. An attempt the
 * room still does not show once this has passed is looked for; a look at the
 * room requested after it that does not find the attempt ends it as unused.
 */
export const ISSUE_GRACE_MS = 60_000;
/** A joined attempt missing from the room this long has left. */
export const ABSENT_GRACE_MS = 30_000;
/** A waiter nobody decides on is turned away after this. */
export const ADMISSION_PENDING_TTL_MS = 5 * 60_000;
/** An open meeting with nobody present or on the way ends after this. */
export const EMPTY_MEETING_GRACE_MS = 2 * 60_000;
/** How often the room is compared with the attempts while anyone is in it. */
export const PRESENCE_CHECK_MS = 60_000;
/**
 * How often the Space authority of every seated user is re-read from D1.
 * Changes are pushed to the room as they happen (./revoke.server.ts); this
 * catches a push that failed.
 */
export const AUTHORITY_CHECK_MS = 60_000;
/** Poll interval while something is converging (an egress starting, a check due). */
export const CONVERGING_TICK_MS = 2_000;
/** An egress that is not active this long after its start is given up. */
export const EGRESS_START_TIMEOUT_MS = 30_000;
/** A start whose result never came back is looked up in the room after this. */
export const EGRESS_START_RESULT_TIMEOUT_MS = 20_000;
/**
 * A media node that has failed every look at the meeting's room this long is
 * let go: its attempts and egress end there, with nothing left to remove, so
 * the meeting can empty and end (or, once ended, drain) without it.
 */
export const MEDIA_NODE_UNREACHABLE_GRACE_MS = 5 * 60_000;
/**
 * How long an ended meeting holds its removals for the room metadata that
 * says it ended. A participant removed first would take the removal for a
 * kick and ask to join again; past this the removals go anyway.
 */
export const END_NOTICE_GRACE_MS = 5_000;
/** An attempt that ended and left the room is forgotten after this; D1 keeps its row. */
export const SETTLED_ATTEMPT_RETENTION_MS = 10 * 60_000;
/** How many forgotten attempts are still recognized, so a late request gets a graceful answer. */
export const PRUNED_ATTEMPT_MEMORY = 500;
/** How many barred users, and barred guest networks, a meeting remembers; the oldest go first. */
export const BARRED_MEMORY = 1_000;
/** Retry backoff for a failed effect: base, doubled per failure, capped. */
export const EFFECT_RETRY_BASE_MS = 2_000;
export const EFFECT_RETRY_MAX_MS = 60_000;
/**
 * A pin copies the board as it is when the sync server runs it, so it must run
 * close to the boundary it stands for: one started later could copy edits made
 * after the meeting stopped sharing the board. The sync server refuses to start
 * a pin past this window (a pin that already landed still reports its copy),
 * and the capture then keeps the board's previous pin. This bounds, rather than
 * removes, how much post-boundary editing a pin can include.
 */
export const WHITEBOARD_PIN_START_WINDOW_MS = 60_000;

/**
 * Through an outage the room keeps asking for a pin's outcome for this long,
 * then gives it up: the capture keeps the board's previous pin, or records
 * that nothing was shared.
 */
export const WHITEBOARD_PIN_GIVE_UP_MS = 24 * 60 * 60_000;

// ─── State ───────────────────────────────────────────────────────────────────

type MeetingPhase = "provisional" | "live" | "ended" | "drained";
export type JoinPolicy = "open" | "approval_required" | "closed";
type AdmissionStatus = "pending" | "approved" | "denied" | "revoked" | "expired";
/**
 * A person's standing in the meeting's Space, as the Worker read it: one of
 * its owner and admins, a member, or a visitor — anyone else, guests
 * included. A personal Space's meeting admits visitors through its link; a
 * shared Space's admits members only, so there a visitor is turned away.
 */
export type SpaceRole = "admin" | "member" | "visitor";
export type EgressMode = "recording" | "streaming";
/** Why a room ends a meeting; see MEETING_END_REASONS, which also keeps recorded history. */
export type EndReason = MeetingEndReason;
/** Why a meeting stopped: an end, or the discard of one nobody ever joined. */
type EndCause = EndReason | "discarded";

interface MeetingMeta {
  meetingId: string;
  /** What the occurrence is called; null shows a date. Renamed only while open, here. */
  title: string | null;
  spaceId: string;
  spaceKind: "personal" | "shared";
  allowGuests: boolean;
  startedByUserId: string | null;
  /** The organizer of the scheduled meeting this one fulfils, if any. */
  organizerUserId: string | null;
  startedAt: number;
  joinPolicy: JoinPolicy;
  maxParticipants: number | null;
  recordingEnabled: boolean;
  /**
   * Whether speech is transcribed: each participant's audio sent to Deepgram
   * for captions, the transcript and the summary. Off means none is sent.
   */
  transcription: boolean;
  maxDurationMs: number | null;
  phase: MeetingPhase;
  firstJoinedAt: number | null;
  endedAt: number | null;
  endReason: EndCause | null;
  nodeId: string | null;
  /**
   * Bumped every time the meeting is placed on a node, so a result from a
   * placement it has left (even a return to the same node) is recognized.
   */
  placement: number;
}

/** The placement an effect on the media node was planned for. */
export interface Placement {
  nodeId: string;
  generation: number;
}

export interface Admission {
  id: string;
  userId: string | null;
  guestSecretHash: string | null;
  displayName: string;
  status: AdmissionStatus;
  decidedByUserId: string | null;
  decidedAt: number | null;
  decisionReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Meeting-local grant; cleared whenever the admission leaves `approved`. */
  moderator: boolean;
  /** Current Space standing, read from D1 by the Worker. */
  spaceRole: SpaceRole;
  /**
   * When `spaceRole` last changed: no earlier than the read that changed it.
   * A read requested before then is not applied over it.
   */
  spaceRoleAt: number;
  screenShare: "none" | "requested" | "granted";
  /**
   * A host or moderator let this attendee edit the meeting's boards. Like the
   * moderator grant it is meeting-local, and cleared whenever the admission
   * leaves `approved` or rises above attendee.
   */
  boardEdit: boolean;
  /**
   * An attendee asked for the board to open for everyone. A moderator opens
   * it (which answers every ask) or declines this one.
   */
  boardRequested: boolean;
  /**
   * An attendee asked for transcription to stop. A moderator turns it off
   * (which answers every ask) or declines this one.
   */
  transcriptionStopRequested: boolean;
  hand: { raiseId: string; raisedAt: number } | null;
  /**
   * A guest's network, as the Worker keyed it (../access/guest-network.server.ts):
   * what removing them bars. Null for a user, or when the address was unknown.
   */
  networkKey: string | null;
  /**
   * {@link whiteboardAuthorityHash} as the presented whiteboard's sync room
   * last re-read it. A change is planned as `whiteboard.authority`, so no
   * command has to remember to tell the room.
   */
  whiteboardAuthority: string;
}

export type { SurfaceFocus };

/** A presented whiteboard's shared state, owed a pin by the sync server. */
interface WhiteboardPin extends SurfaceFocus {
  /** Idempotency key for the sync server's checkpoint and the capture's R2 key. */
  commandId: string;
  owedAt: number;
}

/**
 * The shared whiteboard surface. One record, so whether it is open and which
 * board it shows can never disagree; `revision` versions both.
 */
interface SurfaceState {
  open: boolean;
  /** The board the meeting presents; kept while closed, so reopening restores it. */
  focus: SurfaceFocus | null;
  /** Bumped by every open, close and board switch. */
  revision: number;
  /**
   * The revision at which the surface was last opened for everyone. A
   * participant who hid it for themselves stays hidden until it changes.
   */
  openRevision: number;
  /**
   * Shared state owed a pin, keyed by usage: leaving a board or closing the
   * surface pins what everyone saw. A later boundary of the same board
   * replaces an earlier one, since the pin captures the room as it is.
   */
  pins: Record<string, WhiteboardPin>;
  /** The ended meeting's whiteboard capture job has been started. */
  captureStarted: boolean;
}

export interface Attempt {
  id: string;
  /** Unique per attempt, so removing it never touches another attempt. */
  identity: string;
  admissionId: string;
  clientAttemptId: string;
  nodeId: string;
  issuedAt: number;
  joinedAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  sid: string | null;
  /**
   * When LiveKit says the session `sid` joined the room, if it said. A report
   * of an earlier session (a listing taken before a reconnect) is not taken
   * for the current one.
   */
  sessionJoinedAt: number | null;
  /**
   * Since when, on this coordinator's clock, the room is known to hold `sid`:
   * the request time of the listing that reported it, or when its webhook
   * arrived. A listing asked for earlier cannot replace it.
   */
  sidKnownSince: number | null;
  /** Set while a joined attempt is missing from the room. */
  absentSince: number | null;
  captionLanguage: string;
  /** Hash of the attributes and permission LiveKit last accepted for it. */
  appliedGrant: string;
  /** Hash of the grant its join token carries, which LiveKit falls back to on a full reconnect. */
  tokenGrant: string;
  /**
   * Whether the attempt is known to be out of the room. Set only by what
   * shows it: a removal or room deletion that succeeded, a presence check
   * that no longer finds it, a node given up, or never having joined.
   */
  removed: boolean;
}

/** What is remembered of a forgotten attempt: whose it was, and how it ended. */
interface PrunedAttempt {
  admissionId: string;
  endReason: string | null;
}

export interface EgressState {
  desired: EgressMode | null;
  /** RTMP target, held only while streaming is desired. */
  target: string | null;
  /**
   * The provider start in flight: its id, when it began, and what it asked
   * for, so a result that arrives after the host changed their mind is not
   * taken for what they want now.
   */
  op: { id: string; kind: "start"; startedAt: number; mode: EgressMode; target: string | null } | null;
  egressId: string | null;
  mode: EgressMode | null;
  status: "starting" | "active" | "stopping" | null;
  startedAt: number | null;
  /** Source of operation ids; ids never repeat within a meeting. */
  opSeq: number;
  lastPolledAt: number | null;
  /**
   * Egresses in the room this meeting does not track: left by a lost start
   * result or an earlier failure. Each is stopped until a stop lands.
   */
  strays: string[];
  /** Monotonic; carried in room metadata and projected to D1. */
  revision: number;
  transition: "started" | "stopped" | "failed" | "sync";
  lastFailure: string | null;
}

interface RetryState {
  failures: number;
  retryAt: number;
}

export interface MeetingState {
  meta: MeetingMeta;
  admissions: Record<string, Admission>;
  attempts: Record<string, Attempt>;
  /**
   * Attempts forgotten by pruning, oldest first. A retried or delayed request
   * for one still gets the answer an ended attempt gives, not "unknown
   * participant"; one that was superseded stays refused. Bounded, like the
   * rest of state.
   */
  prunedAttempts: Record<string, PrunedAttempt>;
  egress: EgressState;
  surface: SurfaceState;
  countdown: { endsAt: number | null; version: number };
  /** Bumped when the pending-admission list changes; moderators refetch on it. */
  admissionsVersion: number;
  /**
   * Who a moderator removed, kept out for the rest of the meeting: users by
   * id, guests by the network they joined from.
   */
  barred: { userIds: string[]; guestNetworks: string[] };
  room: {
    /** Room metadata content version; `appliedVersion` is what LiveKit holds. */
    version: number;
    appliedVersion: number;
    /**
     * Counts the LiveKit rooms the meeting has had: bumped whenever the room
     * is known to be gone or new. A metadata write acknowledged for an earlier
     * room says nothing about what the current one holds.
     */
    instance: number;
    lastPresenceCheckAt: number | null;
    /**
     * When seated users' Space authority was last re-read from D1; null for
     * never.
     */
    lastAuthorityCheckAt: number | null;
    /**
     * Since when nobody has been present, on the way in, or waiting; null
     * while someone is. Set once per empty spell, so a request that finds the
     * room as it was changes nothing and writes nothing.
     */
    emptySince: number | null;
    deleted: boolean;
    /**
     * Identities in the room that no live attempt accounts for (a replayed
     * webhook, a revoked admission's late join). Each is removed until a
     * removal lands or the room is deleted.
     */
    strays: string[];
    /**
     * Since when every look at the room (listing its participants or
     * egresses, deleting it) has failed; null once one succeeds.
     */
    unreachableSince: number | null;
  };
  finalized: boolean;
  postMeetingDone: boolean;
  retries: Record<string, RetryState>;
}

export interface MeetingSnapshot {
  meetingId: string;
  title: string | null;
  spaceId: string;
  spaceKind: "personal" | "shared";
  allowGuests: boolean;
  startedByUserId: string | null;
  organizerUserId: string | null;
  startedAt: number;
  joinPolicy: JoinPolicy;
  maxParticipants: number | null;
  recordingEnabled: boolean;
  transcription: boolean;
  maxDurationMs: number | null;
  nodeId: string | null;
  /**
   * From D1. Only a room whose stored state was lost starts on a meeting
   * someone already joined; it must then end that meeting, not discard it.
   */
  firstJoinedAt: number | null;
}

/**
 * `now` starts the room metadata version: participants ignore a version older
 * than one they have seen, so a room whose state was lost and recreated must
 * not count up from zero again.
 */
export function initialState(snapshot: MeetingSnapshot, now: number): MeetingState {
  return {
    meta: {
      ...snapshot,
      phase: snapshot.firstJoinedAt === null ? "provisional" : "live",
      placement: 0,
      endedAt: null,
      endReason: null,
    },
    admissions: {},
    attempts: {},
    prunedAttempts: {},
    egress: {
      desired: null,
      target: null,
      op: null,
      egressId: null,
      mode: null,
      status: null,
      startedAt: null,
      opSeq: 0,
      lastPolledAt: null,
      strays: [],
      revision: 0,
      transition: "sync",
      lastFailure: null,
    },
    surface: { open: false, focus: null, revision: 0, openRevision: 0, pins: {}, captureStarted: false },
    countdown: { endsAt: null, version: 0 },
    admissionsVersion: 0,
    barred: { userIds: [], guestNetworks: [] },
    room: {
      version: now,
      appliedVersion: 0,
      instance: 0,
      lastPresenceCheckAt: null,
      lastAuthorityCheckAt: null,
      // Set by the first step: the empty spell starts when the room is first
      // reached, however long after its row was created that is.
      emptySince: null,
      deleted: false,
      strays: [],
      unreachableSince: null,
    },
    finalized: false,
    postMeetingDone: false,
    retries: {},
  };
}

/**
 * Brings a state stored by an earlier version up to this one. Each field
 * added since takes the value that describes what the meeting was already
 * doing: every meeting transcribed before the switch existed.
 */
export function upgradeState(state: MeetingState): MeetingState {
  state.meta.transcription ??= true;
  for (const admission of Object.values(state.admissions)) {
    admission.transcriptionStopRequested ??= false;
    // Edit grants lived in D1 before; a meeting open across that change
    // starts without them, and a moderator grants again.
    admission.boardEdit ??= false;
    // Space standing was named for what it once implied: `manager` for the
    // owner and admins, `none` for everyone else.
    const legacy: string = admission.spaceRole;
    if (legacy === "manager") admission.spaceRole = "admin";
    if (legacy === "none") admission.spaceRole = "visitor";
  }
  // The room took over the title in a release deployed while no meeting was
  // open, so state without one belongs to a meeting that had already ended,
  // and an ended meeting is never renamed.
  state.meta.title ??= null;
  state.meta.organizerUserId ??= null;
  return state;
}

// ─── Derived rules ───────────────────────────────────────────────────────────

export function isOpen(state: MeetingState): boolean {
  return state.meta.phase === "provisional" || state.meta.phase === "live";
}

/** One of the Space's owner and admins: a host wherever they are. */
function isSpaceAdmin(admission: Admission): boolean {
  return admission.userId !== null && admission.spaceRole === "admin";
}

/**
 * Who stands in as host, counting `arriving` as seated: nobody while one of
 * the Space's owner or admins is in the meeting; otherwise the organizer of
 * the scheduled meeting it fulfils if they are in it, else whoever started it
 * if they are. Only a member stands in — never a visitor or a guest.
 *
 * Being in the meeting is holding a seat, which lasts until its attempt ends;
 * a connection that vanishes ends only after `ABSENT_GRACE_MS`, so a network
 * blip moves nothing.
 */
function standInUserId(state: MeetingState, arriving?: Admission): string | null {
  const seatedIds = seatedAdmissionIds(state);
  const inMeeting = (admission: Admission) =>
    admission === arriving || (admission.status === "approved" && seatedIds.has(admission.id));
  const admissions = arriving ? [...Object.values(state.admissions), arriving] : Object.values(state.admissions);
  if (admissions.some((admission) => isSpaceAdmin(admission) && inMeeting(admission))) return null;
  for (const userId of [state.meta.organizerUserId, state.meta.startedByUserId]) {
    if (
      userId !== null &&
      admissions.some((admission) => admission.userId === userId && admission.spaceRole === "member" && inMeeting(admission))
    ) {
      return userId;
    }
  }
  return null;
}

function roleWith(state: MeetingState, admission: Admission, arriving: boolean): MeetingRole {
  if (isSpaceAdmin(admission)) return "host";
  const { organizerUserId, startedByUserId } = state.meta;
  if (
    admission.userId !== null &&
    (admission.userId === organizerUserId || admission.userId === startedByUserId) &&
    (arriving || (admission.status === "approved" && holdsSeat(state, admission.id))) &&
    standInUserId(state, arriving ? admission : undefined) === admission.userId
  ) {
    return "host";
  }
  if (admission.moderator) return "moderator";
  return "attendee";
}

/**
 * The only definition of meeting authority. The Space's owner and admins are
 * hosts. The stand-in (see {@link standInUserId}) hosts while in the meeting.
 * Then the moderator grant; everyone else attends.
 */
export function roleOf(state: MeetingState, admission: Admission): MeetingRole {
  return roleWith(state, admission, false);
}

/**
 * The role `admission` takes once it is in the meeting: what every door asks,
 * so the person who will host is let in as a host — past approval, a closed
 * meeting and the seat kept free for an admin.
 */
export function roleOnArrival(state: MeetingState, admission: Admission): MeetingRole {
  return roleWith(state, admission, true);
}

export function canModerate(state: MeetingState, admission: Admission): boolean {
  return admission.status === "approved" && roleOf(state, admission) !== "attendee";
}

export function canManage(state: MeetingState, admission: Admission): boolean {
  return admission.status === "approved" && roleOf(state, admission) === "host";
}

/**
 * An attempt holds its admission's seat until it ends. One whose token never
 * reached the room ends once a look at the room shows it is not there.
 */
export function holdsSeat(state: MeetingState, admissionId: string): boolean {
  return Object.values(state.attempts).some(
    (attempt) => attempt.admissionId === admissionId && attempt.endedAt === null,
  );
}

function seatedAdmissionIds(state: MeetingState): Set<string> {
  return new Set(
    Object.values(state.attempts)
      .filter((attempt) => attempt.endedAt === null)
      .map((attempt) => attempt.admissionId),
  );
}

/** The meeting's current placement, or null before it has one. */
export function placementOf(state: MeetingState): Placement | null {
  const { nodeId, placement } = state.meta;
  return nodeId === null ? null : { nodeId, generation: placement };
}

/** Whether a result came from the placement the meeting is on now. */
export function isCurrentPlacement(state: MeetingState, placement: Placement): boolean {
  const current = placementOf(state);
  return current !== null && current.nodeId === placement.nodeId && current.generation === placement.generation;
}

/**
 * Whether one more admission may take a seat. Every participant takes one.
 * While none of the Space's owner and admins is in the meeting, a joiner who
 * will not host leaves one free, so a room of attendees never locks an admin
 * out; whoever arrives to host may take it.
 */
export function seatAvailable(state: MeetingState, joining: Admission): boolean {
  const limit = state.meta.maxParticipants;
  if (limit === null) return true;
  const seated = seatedAdmissionIds(state);
  seated.delete(joining.id);
  const adminSeated = [...seated].some((id) => {
    const admission = state.admissions[id];
    return admission ? isSpaceAdmin(admission) : false;
  });
  const reserve = !adminSeated && roleOnArrival(state, joining) !== "host" ? 1 : 0;
  return seated.size < limit - reserve;
}

/** Attributes the server owns on a participant, and the permission that goes with them. */
export interface ParticipantGrant {
  attributes: Record<string, string>;
  role: MeetingRole;
  canScreenShare: boolean;
}

/**
 * What an admission may do, and what others see of it. A hand, an ask or a
 * grant belongs to an attendee; above attendee the role covers each, so they
 * are hidden, not cleared — a stand-in who hands back finds them as they were.
 */
export function grantFor(state: MeetingState, admission: Admission): ParticipantGrant {
  const role = roleOf(state, admission);
  return {
    role,
    canScreenShare: role !== "attendee" || admission.screenShare === "granted",
    attributes: {
      [PARTICIPANT_ATTRIBUTE.participant]: admission.id,
      [PARTICIPANT_ATTRIBUTE.role]: role,
      [PARTICIPANT_ATTRIBUTE.hand]: role === "attendee" ? formatRaisedHand(admission.hand) : "",
      [PARTICIPANT_ATTRIBUTE.screenShare]:
        role === "attendee" && admission.screenShare !== "none" ? admission.screenShare : "",
      [PARTICIPANT_ATTRIBUTE.board]: role === "attendee" && admission.boardRequested ? "requested" : "",
      [PARTICIPANT_ATTRIBUTE.transcriptionStop]:
        role === "attendee" && admission.transcriptionStopRequested ? "requested" : "",
    },
  };
}

export function grantHash(grant: ParticipantGrant): string {
  return JSON.stringify([grant.role, grant.canScreenShare, grant.attributes]);
}

/**
 * What a whiteboard sync room reads about an admission from D1: whether it is
 * still admitted, the role its capabilities come from, and whether it may edit
 * the meeting's boards. Any change is announced to the presented board's room.
 */
export function whiteboardAuthorityHash(state: MeetingState, admission: Admission): string {
  return JSON.stringify([admission.status, roleOf(state, admission), admission.boardEdit]);
}

/** Whether an admission's current authority includes whiteboard management. */
export function managesWhiteboards(state: MeetingState, admission: Admission): boolean {
  return admission.status === "approved" && roleOf(state, admission) !== "attendee";
}

export type RoomMetadata = MeetingRoomState;

export function roomMetadataFor(state: MeetingState): RoomMetadata {
  const egress = state.egress;
  return {
    version: state.room.version,
    ended: !isOpen(state),
    joinPolicy: state.meta.joinPolicy,
    transcription: state.meta.transcription,
    egressMode: egress.status === "active" ? egress.mode : null,
    egressRevision: egress.revision,
    egressTransition: egress.transition,
    countdown: state.countdown,
    admissionsVersion: state.admissionsVersion,
    surface: surfaceViewFor(state),
  };
}

export function surfaceViewFor(state: MeetingState): MeetingRoomState["surface"] {
  const { surface } = state;
  return {
    open: surface.open,
    whiteboardId: surface.focus?.whiteboardId ?? null,
    revision: surface.revision,
    openRevision: surface.openRevision,
  };
}
