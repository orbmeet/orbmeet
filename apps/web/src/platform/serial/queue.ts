import { Errors } from "@/lib/app-errors";

/**
 * Runs work one piece at a time, in the order it was handed over. A piece
 * that fails does not stop the ones behind it. A piece with a `deadline` (ms
 * since the epoch) whose turn comes after it is refused (BUSY) unrun.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>, deadline: number | null = null): Promise<T> {
    const result = this.tail.then(() => {
      if (deadline !== null && Date.now() > deadline) throw Errors.BUSY();
      return work();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
