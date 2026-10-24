interface PublisherJob {
  room?: {
    name?: string;
  };
  participant?: {
    identity?: string;
  };
}

export interface PublisherJobTarget {
  meetingId: string;
  /** The LiveKit room the job was dispatched for. */
  roomName: string;
  participantIdentity: string;
}

const LIVEKIT_MEETING_ROOM_PREFIX = "meet-";

/** Resolve publisher-job metadata before the agent connects to the RTC room. */
export function getPublisherJobTarget(job: PublisherJob): PublisherJobTarget | null {
  const participantIdentity = job.participant?.identity?.trim() ?? "";
  const roomName = job.room?.name?.trim() ?? "";
  const meetingId = roomName.startsWith(LIVEKIT_MEETING_ROOM_PREFIX)
    ? roomName.slice(LIVEKIT_MEETING_ROOM_PREFIX.length)
    : "";

  if (!participantIdentity || !meetingId) return null;
  return { meetingId, roomName, participantIdentity };
}
