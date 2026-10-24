/**
 * Run abort-aware work with a deadline.
 *
 * A factory is required so the signal reaches the operation itself. Accepting
 * an already-running Promise would only time out the observer while allowing a
 * state-changing operation to complete unnoticed.
 */
export function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Timed out after ${ms}ms`));
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
  // Invoke factories in a promise turn so a synchronous throw follows the same
  // finally path as an asynchronous rejection and cannot strand the timer.
  const promise = Promise.resolve().then(() => factory(controller.signal));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
