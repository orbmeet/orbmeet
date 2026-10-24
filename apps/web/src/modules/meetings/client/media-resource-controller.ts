export interface MediaResourceState<T> {
  phase: "idle" | "acquiring" | "ready" | "failed";
  resource: T | null;
  error: unknown;
}

/** Owns acquisition generations and cleanup independently of React rendering. */
export class MediaResourceController<T> {
  private generation = 0;
  private state: MediaResourceState<T> = { phase: "idle", resource: null, error: null };
  private readonly listeners = new Set<() => void>();
  private releaseTail: Promise<void> = Promise.resolve();

  constructor(private readonly release: (resource: T) => void | Promise<void>, private readonly onCleanupError: (error: unknown) => void = () => {}) {}

  getSnapshot = (): MediaResourceState<T> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: MediaResourceState<T>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private dispose(resource: T): Promise<void> {
    const run = this.releaseTail.then(() => this.release(resource));
    this.releaseTail = run.catch(this.onCleanupError);
    return this.releaseTail;
  }

  /** Reversible for React's setup-cleanup-setup cycle; invalidates pending acquisitions too. */
  clear = (): void => {
    ++this.generation;
    const previous = this.state.resource;
    this.publish({ phase: "idle", resource: null, error: null });
    if (previous !== null) void this.dispose(previous);
  };

  async acquire(factory: () => Promise<T>): Promise<T | null> {
    this.clear();
    const generation = this.generation;
    this.publish({ phase: "acquiring", resource: null, error: null });
    // Release the currently owned hardware before asking for its replacement.
    await this.releaseTail;
    if (generation !== this.generation) return null;
    try {
      const resource = await factory();
      if (generation !== this.generation) {
        await this.dispose(resource);
        return null;
      }
      this.publish({ phase: "ready", resource, error: null });
      return resource;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.publish({ phase: "failed", resource: null, error });
      throw error;
    }
  }
}

/** Serializes processor operations while allowing recovery after a failed operation. */
export class MediaOperationQueue {
  private tail = Promise.resolve();
  run(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
