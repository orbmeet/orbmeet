import { env as workerEnv } from "cloudflare:workers";
import type { Job, JobStep, JobStepConfig } from "@/platform/jobs/jobs";

/**
 * A Workflow's step, run on the spot: each step is retried as its config
 * says (without waiting), and sleeps return at once. `names` records every
 * step that ran, in order.
 */
export function immediateJobStep(): JobStep & { names: string[]; sleeps: Array<{ name: string; at: number }> } {
  const names: string[] = [];
  const sleeps: Array<{ name: string; at: number }> = [];
  async function run<T>(name: string, configOrRun: JobStepConfig | (() => Promise<T>), maybeRun?: () => Promise<T>) {
    const config = typeof configOrRun === "function" ? {} : configOrRun;
    const body = typeof configOrRun === "function" ? configOrRun : maybeRun!;
    names.push(name);
    const attempts = (config.retries?.limit ?? 0) + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await body();
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
    }
  }
  return {
    names,
    sleeps,
    do: run,
    sleepUntil: async (name, at) => {
      sleeps.push({ name, at: typeof at === "number" ? at : at.getTime() });
    },
  };
}

/**
 * `env` with a `JOBS` binding that runs each job to completion as it is
 * started, on immediate steps, and reports its output when asked. A job
 * started twice runs once, as a Workflow instance id would. Jobs read the
 * test's D1 unless `env` names another.
 */
export function withInlineJobs<E extends object>(env: E): E & { JOBS: Env["JOBS"]; started: Job[] } {
  const instances = new Map<string, { params: Job; output: unknown; error: Error | null }>();
  const started: Job[] = [];
  const withJobs = { DB: (workerEnv as Partial<Env>).DB, ...env, started } as unknown as E & { JOBS: Env["JOBS"]; started: Job[] };
  const run = async (id: string, params: Job) => {
    const { runJob } = await import("@/app/jobs/run-job.server");
    try {
      instances.set(id, { params, output: await runJob(immediateJobStep(), withJobs as unknown as Env, params), error: null });
    } catch (error) {
      instances.set(id, { params, output: undefined, error: error instanceof Error ? error : new Error(String(error)) });
    }
  };
  const handle = (id: string) => ({
    id,
    status: async () => {
      const instance = instances.get(id);
      if (!instance) throw new Error(`No job ${id}`);
      return instance.error
        ? { status: "errored" as const, error: { name: instance.error.name, message: instance.error.message } }
        : { status: "complete" as const, output: instance.output };
    },
    // Runs the job again from its first step, as a Workflow restart does.
    restart: async () => {
      const instance = instances.get(id);
      if (!instance) throw new Error(`No job ${id}`);
      started.push(instance.params);
      await run(id, instance.params);
    },
  });
  withJobs.JOBS = {
    create: async ({ id, params }: { id: string; params: Job }) => {
      if (instances.has(id)) throw new Error(`Job ${id} already exists`);
      started.push(params);
      await run(id, params);
      return handle(id);
    },
    get: async (id: string) => {
      if (!instances.has(id)) throw new Error(`No job ${id}`);
      return handle(id);
    },
  } as unknown as Env["JOBS"];
  return withJobs;
}
