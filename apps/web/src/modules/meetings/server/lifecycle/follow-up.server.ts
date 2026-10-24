import "@tanstack/react-start/server-only";
import { startJob } from "@/platform/jobs/jobs";

/**
 * Hand what an ended meeting leaves to do to its jobs: add its co-attendees
 * to the owner's contacts, and owe its Summary. Each is its own job with its
 * own retries, so one that keeps failing holds up none of the others.
 * Starting a job twice starts it once, so the room may call this again after
 * a partial failure.
 */
export async function startMeetingFollowUp(env: Env, meetingId: string): Promise<void> {
  await Promise.all([
    startJob(env, { kind: "indexMeetingContacts", meetingId }),
    startJob(env, { kind: "summarizeEndedMeeting", meetingId }),
  ]);
}

/**
 * Capture the Whiteboards an ended meeting presented. The room starts it once
 * every pin its boundaries owed has landed, so the capture reads them.
 */
export async function startMeetingWhiteboardCapture(env: Env, meetingId: string): Promise<void> {
  await startJob(env, { kind: "captureMeetingWhiteboards", meetingId, attempt: 0 });
}
