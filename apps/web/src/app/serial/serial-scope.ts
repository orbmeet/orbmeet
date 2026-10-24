import { DurableObject } from "cloudflare:workers";
import { withLogContext } from "@/platform/runtime/log-context";
import { rpcResultOf, type RpcResult } from "@/platform/runtime/rpc-result";
import { SerialQueue } from "@/platform/serial/queue";
import type { SerialResults, SerialTask } from "./tasks";

/**
 * One scope's queue (see app/serial/tasks.ts). Tasks run one at a time
 * in arrival order, and a refused task does not stop the ones behind it. The
 * queue lives only in memory: a task an eviction or a deploy interrupts is not
 * resumed, so each task leaves its scope consistent wherever it stops. The
 * registry loads on first use, for the same reason the Worker's server graphs
 * do (see worker-entry.ts).
 */
export class SerialScope extends DurableObject<Env> {
  private readonly queue = new SerialQueue();

  /** `deadline` (ms since the epoch): when the caller stops waiting; null when nobody does. */
  run(task: SerialTask, deadline: number | null = null): Promise<RpcResult<SerialResults[SerialTask["kind"]]>> {
    return rpcResultOf("serial", () =>
      this.queue.run(() => withLogContext({ task: task.kind }, async () => {
        const { runSerialTask } = await import("./run-serial-task.server");
        return runSerialTask(this.env, task);
      }), deadline));
  }
}
