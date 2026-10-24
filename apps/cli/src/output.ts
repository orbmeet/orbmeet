// Shapes the API payloads into the stable, id-free JSON this CLI documents.
// Internal ids and server-only fields stay out unless --raw is used.

import type { ApiAttendee, ApiSchedule, ApiTargets, RetrievedMeeting } from "./api.ts";
import { CLOUD_API_URL } from "./config.ts";

interface PublicAttendee {
  name?: string;
  email: string;
}

type DownloadableArtifact = NonNullable<RetrievedMeeting["recordings"]>[number];

export interface PublicSchedule {
  title: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  state: string;
  space?: string;
  organizer?: string;
  attendeeCount?: number;
  attendees?: PublicAttendee[];
  joinUrl?: string;
  canManage?: boolean;
}

export interface PublicSearchResults {
  query: string;
  requiresConfirmation: boolean;
  candidates: (
    | { type: "person"; name: string; email?: string; meetingCount: number; lastMetAt: string | null }
    | { type: "space"; name: string; memberCount: number }
  )[];
}

interface PublicTranscriptSegment {
  speaker: string;
  text: string;
  language?: string;
  startedAt: string;
}

export interface PublicRetrievedMeeting {
  meeting: {
    id: string;
    title: string | null;
    startedAt: string;
    endedAt: string | null;
    retainUntil: string | null;
    space?: string;
    participants: string[];
  };
  available: RetrievedMeeting["available"];
  summary?: unknown;
  transcript?: PublicTranscriptSegment[] | null;
  transcriptTruncated?: true;
  recordings?: DownloadableArtifact[];
  whiteboardPdf?: DownloadableArtifact | null;
}

function publicAttendee(attendee: ApiAttendee): PublicAttendee {
  return {
    name: attendee.displayName || undefined,
    email: attendee.email,
  };
}

export function publicSchedule(schedule: ApiSchedule): PublicSchedule {
  return {
    title: schedule.title,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    timeZone: schedule.timeZone,
    state: schedule.state,
    space: schedule.spaceName || undefined,
    organizer: schedule.organizerName || undefined,
    attendeeCount: schedule.attendeeCount,
    attendees: schedule.attendees?.map(publicAttendee),
    joinUrl: schedule.code ? `${CLOUD_API_URL}/${schedule.code}` : undefined,
    canManage: schedule.canManage,
  };
}

export function publicSearchResults(data: ApiTargets): PublicSearchResults {
  return {
    query: data.query,
    requiresConfirmation: data.requiresConfirmation,
    candidates: data.candidates.map((candidate) => candidate.type === "contact"
      ? {
          type: "person",
          name: candidate.name,
          email: candidate.email,
          meetingCount: candidate.meetingCount,
          lastMetAt: candidate.lastMetAt,
        }
      : {
          type: "space",
          name: candidate.name,
          memberCount: candidate.memberCount,
        }),
  };
}

export function publicRetrievedMeeting(data: RetrievedMeeting): PublicRetrievedMeeting {
  const result: PublicRetrievedMeeting = {
    meeting: {
      id: data.meeting.id,
      title: data.meeting.title,
      startedAt: data.meeting.startedAt,
      endedAt: data.meeting.endedAt,
      retainUntil: data.meeting.retainUntil,
      space: data.meeting.spaceName || undefined,
      participants: data.meeting.participants,
    },
    available: data.available,
  };
  if (Object.hasOwn(data, "summary")) result.summary = data.summary;
  // `retrieveMeeting` re-types the transcript section, where an absent key
  // arrives as `undefined`; `null` stays an explicit "unavailable".
  if (data.transcript !== undefined) {
    const transcript = data.transcript;
    // retrieveMeeting has already validated every transcript page against the
    // shared contract, so the segments here are trusted.
    result.transcript = transcript
      ? transcript.segments.map((segment) => ({
          speaker: segment.participantName,
          text: segment.text,
          language: segment.language || undefined,
          startedAt: segment.startedAt,
        }))
      : null;
    if (transcript?.truncated) result.transcriptTruncated = true;
  }
  if (data.recordings) {
    result.recordings = data.recordings.map((recording) => ({
      filename: recording.filename,
      mimeType: recording.mimeType,
      size: recording.size,
      createdAt: recording.createdAt,
      downloadUrl: recording.downloadUrl,
    }));
  }
  if (Object.hasOwn(data, "whiteboardPdf")) {
    result.whiteboardPdf = data.whiteboardPdf
      ? {
          filename: data.whiteboardPdf.filename,
          mimeType: data.whiteboardPdf.mimeType,
          size: data.whiteboardPdf.size,
          createdAt: data.whiteboardPdf.createdAt,
          downloadUrl: data.whiteboardPdf.downloadUrl,
        }
      : null;
  }
  return result;
}
