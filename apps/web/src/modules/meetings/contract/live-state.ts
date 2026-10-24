/**
 * The meeting state LiveKit shows every participant, written only by the
 * meeting's coordinator (tokens never grant `canUpdateOwnMetadata`). LiveKit
 * stores both and replays them to late joiners and returning participants, so
 * no client ever reconstructs them from messages.
 *
 * - Participant attributes: one participant's role, raised hand,
 *   screen-share request, request to open the board and request to stop
 *   transcription.
 * - Room metadata: recording/streaming, transcription, the countdown, the join
 *   policy, the shared whiteboard surface, and a version moderators refetch
 *   the waiting list on.
 */

import { MEETING_ROLES, type MeetingRole } from "./constants";
import { roomAllowsTranscription } from "@orbmeet/caption-protocol/room-transcription";

export const PARTICIPANT_ATTRIBUTE = {
  /** The participant's admission id: what moderator decisions name. */
  participant: "orbmeet.participant",
  role: "orbmeet.role",
  /** `<raiseId>:<raisedAt ms>`, or empty. */
  hand: "orbmeet.hand",
  /** `requested`, `granted`, or empty. Only attendees carry it. */
  screenShare: "orbmeet.screenshare",
  /** `requested` while an attendee asks for the board to open, else empty. */
  board: "orbmeet.board",
  /** `requested` while an attendee asks for transcription to stop, else empty. */
  transcriptionStop: "orbmeet.transcription_stop",
  captionLanguage: "orbmeet.caption_language",
} as const;

export interface MeetingRoomState {
  /** Grows with every change; an older state is ignored. */
  version: number;
  /**
   * The meeting is over. Written before anyone is removed, so a participant
   * the end removes knows it is the end and does not ask to join again.
   */
  ended: boolean;
  joinPolicy: "open" | "approval_required" | "closed";
  /** Whether speech is being sent to Deepgram for captions, the transcript and the summary. */
  transcription: boolean;
  egressMode: "recording" | "streaming" | null;
  egressRevision: number;
  egressTransition: "started" | "stopped" | "failed" | "sync";
  /** `endsAt` is in the server's clock. */
  countdown: { endsAt: number | null; version: number };
  admissionsVersion: number;
  surface: MeetingSurfaceState;
}

/**
 * The shared whiteboard surface: whether it is open for everyone and which
 * board it presents. `revision` versions both together.
 */
export interface MeetingSurfaceState {
  open: boolean;
  /** The presented whiteboard, kept while closed; null before the first. */
  whiteboardId: string | null;
  revision: number;
  /** The revision it was last opened for everyone at. */
  openRevision: number;
}

/**
 * A whiteboard a meeting presents: its use in this meeting and its sync room.
 * What a request to show a board on the surface names.
 */
export interface SurfaceFocus {
  usageId: string;
  whiteboardId: string;
  syncRoomId: string;
}

export const CLOSED_MEETING_SURFACE: MeetingSurfaceState = {
  open: false,
  whiteboardId: null,
  revision: 0,
  openRevision: 0,
};

export function parseMeetingRoomState(metadata: string | undefined): MeetingRoomState | null {
  if (!metadata) return null;
  try {
    const value = JSON.parse(metadata) as Partial<MeetingRoomState>;
    if (!Number.isSafeInteger(value.version)) return null;
    // Metadata written before the surface joined it reads as closed, and
    // before transcription could be turned off, as on: what the agent reads.
    return {
      ...value,
      ended: value.ended === true,
      transcription: roomAllowsTranscription(metadata),
      surface: parseSurface(value.surface),
    } as MeetingRoomState;
  } catch {
    return null;
  }
}

function parseSurface(value: unknown): MeetingSurfaceState {
  const surface = value as Partial<MeetingSurfaceState> | null | undefined;
  if (
    !surface ||
    typeof surface.open !== "boolean" ||
    !Number.isSafeInteger(surface.revision) ||
    !Number.isSafeInteger(surface.openRevision) ||
    (surface.whiteboardId !== null && typeof surface.whiteboardId !== "string")
  ) {
    return CLOSED_MEETING_SURFACE;
  }
  return {
    open: surface.open,
    whiteboardId: surface.whiteboardId,
    revision: surface.revision as number,
    openRevision: surface.openRevision as number,
  };
}

/** The role the coordinator wrote, or null before LiveKit has shown it. */
export function parseParticipantRole(value: string | undefined): MeetingRole | null {
  return (MEETING_ROLES as readonly string[]).includes(value ?? "") ? value as MeetingRole : null;
}

export interface RaisedHand {
  raiseId: string;
  raisedAt: number;
}

export function formatRaisedHand(hand: RaisedHand | null): string {
  return hand ? `${hand.raiseId}:${hand.raisedAt}` : "";
}

export function parseRaisedHand(value: string | undefined): RaisedHand | null {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  const raisedAt = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isFinite(raisedAt)) return null;
  return { raiseId: value.slice(0, separator), raisedAt };
}

export type ScreenShareRequestState = "requested" | "granted" | null;

export function parseScreenShareState(value: string | undefined): ScreenShareRequestState {
  return value === "requested" || value === "granted" ? value : null;
}

/** Whether a participant's attributes carry a request to open the board. */
export function parseBoardRequest(value: string | undefined): boolean {
  return value === "requested";
}

export function parseTranscriptionStopRequest(value: string | undefined): boolean {
  return value === "requested";
}
