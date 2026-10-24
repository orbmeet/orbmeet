import { afterEach, describe, expect, it } from "vitest";
import { ImportReservation } from "./import-reservation.ts";
import { capacity, reservedRenderDirs } from "./pdf-import-jobs.ts";

const idle = {
  activeImports: 0,
  activeRenders: 0,
  reservedRenderSlots: 0,
  activeUploads: 0,
  reservedScratchBytes: 0,
};

function snapshot() {
  return {
    activeImports: capacity.activeImports,
    activeRenders: capacity.activeRenders,
    reservedRenderSlots: capacity.reservedRenderSlots,
    activeUploads: capacity.activeUploads,
    reservedScratchBytes: capacity.reservedScratchBytes,
  };
}

function admit(userId: string): ImportReservation {
  const reservation = ImportReservation.admit(userId);
  if (!(reservation instanceof ImportReservation)) throw new Error(`refused with ${reservation.status}`);
  return reservation;
}

const held: ImportReservation[] = [];

afterEach(() => {
  for (const reservation of held.splice(0)) reservation.release();
});

describe("ImportReservation", () => {
  it("returns every piece it holds, however far the import got", () => {
    for (const stage of ["uploading", "rendering", "rendered"] as const) {
      const reservation = admit("user-a");
      expect(reservedRenderDirs.has(reservation.id)).toBe(true);
      if (stage !== "uploading") reservation.startRendering();
      if (stage === "rendered") reservation.finishRendering();
      reservation.release();
      reservation.release();
      expect(snapshot()).toEqual(idle);
      expect(capacity.activeUploadsByUser.size).toBe(0);
      expect(capacity.activeImportsByUser.size).toBe(0);
      expect(reservedRenderDirs.has(reservation.id)).toBe(false);
    }
  });

  it("trades the upload slot for a render slot", () => {
    const reservation = admit("user-a");
    held.push(reservation);
    expect(capacity.activeUploads).toBe(1);
    expect(capacity.reservedRenderSlots).toBe(1);

    reservation.startRendering();
    expect(capacity.activeUploads).toBe(0);
    expect(capacity.reservedRenderSlots).toBe(0);
    expect(capacity.activeRenders).toBe(1);

    // Placing the rendered pages needs no render slot, but keeps the import's scratch.
    reservation.finishRendering();
    expect(capacity.activeRenders).toBe(0);
    expect(capacity.activeImportsByUser.get("user-a")).toBe(1);
    expect(capacity.reservedScratchBytes).toBeGreaterThan(0);
  });

  it("refuses an import the scratch disk cannot hold at its worst case", () => {
    // Each admission reserves the largest input plus the most output a render
    // may write, so the scratch budget binds before the render slots do.
    held.push(admit("user-1"), admit("user-2"));
    const refusal = ImportReservation.admit("user-3");
    expect(refusal).toEqual({
      status: 503,
      json: { error: "PDF render scratch storage is busy. Please try again shortly." },
    });

    held.pop()!.release();
    held.push(admit("user-3"));
  });
});
