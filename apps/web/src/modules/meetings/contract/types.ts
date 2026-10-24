import type { MeetingRole } from "./constants";

/**
 * Access credentials for the optional collaboration surface, issued alongside
 * the LiveKit access at join/refresh time. The meeting core treats this as an
 * opaque slot; the surface extension (currently the whiteboard) owns its
 * contents and semantics.
 */
export type MeetingSurfaceAccess =
  | {
      availability: "available";
      disabledReason: null;
      /** Authoritative surface visibility at the time join access was issued. */
      surfaceOpen: boolean;
      // Closed surfaces deliberately carry no document credential. Opening
      // the shared surface establishes the Meeting's Whiteboard first, then
      // mints participant-bound access to that document.
      token: string | null;
      /** The sync server of the node holding the board, issued with its token; null without one. */
      url: string | null;
      /** Durable document identity; independent from the Meeting occurrence. */
      documentId: string | null;
      documentTitle: string | null;
    }
  | {
      availability: "unavailable";
      disabledReason: string | null;
      surfaceOpen: false;
      token: null;
      url: null;
      documentId?: null;
      documentTitle?: null;
    };

export type JoinMeetingResult =
  | { state: "joined"; result: JoinResult }
  | {
      state: "waiting";
      reason: "meeting-start" | "approval";
      message: string;
      admissionId?: string;
      meetingId?: string;
    }
  | {
      state: "blocked";
      code: string;
      message: string;
      /** The refusal describes a passing condition; the same request may succeed later. */
      retryable: boolean;
    };

export interface JoinResult {
  token: string;
  serverUrl: string;
  roomName: string;
  meetingId: string;
  meetingStartedAtMs: number;
  serverNowMs: number;
  connectionId: string;
  admissionId: string;
  participantRole: MeetingRole;
  canModerate: boolean;
  canManageMeeting: boolean;
  participantName: string;
  participantIdentity: string;
  meetingTitle: string | null;
  /** The shared Space this meeting belongs to; absent for a personal link. */
  spaceName?: string | null;
  joinPolicy: "open" | "approval_required" | "closed";
  /** Whether speech is being transcribed as this participant joins; room metadata follows it after. */
  transcription?: boolean;
  expiresIn: number;
  surface?: MeetingSurfaceAccess;
  recordingEnabled?: boolean;
  recordingActive?: boolean;
  activeEgressId?: string | null;
  streamingActive?: boolean;
  activeStreamEgressId?: string | null;
  egressStateRevision: number;
}
