/** Serializes browser media mutations without dropping later user intent. */
export class MediaOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }
}
