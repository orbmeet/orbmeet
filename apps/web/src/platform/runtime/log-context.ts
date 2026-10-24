import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What every log line written during one invocation carries: the request,
 * Cron Trigger, queue batch, job or meeting it belongs to, and who it acts for
 * once that is known. Never anything secret: a path is recorded only where
 * paths carry none (see worker-entry.ts).
 */
export type LogContext = {
  requestId?: string;
  rayId?: string;
  path?: string;
  userId?: string;
  meetingId?: string;
  cron?: string;
  queue?: string;
  /** A serial scope's task (app/serial/tasks.ts). */
  task?: string;
  job?: string;
  jobInstanceId?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

/** The context of the invocation running now, for the logger to read. */
export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `context` on every line it logs, including from work it leaves running. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** Add what became known partway through, such as the authenticated user. */
export function addLogContext(fields: LogContext): void {
  const context = storage.getStore();
  if (context) Object.assign(context, fields);
}
