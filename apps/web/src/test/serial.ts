import { env as workerEnv } from "cloudflare:workers";
import { SerialQueue } from "@/platform/serial/queue";
import { scopeOf, type SerialResult, type SerialTask } from "@/app/serial/tasks";
import { serialDeadline } from "@/app/serial/deadline";
import { rpcResultOf, rpcValueOf } from "@/platform/runtime/rpc-result";

const queues = new Map<string, SerialQueue>();

/**
 * Stands in for `runSerially` in every D1 test (installed by d1-setup.ts):
 * each scope's tasks run in this isolate on a queue of their own, as the
 * SerialScope object runs them — against the test's D1 and whatever else the
 * caller's env carries. A failure crosses back as it does over RPC: an AppError
 * keeps its code, anything else arrives as INTERNAL_ERROR.
 */
export function runSeriallyInProcess<T extends SerialTask>(
  env: Partial<Env>,
  task: T,
  options: { callerWaits?: boolean } = {},
): Promise<SerialResult<T>> {
  const scope = scopeOf(task);
  const queue = queues.get(scope) ?? new SerialQueue();
  queues.set(scope, queue);
  return rpcResultOf("serial", () => queue.run(async () => {
    const { runSerialTask } = await import("@/app/serial/run-serial-task.server");
    return runSerialTask({ ...workerEnv, ...env }, task) as Promise<SerialResult<T>>;
  }, serialDeadline(options))).then(rpcValueOf);
}
