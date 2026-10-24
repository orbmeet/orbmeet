import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAmbiguousPageAddError,
  isRecoverablePageAddError,
  normalizePageAddTarget,
  withPageAddTimeout,
} from "./use-whiteboard-page-add-requests";

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizePageAddTarget", () => {
  it("normalizes valid insert targets", () => {
    expect(normalizePageAddTarget({ afterPageNumber: 2.8 })).toEqual({
      afterPageNumber: 2,
    });
    // Zero is a real position — insert *before page 1* — and the
    // authoritative side has always accepted it. This used to clamp to 1, so
    // the top of the document was the one place the client could not ask for
    // a page, which is why the rail had no control for it either.
    expect(normalizePageAddTarget({ afterPageNumber: 0 })).toEqual({
      afterPageNumber: 0,
    });
    // Still floored: a negative is not a position.
    expect(normalizePageAddTarget({ afterPageNumber: -3 })).toEqual({
      afterPageNumber: 0,
    });
  });

  it("drops append and invalid insert targets", () => {
    expect(normalizePageAddTarget()).toBeUndefined();
    expect(normalizePageAddTarget({ afterPageNumber: Number.NaN })).toBeUndefined();
  });
});

describe("isRecoverablePageAddError", () => {
  it("recognizes stale room and permission races", () => {
    expect(isRecoverablePageAddError(new Error("Resource not found"))).toBe(true);
    expect(isRecoverablePageAddError("only connected meeting participants can add pages")).toBe(true);
    expect(isRecoverablePageAddError(new Error("unexpected response"))).toBe(false);
  });

  it("does not treat forbidden responses as locally recoverable", () => {
    expect(isRecoverablePageAddError(new Error("Forbidden"))).toBe(false);
    expect(isRecoverablePageAddError("Only whiteboard editors can add pages")).toBe(false);
  });

  // A timeout is the one failure where the server transaction most likely did
  // commit. Adding the page locally too would sync a second frame in and leave
  // the user with a duplicate page.
  it("does not treat a timeout as proof the add was not applied", () => {
    const timeout = new Error("Whiteboard page add timed out after 12000ms");
    expect(isRecoverablePageAddError(timeout)).toBe(false);
    expect(isAmbiguousPageAddError(timeout)).toBe(true);
  });
});

describe("isAmbiguousPageAddError", () => {
  it("only classifies stalled requests as ambiguous", () => {
    expect(isAmbiguousPageAddError(new Error("Room not found"))).toBe(false);
    expect(isAmbiguousPageAddError(new Error("Forbidden"))).toBe(false);
  });
});

describe("withPageAddTimeout", () => {
  it("rejects stalled page-add requests", async () => {
    vi.useFakeTimers();

    const result = withPageAddTimeout(new Promise<unknown>(() => {}), 5);
    // oxlint-disable-next-line vitest/valid-expect -- The assertion promise is awaited after fake time advances.
    const assertion = expect(result).rejects.toThrow("Whiteboard page add timed out after 5ms");
    await vi.advanceTimersByTimeAsync(5);

    await assertion;
  });

  it("passes through settled page-add responses", async () => {
    await expect(withPageAddTimeout(Promise.resolve({ ok: true }), 5)).resolves.toEqual({
      ok: true,
    });
  });
});
