export interface PageEditBatcher {
  schedule(pageIds: Iterable<string>): void;
  flush(): void;
  dispose(): void;
}

/**
 * Coalesces the page markers produced by one editing gesture. Disposing the
 * editor is a flush boundary: the final gesture must be recorded even when the
 * canvas closes before the trailing delay expires.
 */
export function createPageEditBatcher(
  onFlush: (pageIds: string[]) => void,
  settleMs: number,
): PageEditBatcher {
  const pendingPageIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const drain = () => {
    if (pendingPageIds.size === 0) return;
    const pageIds = [...pendingPageIds];
    pendingPageIds.clear();
    onFlush(pageIds);
  };

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    drain();
  };

  return {
    schedule(pageIds) {
      if (disposed) return;
      for (const pageId of pageIds) pendingPageIds.add(pageId);
      if (pendingPageIds.size === 0) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        drain();
      }, settleMs);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
