import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSingleWriterLock } from "./writer-lock.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-writer-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("single writer lock", () => {
  it("excludes a second writer while the first handle is alive", () => {
    const dir = makeTempDir();
    const lock = acquireSingleWriterLock(dir);

    expect(() =>
      acquireSingleWriterLock(dir)
    ).toThrow(/already owned/);

    lock.assertOwned();
    lock.release();
  });

  it("allows a replacement only after clean release", () => {
    const dir = makeTempDir();
    const first = acquireSingleWriterLock(dir);
    first.release();

    const replacement = acquireSingleWriterLock(dir);
    expect(() => replacement.assertOwned()).not.toThrow();
    replacement.release();
  });

  it("does not fire onLost on a clean release", () => {
    const dir = makeTempDir();
    const onLost = vi.fn();
    const lock = acquireSingleWriterLock(dir, { onLost });
    lock.release();

    expect(() => lock.assertOwned()).toThrow(/ownership was lost/);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("keeps separate data directories independent", () => {
    const first = acquireSingleWriterLock(makeTempDir());
    const second = acquireSingleWriterLock(makeTempDir());

    expect(() => first.assertOwned()).not.toThrow();
    expect(() => second.assertOwned()).not.toThrow();
    first.release();
    second.release();
  });
});
