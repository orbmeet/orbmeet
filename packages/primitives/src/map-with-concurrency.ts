/**
 * Bounded-concurrency mapping.
 *
 * Sequential `for (const x of xs) await f(x)` loops are the default failure mode
 * for I/O fan-out: on Cloudflare Workers they burn wall-clock against the
 * request deadline, and on the whiteboard sync server they hold the event loop's
 * attention far longer than the work requires. Unbounded `Promise.all` trades
 * that for a burst that can exhaust connection pools or subrequest budgets.
 *
 * Results are returned in input order regardless of completion order, so callers
 * can index results against their input.
 *
 * On failure this settles every in-flight worker before rethrowing the first
 * rejection, and stops handing out new items. That is what makes a caller's
 * catch block able to clean up: `Promise.all` rejects on the first failure
 * while its siblings keep running, so cleanup would race workers that are
 * still mid-write — a copy that deletes the objects it has recorded could have
 * a straggler's PUT land immediately afterwards, orphaning it. Nothing is
 * cancelled (promises can't be), but when this function returns or throws, no
 * worker is still running.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(concurrency)) {
    throw new RangeError("Concurrency must be finite");
  }
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.trunc(concurrency), items.length));
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  // Boxed so the workers visibly share one cell rather than each closing over a
  // `let` the compiler would narrow away.
  const state: { failure?: { error: unknown } } = {};

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length && !state.failure) {
      const index = nextIndex++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        // First failure wins, matching Promise.all's rejection value.
        state.failure ??= { error };
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  if (state.failure) throw state.failure.error;
  return results;
}
