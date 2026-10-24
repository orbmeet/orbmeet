/**
 * Which run holds which of a board's slots, and what each run may still do.
 *
 * A slot is free, held by a run, or draining: its run has returned a result
 * but the supervisor in the container is still cleaning the slot, and the
 * slot is free again only when that supervisor exits. A slot is never freed
 * by a timer, because a timer cannot know the container is done with it; the
 * one way out of a stuck slot is replacing the container, which `reset` records.
 *
 * Run ids come from the caller. They name a run for the duration of a request
 * and for a cancel that may arrive before it; they never name anything in the
 * container, which only ever sees slot numbers.
 */

export type Admission =
  | { kind: "admitted"; slot: number; generation: number }
  | { kind: "busy" }
  | { kind: "cancelled" };

/** What a Stop has to reach: the supervisor of a run that has started one. */
export interface Stoppable {
  stop(): void;
}

interface ActiveRun {
  slot: number;
  cancelled: boolean;
  supervisor: Stoppable | null;
}

type SlotState = { kind: "free" } | { kind: "held"; runId: string } | { kind: "draining" };

/** Bounds memory against a caller cancelling ids that never run. */
const MAX_TOMBSTONES = 1_024;

export class RunTable {
  readonly #slots: SlotState[];
  readonly #runs = new Map<string, ActiveRun>();
  /** Cancels that arrived before their run: the run, when it comes, is already over. */
  readonly #tombstones = new Map<string, number>();
  readonly #tombstoneMs: number;
  readonly #now: () => number;
  /** Bumped by `reset`, so news from a replaced container changes nothing. */
  #generation = 0;

  constructor(slotCount: number, tombstoneMs: number, now: () => number = Date.now) {
    this.#slots = Array.from({ length: slotCount }, () => ({ kind: "free" }));
    this.#tombstoneMs = tombstoneMs;
    this.#now = now;
  }

  get generation(): number {
    return this.#generation;
  }

  admit(runId: string): Admission {
    this.#pruneTombstones();
    if (this.#tombstones.has(runId)) return { kind: "cancelled" };
    // An id already in flight is refused rather than treated as a retry: a
    // retry would let one caller start any number of runs under one entry.
    if (this.#runs.has(runId)) return { kind: "busy" };
    const slot = this.#slots.findIndex((state) => state.kind === "free");
    if (slot < 0) return { kind: "busy" };
    this.#slots[slot] = { kind: "held", runId };
    this.#runs.set(runId, { slot, cancelled: false, supervisor: null });
    return { kind: "admitted", slot, generation: this.#generation };
  }

  isCancelled(runId: string): boolean {
    return this.#runs.get(runId)?.cancelled ?? true;
  }

  /**
   * Records the supervisor a Stop must reach. False means the run was
   * cancelled before it got here, and the caller stops the supervisor itself.
   */
  attach(runId: string, supervisor: Stoppable): boolean {
    const run = this.#runs.get(runId);
    if (!run) return false;
    run.supervisor = supervisor;
    return !run.cancelled;
  }

  /**
   * Cancels a run. Returns the supervisor to stop, if it has one; a run that
   * has not reached the container yet stops at its next check. A run not seen
   * yet leaves a tombstone, so its late arrival ends as cancelled.
   */
  cancel(runId: string): { found: boolean; supervisor: Stoppable | null } {
    const run = this.#runs.get(runId);
    if (run) {
      run.cancelled = true;
      return { found: true, supervisor: run.supervisor };
    }
    this.#pruneTombstones();
    this.#tombstones.delete(runId);
    this.#tombstones.set(runId, this.#now() + this.#tombstoneMs);
    while (this.#tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
    return { found: false, supervisor: null };
  }

  /**
   * Ends a run. With `draining`, its slot stays taken until `release`: the
   * supervisor is still cleaning it.
   */
  finish(runId: string, generation: number, { draining }: { draining: boolean }): void {
    const run = this.#runs.get(runId);
    if (!run || generation !== this.#generation) return;
    this.#runs.delete(runId);
    this.#slots[run.slot] = draining ? { kind: "draining" } : { kind: "free" };
  }

  /** The supervisor for `slot` has exited: the slot is clean and free. */
  release(slot: number, generation: number): void {
    if (generation !== this.#generation) return;
    if (this.#slots[slot]?.kind === "draining") this.#slots[slot] = { kind: "free" };
  }

  /** The container was replaced: every slot is clean, and every run in it is gone. */
  reset(): void {
    this.#generation += 1;
    this.#runs.clear();
    this.#slots.fill({ kind: "free" });
  }

  /** For tests and logs: the state of each slot. */
  get slots(): readonly ("free" | "held" | "draining")[] {
    return this.#slots.map((state) => state.kind);
  }

  #pruneTombstones(): void {
    const now = this.#now();
    for (const [runId, expires] of this.#tombstones) {
      if (expires <= now) this.#tombstones.delete(runId);
    }
  }
}
