export interface SettledTask<T> {
  /** Human-readable name surfaced in the thrown error and in `onError`. */
  label: string;
  promise: Promise<T>;
}

export interface SequentialTask<T> {
  label: string;
  run: () => Promise<T>;
}

/**
 * Run every task to completion (like `Promise.allSettled`), then throw a single
 * `AggregateError` if any rejected. Used for batches of independent, idempotent
 * work — e.g. cron reconcilers — where one failure must not stop the others,
 * but the overall run should still surface as failed for observability.
 *
 * The thrown `AggregateError.errors` holds the original rejection reasons, and
 * its message names the failing tasks by label. `onError`, when provided,
 * fires once per failed task before throwing so callers get a structured log
 * line that identifies which task failed.
 */
export async function settleAllOrThrow<T>(
  message: string,
  tasks: readonly SettledTask<T>[],
  { onError }: { onError?: (error: unknown, task: SettledTask<T>, index: number) => void } = {},
): Promise<T[]> {
  const results = await Promise.allSettled(tasks.map((task) => task.promise));
  const values: T[] = [];
  const failures: Array<{ task: SettledTask<T>; index: number; reason: unknown }> = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      values.push(result.value);
      return;
    }
    failures.push({ task: tasks[index], index, reason: result.reason });
  });

  if (failures.length === 0) return values;

  failures.forEach(({ reason, task, index }) => onError?.(reason, task, index));

  throw new AggregateError(
    failures.map(({ reason }) => reason),
    `${message}: ${failures.map(({ task }) => task.label).join(", ")}`,
  );
}

/** Run independent tasks serially while retaining aggregate error reporting. */
export async function settleSequentiallyOrThrow<T>(
  message: string,
  tasks: readonly SequentialTask<T>[],
): Promise<T[]> {
  const values: T[] = [];
  const failures: Array<{ label: string; reason: unknown }> = [];

  for (const task of tasks) {
    try {
      values.push(await task.run());
    } catch (reason) {
      failures.push({ label: task.label, reason });
    }
  }

  if (failures.length === 0) return values;

  throw new AggregateError(
    failures.map(({ reason }) => reason),
    `${message}: ${failures.map(({ label }) => label).join(", ")}`,
  );
}
