import { afterEach, describe, expect, it, vi } from "vitest";

import { createPageEditBatcher } from "./page-edit-batcher";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPageEditBatcher", () => {
  it("coalesces and deduplicates page ids until the trailing delay", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createPageEditBatcher(flush, 500);

    batcher.schedule(["page:one"]);
    vi.advanceTimersByTime(300);
    batcher.schedule(["page:one", "page:two"]);
    vi.advanceTimersByTime(499);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledExactlyOnceWith(["page:one", "page:two"]);
  });

  it("flushes a pending gesture exactly once when disposed", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createPageEditBatcher(flush, 500);

    batcher.schedule(["page:one"]);
    batcher.dispose();
    batcher.dispose();
    vi.runAllTimers();

    expect(flush).toHaveBeenCalledExactlyOnceWith(["page:one"]);
  });
});
