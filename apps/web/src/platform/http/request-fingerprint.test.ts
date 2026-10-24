import { describe, expect, it } from "vitest";

import {
  canonicalSecondPrecisionInstant,
  requestFingerprint,
} from "./request-fingerprint";

describe("requestFingerprint", () => {
  it("is stable across object key order but preserves array order", async () => {
    await expect(requestFingerprint({ b: 2, a: { y: 2, x: 1 } })).resolves.toBe(
      await requestFingerprint({ a: { x: 1, y: 2 }, b: 2 }),
    );
    await expect(requestFingerprint({ values: [1, 2] })).resolves.not.toBe(
      await requestFingerprint({ values: [2, 1] }),
    );
  });

  it("canonicalizes valid instants to database precision without hiding invalid input", () => {
    expect(canonicalSecondPrecisionInstant("2026-07-16T09:00:00.500Z"))
      .toBe("2026-07-16T09:00:00.000Z");
    expect(canonicalSecondPrecisionInstant("not-a-date")).toBe("not-a-date");
  });

  it("fingerprints Dates by value and rejects unsupported object instances", async () => {
    await expect(requestFingerprint({ at: new Date("2026-08-22T00:00:00Z") }))
      .resolves.toBe(await requestFingerprint({ at: "2026-08-22T00:00:00.000Z" }));
    await expect(requestFingerprint({ value: new Map([["a", 1]]) }))
      .rejects.toThrow("JSON-compatible objects");
  });
});
