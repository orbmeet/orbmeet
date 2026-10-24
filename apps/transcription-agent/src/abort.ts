/**
 * Cancellation helpers. Every wait in the agent takes the signal of the scope
 * that owns it, so cancelling a scope ends its waits at once instead of after
 * whatever they were waiting for.
 */

/** Wait `ms`, or less when `signal` aborts first. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Settle with `promise`, or reject with the signal's reason once it aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Settle with `promise`, or reject after `ms`. The work itself is not stopped:
 * callers whose work holds a resource release it where the work settles.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(message)), ms);
  return abortable(promise, deadline.signal).finally(() => clearTimeout(timer));
}

/** A controller that aborts when `parent` does, and can also abort on its own. */
export function childController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  child.signal.addEventListener("abort", () => parent.removeEventListener("abort", onAbort), { once: true });
  return child;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
