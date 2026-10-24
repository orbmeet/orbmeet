/**
 * How long a task run for someone waiting on its answer (a request) may wait
 * its turn; inside what a browser or a CLI waits for a reply.
 */
const CALLER_PATIENCE_MS = 20_000;

/** When a task's caller stops waiting for it, or null when nobody waits. */
export function serialDeadline({ callerWaits = false }: { callerWaits?: boolean }): number | null {
  return callerWaits ? Date.now() + CALLER_PATIENCE_MS : null;
}
