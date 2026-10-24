import { describe, expect, it, vi } from "vitest";
import { RunTable } from "./run-table";

const TOMBSTONE_MS = 1_000;

function table(slots = 3) {
  let now = 0;
  const runs = new RunTable(slots, TOMBSTONE_MS, () => now);
  return { runs, advance: (ms: number) => void (now += ms) };
}

describe("RunTable", () => {
  it("admits runs into free slots up to the board's limit, then refuses", () => {
    const { runs } = table(2);
    expect(runs.admit("a")).toMatchObject({ kind: "admitted", slot: 0 });
    expect(runs.admit("b")).toMatchObject({ kind: "admitted", slot: 1 });
    expect(runs.admit("c")).toEqual({ kind: "busy" });
  });

  it("refuses an id that is already in flight", () => {
    const { runs } = table();
    runs.admit("a");
    expect(runs.admit("a")).toEqual({ kind: "busy" });
  });

  it("frees a slot at once when no supervisor was started", () => {
    const { runs } = table(1);
    const admitted = runs.admit("a");
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    runs.finish("a", admitted.generation, { draining: false });
    expect(runs.slots).toEqual(["free"]);
    expect(runs.admit("b")).toMatchObject({ kind: "admitted", slot: 0 });
  });

  it("holds a slot while its supervisor cleans up, and only until then", () => {
    const { runs, advance } = table(1);
    const admitted = runs.admit("a");
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    runs.finish("a", admitted.generation, { draining: true });

    // No amount of time frees it: only the supervisor's exit knows the slot is clean.
    advance(10 * TOMBSTONE_MS);
    expect(runs.admit("b")).toEqual({ kind: "busy" });

    runs.release(0, admitted.generation);
    expect(runs.admit("b")).toMatchObject({ kind: "admitted", slot: 0 });
  });

  it("cancels a run before its supervisor exists, and that run stops at its next check", () => {
    const { runs } = table();
    runs.admit("a");
    expect(runs.cancel("a")).toEqual({ found: true, supervisor: null });
    expect(runs.isCancelled("a")).toBe(true);
    // Arriving late, the supervisor is told to stop by its caller.
    expect(runs.attach("a", { stop: vi.fn() })).toBe(false);
  });

  it("hands back the supervisor a Stop has to reach", () => {
    const { runs } = table();
    runs.admit("a");
    const supervisor = { stop: vi.fn() };
    expect(runs.attach("a", supervisor)).toBe(true);
    expect(runs.cancel("a").supervisor).toBe(supervisor);
  });

  it("ends a run whose cancel arrived first as cancelled, until the tombstone expires", () => {
    const { runs, advance } = table();
    expect(runs.cancel("late")).toEqual({ found: false, supervisor: null });
    expect(runs.admit("late")).toEqual({ kind: "cancelled" });

    advance(TOMBSTONE_MS);
    expect(runs.admit("late")).toMatchObject({ kind: "admitted" });
  });

  it("bounds the tombstones a caller can leave", () => {
    const { runs } = table();
    for (let i = 0; i <= 1_024; i += 1) runs.cancel(`id-${i}`);
    expect(runs.admit("id-0")).toMatchObject({ kind: "admitted" });
    expect(runs.admit("id-1024")).toEqual({ kind: "cancelled" });
  });

  it("treats a run it does not know as cancelled", () => {
    expect(table().runs.isCancelled("nobody")).toBe(true);
  });

  it("forgets every run and slot when the container is replaced, and ignores news from the old one", () => {
    const { runs } = table(1);
    const first = runs.admit("a");
    if (first.kind !== "admitted") throw new Error("not admitted");
    runs.finish("a", first.generation, { draining: true });

    runs.reset();
    expect(runs.slots).toEqual(["free"]);
    const second = runs.admit("b");
    if (second.kind !== "admitted") throw new Error("not admitted");
    expect(second.generation).not.toBe(first.generation);

    // The old supervisor's exit, and the old run's finish, arrive late.
    runs.release(0, first.generation);
    runs.finish("a", first.generation, { draining: false });
    expect(runs.slots).toEqual(["held"]);
  });
});
