import { rpcValueOf } from "@/platform/runtime/rpc-result";
import { serialDeadline } from "./deadline";
import { scopeOf, type SerialResult, type SerialTask } from "./tasks";

export type { SerialResult, SerialResults, SerialTask } from "./tasks";

/**
 * Run a task in its scope, after every task that scope already holds. A
 * refusal throws the AppError it is. A failure to reach the scope (a deploy
 * resetting it) is not retried here: the task may have started.
 *
 * With `callerWaits`, a task still queued once its caller has given up is
 * refused (BUSY) without running, so a backlog never grows with work nobody
 * will read the answer to. Work that must happen however late (a job step, a
 * webhook, a sweep) leaves it off.
 */
export async function runSerially<T extends SerialTask>(
  env: Pick<Env, "SERIAL_SCOPES">,
  task: T,
  { callerWaits = false }: { callerWaits?: boolean } = {},
): Promise<SerialResult<T>> {
  const scopes = env.SERIAL_SCOPES;
  const result = await scopes.get(scopes.idFromName(scopeOf(task))).run(task, serialDeadline({ callerWaits }));
  // The scope answers whatever this kind of task resolves.
  return rpcValueOf(result) as SerialResult<T>;
}
