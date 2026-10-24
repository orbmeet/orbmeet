import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { logError } from "@/lib/logger";
import { withLogContext } from "@/platform/runtime/log-context";
import type { Job, JobStep } from "@/platform/jobs/jobs";

/**
 * The Workflow every background job runs in (see platform/jobs). It only
 * adapts the runtime; jobs are plain functions of their steps. The registry
 * loads on first use, for the same reason the Worker's server graphs do (see
 * worker-entry.ts).
 */
export class DurableJobWorkflow extends WorkflowEntrypoint<Env, Job> {
  run(event: Readonly<WorkflowEvent<Job>>, step: WorkflowStep): Promise<unknown> {
    return withLogContext({ job: event.payload.kind, jobInstanceId: event.instanceId }, async () => {
      const { runJob } = await import("./run-job.server");
      try {
        return await runJob(jobStepOf(step), this.env, event.payload);
      } catch (error) {
        // Its steps have used up their retries: the job has failed for good.
        logError(`[jobs] ${event.payload.kind} failed`, error);
        throw error;
      }
    });
  }
}

/**
 * How far ahead a wait whose time has passed is moved. A Workflow refuses to
 * sleep until a past time and fails the job for good; a job started or
 * resumed late would otherwise never run.
 */
const LATE_SLEEP_MS = 1_000;

export function jobStepOf(step: WorkflowStep): JobStep {
  // Job steps return plain data, which is what a Workflow step may keep.
  const workflowStep = step as unknown as {
    do(name: string, ...rest: unknown[]): Promise<unknown>;
  };
  return {
    do: (name: string, ...rest: unknown[]) => workflowStep.do(name, ...rest),
    sleepUntil: (name, at) => step.sleepUntil(name, Math.max(new Date(at).getTime(), Date.now() + LATE_SLEEP_MS)),
  } as JobStep;
}
