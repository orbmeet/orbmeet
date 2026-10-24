/**
 * Durable background jobs, run by one Cloudflare Workflow (`JOBS`).
 *
 * A job is a named sequence of steps. Each step is retried on its own and its
 * result is kept, so a job that is interrupted resumes after its last finished
 * step instead of starting over, and a step never repeats once it succeeded.
 * The Workflow is the queue, the retry schedule and the record of progress;
 * nothing here needs a task table, a lease or a sweep.
 *
 * A job's id is derived from what it is about, so starting the same job twice
 * starts it once — while the first instance is kept: the Workflow forgets a
 * finished instance after its retention period (30 days), and then the id
 * starts a new one.
 */

export type Job =
  /**
   * Pin the Whiteboards an ended meeting presented. Attempt 0 is the end's;
   * a later one is a manager's retry, which first reopens the failed ones.
   */
  | { kind: "captureMeetingWhiteboards"; meetingId: string; attempt: number }
  /** Add an ended meeting's co-attendees to its owner's contacts. */
  | { kind: "indexMeetingContacts"; meetingId: string }
  /** Owe an ended meeting's Summary once its transcript has flushed. */
  | { kind: "summarizeEndedMeeting"; meetingId: string }
  /** Summarize a meeting's transcript for its `seq`th Summary request. */
  | { kind: "summarizeMeeting"; meetingId: string; seq: number; requestedAt: number }
  /** Restore a Whiteboard to a revision and record the state it replaced in History. */
  | {
      kind: "restoreWhiteboard";
      restoreId: string;
      whiteboardId: string;
      sourceR2Key: string;
      restorePointRevisionId: string;
      userId: string;
      startBefore: number;
      requestedAt: number;
    }
  /** A deleted Whiteboard's R2 objects, once its row is seen gone. */
  | { kind: "purgeWhiteboard"; purgeId: string; whiteboardId: string; requestedAt: number }
  /**
   * Erase an account whose deletion gate is closed: cancel its billing, revoke
   * its access, end and archive what it owns, then delete it. `exceptSessionId`
   * is the session driving the deletion, kept so its request can finish.
   */
  | { kind: "deleteAccount"; userId: string; deletionStartedAt: number; exceptSessionId: string | null }
  /** Remove an archived Space and everything in it. */
  | { kind: "purgeSpace"; spaceId: string; requestedAt: number }
  /** R2 objects a deleted account left behind, once its upload URLs have expired. */
  | {
      kind: "accountCleanup";
      userId: string;
      personalSpaceId: string | null;
      meetingIds: string[];
      whiteboardIds: string[];
      requestedAt: number;
    };

function jobId(job: Job): string {
  switch (job.kind) {
    case "indexMeetingContacts":
      return `contacts-${job.meetingId}`;
    case "summarizeEndedMeeting":
      return `summary-after-end-${job.meetingId}`;
    case "captureMeetingWhiteboards":
      return `capture-${job.meetingId}-${job.attempt}`;
    case "summarizeMeeting":
      // The `s` keeps these apart from ids started before requests were numbered.
      return `summary-${job.meetingId}-s${job.seq}`;
    case "restoreWhiteboard":
      return `restore-${job.restoreId}`;
    case "purgeWhiteboard":
      return `whiteboard-purge-${job.purgeId}`;
    case "deleteAccount":
      return `account-deletion-${job.userId}`;
    case "purgeSpace":
      return `space-purge-${job.spaceId}`;
    case "accountCleanup":
      return `account-cleanup-${job.userId}`;
  }
}

/** The retry policy of one step. */
export interface JobStepConfig {
  retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" };
  timeout?: number;
}

/**
 * The longest a step can run before it fails for good: every attempt running
 * to its timeout, with the longest wait the Workflow takes before each retry
 * (exponential unless the config says otherwise, as for a Workflow).
 */
export function jobStepWindowMs({ retries, timeout }: Required<JobStepConfig>): number {
  const { limit, delay, backoff = "exponential" } = retries;
  let waits = 0;
  for (let retry = 1; retry <= limit; retry += 1) {
    waits += backoff === "constant" ? delay : backoff === "linear" ? delay * retry : delay * 2 ** (retry - 1);
  }
  return (limit + 1) * timeout + waits;
}

/**
 * What a job's code sees of its Workflow: a Workflow's `step`, narrowed to
 * what jobs use, so jobs can be run and tested without the Workflow runtime.
 * A step's name must be unique within its job and stable across runs.
 */
export interface JobStep {
  do<T>(name: string, run: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: JobStepConfig, run: () => Promise<T>): Promise<T>;
  /** Wait until `at`; a time already past waits only a moment. */
  sleepUntil(name: string, at: Date | number): Promise<void>;
}

/**
 * Start a job, or do nothing when it has already been started. With
 * `restartFailed`, a job that already ran and failed for good runs again from
 * its first step; that is for jobs whose every step is safe to repeat and
 * whose subject still needs the work. Only a failure to reach the Workflow
 * throws.
 */
export async function startJob(
  env: Pick<Env, "JOBS">,
  job: Job,
  options: { restartFailed?: boolean } = {},
): Promise<void> {
  const id = jobId(job);
  try {
    await env.JOBS.create({ id, params: job });
  } catch (error) {
    // An id that exists is the same job, started before. Anything else is a
    // real failure, and `get` fails for it too.
    let instance: Awaited<ReturnType<Env["JOBS"]["get"]>>;
    try {
      instance = await env.JOBS.get(id);
    } catch {
      throw error;
    }
    if (!options.restartFailed) return;
    const { status } = await instance.status();
    if (status === "errored" || status === "terminated") await instance.restart();
  }
}

const WAIT_POLL_MS = 250;

/**
 * Wait up to `timeoutMs` for a job to finish, for a request that answers with
 * its outcome. Resolves the job's output, or undefined when it is still
 * running; throws when the job failed.
 */
export async function waitForJob(env: Pick<Env, "JOBS">, job: Job, timeoutMs: number): Promise<unknown> {
  const instance = await env.JOBS.get(jobId(job));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, output, error } = await instance.status();
    if (status === "complete") return output;
    if (status === "errored" || status === "terminated") {
      throw new Error(`Job ${jobId(job)} ${status}: ${error?.message ?? "no detail"}`);
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}
