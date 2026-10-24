import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import { runAccountCleanup } from "@/modules/identity/server/account-deletion.server";
import { indexMeetingContacts } from "@/modules/contacts/server/contact-index";
import { summarizeEndedMeeting, summarizeMeeting } from "@/modules/transcripts/server/summary-jobs";
import { captureMeetingWhiteboards } from "@/modules/whiteboards/server/meeting/capture";
import { runWhiteboardRestore } from "@/modules/whiteboards/server/restores";
import { purgeWhiteboardRoom, runWhiteboardPurge } from "@/modules/whiteboards/server/purge.server";
import type { Job, JobStep } from "@/platform/jobs/jobs";
import { deleteAccount } from "@/workflows/account-deletion/pipeline.server";
import { purgeSpace } from "@/workflows/space-deletion/cleanup.server";

/** Where each kind of job lives. What a job resolves is its Workflow's output. */
export async function runJob(step: JobStep, env: Env, job: Job): Promise<unknown> {
  const db = createDb(env.DB);
  switch (job.kind) {
    case "captureMeetingWhiteboards":
      return captureMeetingWhiteboards(step, db, env, job.meetingId, { reopenFailed: job.attempt > 0 });
    case "indexMeetingContacts":
      return indexMeetingContacts(step, db, job.meetingId);
    case "summarizeEndedMeeting":
      return summarizeEndedMeeting(step, db, env, job.meetingId);
    case "summarizeMeeting":
      return summarizeMeeting(step, db, env, job);
    case "restoreWhiteboard":
      return runWhiteboardRestore(step, db, env, job);
    case "purgeWhiteboard":
      return runWhiteboardPurge(step, db, env, job);
    case "purgeSpace":
      return purgeSpace(step, db, env, job);
    case "deleteAccount":
      return deleteAccount(step, db, env, job);
    case "accountCleanup":
      return runAccountCleanup(step, db, env, job, (whiteboardId) => purgeWhiteboardRoom(env, whiteboardId));
  }
}
